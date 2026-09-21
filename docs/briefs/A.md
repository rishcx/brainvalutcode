# Brief A — Brain fallback chain, Q&A, agy shim

You are building one package of a 4-package parallel build in
`/Users/rjangid/Desktop/opensource/Personal/brain-agent`. Read `docs/BUILD_SPEC.md`
sections 1–3 first. This brief is otherwise self-contained.

## Goal

One OpenAI-compatible LLM client that walks an ordered fallback chain from config, caches
responses, and never lets the personal local gateway be reached from an unattended
runtime. Plus deterministic vault retrieval feeding a single LLM call for `ask`.

## Files you own (create/edit ONLY these)

```
src/core/brain/openaiCompat.ts     src/core/qa/retrieve.ts
src/core/brain/chain.ts            src/core/qa/ask.ts
src/core/brain/deterministic.ts    src/node/agy-shim.ts
src/core/brain/cache.ts
src/core/brain/brain.test.ts       src/core/qa/qa.test.ts       src/node/agy-shim.test.ts
```

Everything else is frozen. **If a type you need is missing, define it in your own file —
never edit `src/core/types.ts`.**

## Rules (non-negotiable)

- `src/core/**` may use only web-standard APIs: `fetch`, `crypto.subtle`, `URL`,
  `TextEncoder`, `AbortSignal.timeout`, `Intl`. Node built-ins (`node:*`) are allowed only
  in `src/node/agy-shim.ts` and in `*.test.ts`.
- Erasable TS only: no `enum`, no parameter properties. `.ts` import extensions.
  `import type` for type-only imports. No new runtime dependencies.
- No network in tests — use `fakeFetch` from `src/core/testing/fakes.ts`.
- Never read `process.env` in core; use `ctx.env(name)`. Never log a key, a prompt
  containing user data, or a response body on the error path.
- Never call `new Date()`; use `ctx.clock.now()`.

## Contracts you import

```ts
import type { AgentContext, Brain, BrainEntry, BrainRequest, BrainResult, Fetcher, GmailPayload } from "../types.ts";
import { chainFor } from "../config.ts";
import { digestPrompt, qaPrompt } from "./prompts.ts";
import { sha256Hex } from "../crypto.ts";
```

Relevant shapes (already defined, do not redeclare):

```ts
interface BrainEntry { kind: "omniroute" | "openrouter" | "deterministic"; name: string;
  baseUrl?: string; keyEnv?: string; models: string[]; local: boolean }
interface BrainRequest { prompt: string; system?: string; maxTokens?: number;
  temperature?: number; jsonSchema?: unknown; cacheTtlMs?: number }
interface BrainResult { text: string; entry: string; model: string; cached: boolean; ms: number }
interface Brain { complete(req: BrainRequest): Promise<BrainResult> }
```

`ctx.config.brain` gives `{ entries, budgetMs (25000), cacheTtlMs (86400000) }`.
Cache storage is on the store:
`ctx.store.cacheGet(key, nowIso)`, `ctx.store.cacheSet(key, value, expiresAtIso)` — both async.

## What to build

### `src/core/brain/openaiCompat.ts`

```ts
export interface CompletionCall {
  baseUrl: string; apiKey: string; model: string; fetch: Fetcher;
  prompt: string; system?: string; maxTokens?: number; temperature?: number;
  jsonSchema?: unknown; signal?: AbortSignal;
}
export class LlmError extends Error { readonly status: number; readonly retryable: boolean; }
export function openAiCompat(call: CompletionCall): Promise<{ text: string; model: string }>;
```

POSTs `${baseUrl}/chat/completions` with `Authorization: Bearer <apiKey>`,
`content-type: application/json`, body `{ model, messages: [{role:"system"},{role:"user"}],
max_tokens?, temperature? }`. With `jsonSchema`, add
`response_format: { type: "json_schema", json_schema: { name: "out", schema, strict: true } }`.
Returns `choices[0].message.content` as text. Throw `LlmError` with `retryable = true` for
429/5xx/timeouts (`AbortError`/`TimeoutError`), `false` for other non-2xx. A 2xx whose body
is missing `choices[0].message.content` is a **non-retryable** `LlmError(502)`.

### `src/core/brain/cache.ts`

```ts
export function cacheKey(entryName: string, model: string, req: BrainRequest): Promise<string>;
```

`sha256Hex` over a canonical string that includes the prompt, system, model, entry name and
the json-schema (stringified). Prefix the digest with `llm:` when storing. TTL comes from
`req.cacheTtlMs ?? ctx.config.brain.cacheTtlMs`; `0` disables both read and write.

### `src/core/brain/deterministic.ts`

```ts
export class DeterministicBrain implements Brain { constructor(ctx: AgentContext); }
```

No network, never throws, always resolves with `entry: "deterministic"`, `model: "none"`,
`cached: false`. It returns the *facts it was handed*: `BrainRequest.prompt` carries a
FACTS block (see prompts.ts) — echo that block verbatim, trimmed, under a one-line header.
If there is no FACTS block, return the prompt's first 500 characters. This is the "degrade
gracefully" path; it must be useful, not empty.

### `src/core/brain/chain.ts`

```ts
export function createBrain(ctx: AgentContext, opts?: { allowLocalGateway?: boolean }): Brain;
```

- `allowLocalGateway` defaults to `ctx.runtime === "cli"`. Get the chain from
  `chainFor(ctx.config, { allowLocalGateway })` — **never filter entries yourself**.
