# brain-agent — build spec (phase 2)

A personal "second brain" tracker. Node 24 runs TypeScript natively by type-stripping;
there are **zero runtime dependencies** and there will continue to be zero.

```
npm run typecheck   # tsc --noEmit, must stay green
npm test            # node --test 'src/**/*.test.ts', must stay green
npm run cli -- help
```

## 1. Architecture

```
                  ┌─────────────┐        ┌──────────────┐
   GitHub ──┐     │             │        │  Obsidian    │
   Gmail  ──┼────►│   jobs/*    ├───────►│  vault       │  (agent-owned folders only)
   chat   ──┘     │  (JobSpec)  │        └──────────────┘
                  │             ├───────►  Store  (sqlite on Mac / D1 in the Worker)
                  └──────┬──────┘
                         │
              Brain (fallback chain)          Channels (telegram / whatsapp)
       omniroute ► openrouter ► deterministic
```

Two runtimes, one codebase:

| | Mac CLI (`src/cli.ts`) | Cloudflare Worker (`src/worker.ts`) |
|---|---|---|
| store | `SqliteStore` (`node:sqlite`) | `D1Store` (D1 binding) |
| vault | `FsWriter` | `GitDataApiWriter` (GitHub Git Data API) |
| brain | full chain, **including** the local gateway | chain **without** the local gateway |
| trigger | attended commands + `cron` | one `*/15 * * * *` cron + webhooks |

### Hard rules (every package)

- **Core is portable.** Anything under `src/core/**` may use only web-standard APIs:
  `fetch`, `crypto.subtle`, `URL`, `TextEncoder`, `AbortSignal.timeout`, `Intl`.
  Node built-ins (`node:fs`, `node:sqlite`, `node:crypto`, `node:child_process`, …) are
  allowed **only** in `src/cli.ts`, `src/node/**` and `*.test.ts` files.
- **Erasable TypeScript only**: no `enum`, no parameter properties, no namespaces.
  Import with explicit `.ts` extensions. Use `import type` for type-only imports.
- **No new runtime dependencies.** Ever. Dev-only additions still need a very good reason.
- **Offline tests.** No test may touch the network. Use `fakeFetch` from
  `src/core/testing/fakes.ts`. Never run a poll job against the real Obsidian vault.
- **No secrets on disk.** Secrets come from `env` (an `EnvReader` on the context) and are
  never logged, never written to the vault, never put in `brain.config.json` — config
  holds only the *names* of env vars.
- **Never `git push`, never `git commit`, never create a remote.**
- The local gateway (`http://localhost:20128/v1`) holds the user's personal Antigravity
  quota. It must never be reached from the Worker or from an unattended cron. This is
  enforced mechanically by `chainFor(cfg, { allowLocalGateway })` — do not re-implement it.

### The canonical date rule