- For each entry in order, for each `entry.models` in order:
  - skip the entry when `entry.keyEnv` is set and `ctx.env(entry.keyEnv)` is empty
    (record it as a skip reason, do not throw);
  - check the cache first; a hit returns immediately with `cached: true`;
  - call `openAiCompat` with `AbortSignal.timeout(remaining budget)`;
  - **retry once** on a retryable error (429/5xx/timeout); any other error moves to the
    next model, then the next entry — no retry;
  - on success, write the cache and return.
- Total wall budget `ctx.config.brain.budgetMs` across the whole chain; when it is
  exhausted, stop and fall through to `DeterministicBrain`.
- `kind: "deterministic"` entries are served by `DeterministicBrain`.
- `complete()` never rejects. `ms` is measured with `ctx.clock.now()`.

### Prompts (already written — import, do not create)

`src/core/brain/prompts.ts` is **frozen** and gives you `digestPrompt(facts)`,
`qaPrompt(question, context)`, `deadlinePrompt(items)`, `DEADLINE_SCHEMA` and `fence(data)`.
Each returns `{ system, prompt }` and already wraps untrusted data in a `<FACTS>` block with
the delimiter neutralised inside the data. Packages B and C import it too — never
reimplement prompt construction, and never build a prompt by string-concatenating user or
email text yourself.

### `src/core/qa/retrieve.ts`

```ts
export interface Retrieved { path: string; score: number; excerpt: string }
export function retrieve(ctx: AgentContext, question: string): Promise<Retrieved[]>;
```

Deterministic, no embeddings. `ctx.vault.listFiles()` → keep `.md` files → read the top
candidates → score by: path/title token overlap (weight 3), frontmatter field matches
(weight 2), body keyword frequency (weight 1), recency tiebreak by filename date if the
name parses as `YYYY-MM-DD`. Lowercase, split on non-word characters, drop stopwords and
tokens shorter than 3 characters. Return at most `ctx.config.qa.maxNotes`, excerpt around
the best-matching line, total excerpt budget `ctx.config.qa.maxChars`. Ties break by path
so the output is stable. Reading human notes is allowed and expected.

### `src/core/qa/ask.ts`

```ts
export interface AskResult { answer: string; sources: string[]; entry: string; cached: boolean; ms: number }
export function ask(ctx: AgentContext, question: string): Promise<AskResult>;
```

`retrieve` → build `qaPrompt` → **one** `ctx.brain.complete()` call (if `ctx.brain` is
undefined, construct one with `createBrain(ctx)`). `sources` are the retrieved paths.
When the answer came from `DeterministicBrain`, the answer is the retrieved excerpts as a
fact dump — still a useful answer, with `entry: "deterministic"`.

### `src/node/agy-shim.ts`

Optional, user-triggered only. A zero-dependency `node:http` server exposing
`POST /v1/chat/completions` (OpenAI-shaped request and response) and `GET /health`.
It shells out with `execFile` from `node:child_process`:
`agy -p <prompt> --output-format json [--json-schema <file>] --model <id>`.

- **`execFile` with an argument array — never a shell string, never string interpolation
  into a command.** No `shell: true`.
- A JSON schema is written to a temp file (`node:os` tmpdir), passed by path, and deleted.
- Malformed/unparseable agy output → HTTP **502** with `{"error":{"message":"..."}}`.
- Bind `127.0.0.1` only. Export `createShimServer(opts): http.Server` and only call
  `listen()` when the module is the entry point, so tests can drive it without a port.

## Tests you must write and pass

`src/core/brain/brain.test.ts`:

1. **retry policy** — one entry, `fakeFetch` route with `times: 1` returning 500 then a
   200: exactly 2 fetch calls, result text from the second.
2. **no retry on 4xx** — a 401 on entry 1 and a 200 on entry 2: entry 1 is called exactly
   once, the result's `entry` is the second entry's name.
3. **deterministic floor** — every HTTP entry failing still resolves, with
   `entry === "deterministic"` and non-empty text. `complete()` must not reject.
4. **cache** — two identical `complete()` calls: the second returns `cached: true` and adds
   **zero** entries to `fakeFetch.calls`. A different prompt misses.
5. **`cacheTtlMs: 0`** disables the cache (second call re-fetches).
6. **local-gateway guard** — `testContext({ runtime: "worker" })`: no call in
   `fakeFetch.calls` has a URL containing `localhost:20128`. Assert the same for
   `createBrain(ctx, { allowLocalGateway: false })` on a CLI context.
7. **budget** — `configPatch: { brain: { budgetMs: 1000 } }` with a hanging route resolves
   deterministically rather than hanging (keep the test under a second of real time).
8. **model ids from config only** — grep-style assertion: the entry/model used equals what
   the config listed; no hardcoded id appears in your source.

`src/core/qa/qa.test.ts`: retrieval ranks an obviously-relevant note above an irrelevant
one and is stable across runs; the excerpt budget is respected; `ask` with no working LLM
returns `entry: "deterministic"` with the sources listed.

`src/node/agy-shim.test.ts`: a fake `agy` (a temp executable script) returning valid JSON
yields a 200 OpenAI-shaped body; returning garbage yields 502. Use `testContext()` and
`fakeFetch` from the frozen helpers where applicable.

Use `testContext()` from `src/node/testing/context.ts`:
`testContext({ fetch: fakeFetch([...]), configPatch: { brain: { entries: [...] } }, env: (n) => n === "K" ? "key" : undefined })`.

## Done when

`npm run typecheck` and `npm test` are both green, your suites pass offline, and no file
outside your list has been modified.