A date-only deadline (GitHub `due_on`, a manual note's `due:`, a date in a Gmail subject)
is due at **`config.reminders.dueHourLocal` (09:00) local time**, via
`dueAtFromLocalDate(date, tz, hour)`. Nothing may invent its own rule.
Why 09:00 and not end-of-day: at 23:59 the T-0 reminder lands inside quiet hours
(22:00–08:00) and would shift to 08:00 *the next morning* — after the deadline it
announces. At 09:00 every configured offset still fires before the due instant.
`src/core/time.test.ts` pins this.

## 2. Frozen contracts (architect-owned — no builder may edit these)

| File | What it gives you |
|---|---|
| `src/core/types.ts` | every shared type: `Store`, `Brain`, `Channel`, `AgentContext`, `JobSpec`, `Fetcher`, `WebhookAdapter`, D1/Worker ambient types |
| `src/core/time.ts` | all timezone maths: `localDate`, `localDateOf`, `dueAtFromLocalDate`, `parseOffset`, `isQuietHours`, `shiftOutOfQuietHours`, `parseLooseDate`, `nextLocalTimeAfter` |
| `src/core/crypto.ts` | `sha256Hex`, `hmacSha256Hex`, `timingSafeEqualHex` |
| `src/core/config.ts` | `parseConfig`, `chainFor`, `DEFAULT_BRAIN_ENTRIES` |
| `src/core/clock.ts` | `SystemClock`, `FixedClock` |
| `src/core/store/schema.sql` | the one schema, shared by SQLite and D1 |
| `src/node/store/sqlite.ts` | `SqliteStore` — the reference `Store` implementation |
| `src/core/brain/prompts.ts` (+ its `prompts.test.ts`) | `digestPrompt`, `qaPrompt`, `deadlinePrompt`, `DEADLINE_SCHEMA`, `fence()` — shared by A, B and C |
| `src/core/testing/fakes.ts` | `fakeFetch`, `MemoryVault`, `MemoryChannel`, `offlineFetch` |
| `src/node/testing/context.ts` | `testContext()` — a fully offline `AgentContext` |
| `src/core/vault/paths.ts`, `src/node/vault/fs.ts` | the write allowlist and the Mac vault writer |
| `src/core/render/*.ts`, `src/core/sources/github.ts` | existing renderers and the GitHub client |
| `src/core/jobs/github.ts`, `jobs/dispatch.ts` | `pollGithub`, the registry, `runDueJobs` |
| `src/cli.ts`, `brain.config.json`, `tsconfig.json`, `package.json` | entry point and config |

**If a type you need is not in `types.ts`, define it locally in your own file. Never edit
`types.ts`.** If you are convinced a *shared* contract is wrong, stop and report it
instead of changing it — four packages are compiled against it.

### `Store` is async

Every `Store` method returns a `Promise`, including `close()`. This is not optional
politeness: D1 has no synchronous API, and `D1Store` must satisfy the same interface as
`SqliteStore`. Always `await`.

### The context

```ts
interface AgentContext {
  store: Store; vault: VaultWriter; clock: Clock; fetch: Fetcher;
  config: Config; env: EnvReader; runtime: "cli" | "worker";
  brain?: Brain;          // absent until A is wired: degrade deterministically
  channels?: Channel[];   // absent until C is wired: a sweep with no channel is a no-op
  githubToken(): Promise<string>;
}
```

Never construct a client from module scope. Never read `process.env` in core — use
`ctx.env`. Never call `new Date()` for logic — use `ctx.clock.now()`.

## 3. Ownership partition — no file is owned twice

Each package may create and edit **only** the files listed under it. Shared files are
frozen. Test files are pre-assigned so the `src/**/*.test.ts` glob never collides.

### Package A — brain chain, Q&A, agy shim

```
src/core/brain/openaiCompat.ts     src/core/qa/retrieve.ts
src/core/brain/chain.ts            src/core/qa/ask.ts
src/core/brain/deterministic.ts    src/node/agy-shim.ts
src/core/brain/cache.ts
tests: src/core/brain/brain.test.ts, src/core/qa/qa.test.ts, src/node/agy-shim.test.ts
```

### Package B — Gmail, redaction, deadline extraction

```
src/core/sources/gmail.ts          src/core/deadlines/extract.ts
src/core/sources/redact.ts         src/core/deadlines/llmExtract.ts
src/core/jobs/gmail.ts             src/node/gmailAuth.ts
tests: src/core/sources/gmail.test.ts, src/core/deadlines/extract.test.ts
```

### Package C — reminders, channels, inbound, digest job

```
src/core/reminders/engine.ts       src/core/inbound/commands.ts
src/core/channels/telegram.ts      src/core/jobs/reminders.ts
src/core/channels/whatsapp.ts      src/core/jobs/digest.ts   (replaces the placeholder)
src/core/channels/format.ts
tests: src/core/reminders/reminders.test.ts, src/core/channels/channels.test.ts,
       src/core/inbound/inbound.test.ts
```

### Package D — Worker, D1, Git writer, ops

```
src/worker.ts                      wrangler.toml
src/core/store/d1.ts               migrations/0001_init.sql
src/core/vault/gitDataApi.ts       README.md, .env.example, docs/OPS.md
tests: src/worker.test.ts, src/core/store/d1.test.ts, src/core/vault/gitDataApi.test.ts
```

`src/core/brain/prompts.ts` is architect-owned precisely because A, B and C all import it:
if A owned it, B and C could not typecheck until A landed, which is the build-order
dependency this partition exists to prevent.

Cross-package imports are **type-only** until integration: D's worker accepts
`WorkerDeps { telegram?, whatsapp?, onInbound? }` and is tested with stubs, so it never
waits for C. A's `Brain` reaches jobs through `ctx.brain`, never by import.

## 4. Exact signatures each package must export

### A

```ts
// src/core/brain/openaiCompat.ts
export interface CompletionCall {
  baseUrl: string; apiKey: string; model: string; fetch: Fetcher;
  prompt: string; system?: string; maxTokens?: number; temperature?: number;
  jsonSchema?: unknown; signal?: AbortSignal;
}
export class LlmError extends Error { readonly status: number; readonly retryable: boolean }
export function openAiCompat(call: CompletionCall): Promise<{ text: string; model: string }>;

// src/core/brain/deterministic.ts
export class DeterministicBrain implements Brain {
  constructor(ctx: AgentContext);
  complete(req: BrainRequest): Promise<BrainResult>; // entry: "deterministic", never throws
}

// src/core/brain/cache.ts
export function cacheKey(entryName: string, model: string, req: BrainRequest): Promise<string>;

// src/core/brain/chain.ts
export function createBrain(ctx: AgentContext, opts?: { allowLocalGateway?: boolean }): Brain;

// src/core/qa/retrieve.ts
export interface Retrieved { path: string; score: number; excerpt: string }
export function retrieve(ctx: AgentContext, question: string): Promise<Retrieved[]>;

// src/core/qa/ask.ts
export interface AskResult { answer: string; sources: string[]; entry: string; cached: boolean; ms: number }
export function ask(ctx: AgentContext, question: string): Promise<AskResult>;
```

`createBrain` defaults `allowLocalGateway` to `ctx.runtime === "cli"`.

### B

```ts
// src/core/sources/redact.ts
export function redact(text: string): string;

// src/core/sources/gmail.ts
export function gmailAccessToken(ctx: AgentContext): Promise<string>;      // refresh-token flow
export function fetchGmail(ctx: AgentContext): Promise<GmailMessage[]>;    // format=metadata only
export function gmailToLlmPayload(m: GmailMessage): GmailPayload;          // the ONLY LLM path

// src/core/deadlines/extract.ts
export function extractFromManualNotes(ctx: AgentContext): Promise<Deadline[]>;
export function extractFromGmail(ms: GmailMessage[], ctx: AgentContext): {
  found: Deadline[]; residue: GmailMessage[];
};

// src/core/deadlines/llmExtract.ts
export function extractWithLlm(ctx: AgentContext, residue: GmailMessage[]): Promise<Deadline[]>;

// src/core/jobs/gmail.ts
export const pollGmail: JobSpec; // name "poll:gmail", schedule { everyMinutes: 30 }
```

### C

```ts
// src/core/reminders/engine.ts
export function materialise(ctx: AgentContext, d: Deadline): Promise<number>;   // rows written
export function materialiseAll(ctx: AgentContext): Promise<number>;
export function sweep(ctx: AgentContext): Promise<{ sent: number; channels: string[] }>;

// src/core/channels/format.ts
export function chunk(text: string, limit?: number): string[];                  // default 4096
export function formatReminderBatch(ds: Deadline[], ctx: AgentContext): string;
export function formatStatus(ctx: AgentContext): Promise<string>;

// src/core/channels/telegram.ts
export class TelegramChannel implements Channel { constructor(ctx: AgentContext) }
export const telegramWebhook: WebhookAdapter;

// src/core/channels/whatsapp.ts
export class WhatsappChannel implements Channel { constructor(ctx: AgentContext) }
export const whatsappWebhook: WebhookAdapter;
export function whatsappVerifyChallenge(url: URL, ctx: AgentContext): string | null; // GET echo

// src/core/inbound/commands.ts
export function parseCommand(text: string, ctx: AgentContext): Command;
export const handleInbound: InboundHandler;

// src/core/jobs/reminders.ts
export const sweepReminders: JobSpec;   // name "sweep:reminders", { everyMinutes: 15 }
// src/core/jobs/digest.ts
export const digestDaily: JobSpec;      // name "digest:daily", { dailyAtLocal: "08:00" }
```

### D

```ts
// src/core/store/d1.ts
export class D1Store implements Store { constructor(db: D1Database, clock: Clock) }

// src/core/vault/gitDataApi.ts
export interface GitWriterOpts { repo: string; branch: string; token: string; fetch: Fetcher }
export class GitDataApiWriter implements VaultWriter { constructor(o: GitWriterOpts) }

// src/worker.ts
export function createWorker(deps?: WorkerDeps): {
  fetch(req: Request, env: Record<string, unknown>, ectx: ExecutionContext): Promise<Response>;
  scheduled(c: ScheduledController, env: Record<string, unknown>, ectx: ExecutionContext): Promise<void>;
};
export default createWorker();
```

## 5. Integration step (after all four land — do NOT do this inside a package)

Exactly these edits, by the integrator, to architect-owned files:

1. `src/core/jobs/dispatch.ts`, the marked registry line:
   ```ts
   import { pollGmail } from "./gmail.ts";
   import { sweepReminders } from "./reminders.ts";
   const SPECS: JobSpec[] = [pollGithub, digestDaily, pollGmail, sweepReminders];
   ```
2. `src/cli.ts`, inside the `ctx` literal:
   ```ts
   const ctx: Ctx = { ...same fields..., brain: undefined, channels: [] };
   ctx.brain = createBrain(ctx);                       // A
   if (cfg.channels.telegram.enabled) ctx.channels!.push(new TelegramChannel(ctx));   // C
   if (cfg.channels.whatsapp.enabled) ctx.channels!.push(new WhatsappChannel(ctx));   // C
   ```
   (`createBrain` needs the finished context, so it is assigned after the literal.)
3. `src/cli.ts`, two new command branches:
   ```ts
   } else if (job === "ask") {
     const r = await ask(ctx, positionals.slice(1).join(" "));
     console.log(values.explain ? `${r.answer}\n\n— ${r.entry}${r.cached ? " (cached)" : ""} ${r.ms}ms\n  ${r.sources.join("\n  ")}` : r.answer);
   } else if (job === "gmail:auth") {
     await gmailAuthCli();                              // B, src/node/gmailAuth.ts
   }
   ```
   plus `explain: { type: "boolean", default: false }` in `parseArgs` options.
4. `src/worker.ts` default export:
   ```ts
   export default createWorker({ telegram: telegramWebhook, whatsapp: whatsappWebhook, onInbound: handleInbound });
   ```

Nothing else in an architect-owned file changes. If a package thinks it needs a fifth
edit, that is a design bug — report it.

## 6. Acceptance tests

Every package must leave `npm run typecheck` and `npm test` green, and must pass its own
suite offline:

| Package | Command | Expected observable |
|---|---|---|
| A | `node --test 'src/core/brain/*.test.ts' 'src/core/qa/*.test.ts'` | a `fakeFetch` returning 500 then 200 for the same entry produces one retry and a success; a 401 skips to the next entry **without** retrying; with every HTTP entry failing, `complete()` still resolves with `entry === "deterministic"`; a second identical `complete()` returns `cached: true` and makes **zero** new fetch calls; `createBrain(ctx)` with `runtime: "worker"` never calls a `localhost:20128` URL (assert over `fakeFetch.calls`); `ask()` with no working entry returns a deterministic fact dump and `entry === "deterministic"` |
| B | `node --test 'src/core/sources/gmail.test.ts' 'src/core/deadlines/*.test.ts'` | `redact("your code is 483920")` leaves no 6-digit run; `gmailToLlmPayload` output has **exactly** the keys `subject, from, date, snippet`; a subject containing `2026-10-01` still yields a deterministic deadline with `confidence === 1` **after** redaction exists (extraction runs on the raw subject); every Gmail URL requested contains `format=metadata`; LLM-extracted deadlines have `status === "proposed"` and `confidence < 1`; one poll makes at most one LLM call |
| C | `node --test 'src/core/reminders/*.test.ts' 'src/core/channels/*.test.ts' 'src/core/inbound/*.test.ts'` | with a `FixedClock`, a 2026-10-01 deadline materialises exactly `offsets.length` rows; none fires after the due instant; a sweep at T sends **one** message per channel listing all due items; running the same sweep twice sends nothing the second time; a 5000-char message is chunked into 2 sends; a WhatsApp POST with a wrong `X-Hub-Signature-256` is rejected; a repeated provider message id is processed once; `remind me to X on 1 Oct 2026` creates a `proposed` deadline that fires no reminder until confirmed |
| D | `node --test 'src/worker.test.ts' 'src/core/store/d1.test.ts' 'src/core/vault/gitDataApi.test.ts'` | `D1Store` passes the *same* assertions as `src/node/store/sqlite.test.ts` against a fake D1; `migrations/0001_init.sql` matches `src/core/store/schema.sql` (normalised whitespace) — **a test must assert this**; `GET /health` returns 200 JSON; an unknown path returns 404; `POST /wh/tg/<wrong-path>` returns 403 without invoking the handler; a webhook returns 200 **before** the work finishes (assert the promise went to `ctx.waitUntil`); `GitDataApiWriter` refuses a non-allowlisted path using the shared `assertWritable`, and retries once on a 422 ref update |

## 7. Known limitations (deliberate, do not "fix")

- GitHub per-repo issue counts are floored at 100 (one page); auto-picked repos come from
  page 1 of `/user/repos` sorted by push recency. Explicitly configured repos are fetched
  by name, so they are never lost to pagination.
- Vault read containment is prefix-based; a symlink planted inside the vault is treated as
  part of the vault.
- `parseLooseDate` deliberately refuses ambiguous numeric dates (`01/10/2026`).
