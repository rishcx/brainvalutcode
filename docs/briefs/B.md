# Brief B — Gmail source, redaction, deadline extraction

You are building one package of a 4-package parallel build in
`/Users/rjangid/Desktop/opensource/Personal/brain-agent`. Read `docs/BUILD_SPEC.md`
sections 1–3 first. This brief is otherwise self-contained.

## Goal

Read-only Gmail metadata, aggressively redacted before it can ever reach an LLM, and
deadline extraction that is deterministic first and LLM-assisted only for the residue.

## Files you own (create/edit ONLY these)

```
src/core/sources/gmail.ts          src/core/deadlines/extract.ts
src/core/sources/redact.ts         src/core/deadlines/llmExtract.ts
src/core/jobs/gmail.ts             src/node/gmailAuth.ts
src/core/sources/gmail.test.ts     src/core/deadlines/extract.test.ts
```

Everything else is frozen. **If a type you need is missing, define it in your own file —
never edit `src/core/types.ts`.**

## Rules (non-negotiable)

- Gmail scope is **`gmail.readonly`** and requests use **`format=metadata` only**. Never
  request or store a message body, an attachment, or `format=full`/`raw`.
- **The only path from a Gmail message to an LLM prompt is `gmailToLlmPayload()`**, which
  returns exactly `{ subject, from, date, snippet }` with `redact()` applied to every
  field. No other function may hand Gmail text to a prompt.
- **Ordering is load-bearing**: deterministic date extraction runs on the **raw** subject
  *before* redaction, because `redact()` eats long digit runs (including dates). Extract
  first, redact second.
- Never write a secret to disk, to the vault, or to a log. The refresh token is *printed
  once* by the auth CLI for the user to store in their own `.env`; the tool never writes
  `.env` itself, and never reads one.
- `src/core/**` is web-standard only (`fetch`, `URL`, `TextEncoder`, `crypto.subtle`,
  `AbortSignal.timeout`). `node:*` only in `src/node/gmailAuth.ts` and `*.test.ts`.
- Erasable TS only: no `enum`, no parameter properties. `.ts` import extensions,
  `import type`. No new runtime dependencies (no `googleapis` — plain `fetch`).
- No network in tests. Never `new Date()` — use `ctx.clock.now()`.

## Contracts you import

```ts
import type { AgentContext, Deadline, GmailMessage, GmailPayload, JobSpec } from "../types.ts";
import { dueAtFromLocalDate, parseLooseDate } from "../time.ts";
import { deadlinePrompt, DEADLINE_SCHEMA } from "../brain/prompts.ts";
```

```ts
interface GmailMessage { id: string; threadId: string; subject: string; from: string;
  date: string; snippet: string; labelIds: string[]; internalDate: string }
interface GmailPayload { subject: string; from: string; date: string; snippet: string }
interface Deadline { id: string; source: "github"|"gmail"|"manual"|"chat"; sourceRef: string;
  title: string; dueAt: string; status: "open"|"done"|"dismissed"|"proposed"|"stale";
  confidence: number; notePath: string }
```

`ctx.config.gmail` gives `{ enabled, query, maxMessages }`.
`ctx.store.upsertDeadline(d)`, `ctx.store.kvGet/kvSet` are async.
`ctx.vault.listFiles(prefix)` and `ctx.vault.readFile(path)` read the vault.

## The canonical date rule

A date-only deadline is due at `ctx.config.reminders.dueHourLocal` (09:00) **local** time:

```ts
dueAt: dueAtFromLocalDate("2026-10-01", ctx.clock.tz, ctx.config.reminders.dueHourLocal)
```

Never construct a due instant any other way. `parseLooseDate(text)` returns the first
`YYYY-MM-DD`, `1 Oct 2026` or `Oct 1, 2026` in free text (ambiguous numerics like
`01/10/2026` deliberately return `null`).

## What to build

### `src/core/sources/redact.ts`

```ts
export function redact(text: string): string;
```

Replace with `[redacted]`:
- OTP / verification codes: a 4–10 digit run near the words code/otp/pin/verification/
  password/token, in either order (`code is 483920`, `483920 is your code`);
- any standalone digit run of 5 or more (covers account numbers, card fragments, long ids);
- things shaped like secrets: `sk-…`, `ghp_…`, bearer tokens, 20+ char base64/hex blobs;
- URLs carrying a query string with `token`/`code`/`key`/`auth` parameters (redact the
  value, keep the host so the message stays intelligible).

Be conservative about what survives, aggressive about what goes. Redaction is idempotent:
`redact(redact(x)) === redact(x)`. It must never throw, on any input, including empty.

### `src/core/sources/gmail.ts`

```ts
export function gmailAccessToken(ctx: AgentContext): Promise<string>;
export function fetchGmail(ctx: AgentContext): Promise<GmailMessage[]>;
export function gmailToLlmPayload(m: GmailMessage): GmailPayload;
```

- `gmailAccessToken`: POST `https://oauth2.googleapis.com/token` with
  `grant_type=refresh_token`, `client_id`, `client_secret`, `refresh_token`, all read from
  `ctx.env` (`GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`). Cache the
  access token in the store's kv with its expiry (`kvSet("gmail:token", JSON.stringify(...))`)
  and reuse it while valid. A missing env var throws a clear error naming the variable —
  never its value.
- `fetchGmail`: `GET /gmail/v1/users/me/messages?q=<config.query>&maxResults=<maxMessages>`
  then, per id, `GET /gmail/v1/users/me/messages/<id>?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`.
  Bound concurrency (5). Map headers case-insensitively. Tolerate a missing header
  (empty string). Returns `[]` when `config.gmail.enabled` is false — without any fetch.
- `gmailToLlmPayload`: exactly four keys, each `redact()`ed. Nothing else, ever.

### `src/core/deadlines/extract.ts`

```ts
export function extractFromManualNotes(ctx: AgentContext): Promise<Deadline[]>;
export function extractFromGmail(ms: GmailMessage[], ctx: AgentContext): { found: Deadline[]; residue: GmailMessage[] };
```

- **Manual notes**: read `Deadlines/manual/*.md` (human-owned — read only, never write
  there; the write allowlist will reject it). Parse the leading `---` frontmatter block for
  `due:` (a date or an ISO instant) and optional `title:`. Id: `manual:<path>`.
  `source: "manual"`, `status: "open"`, `confidence: 1`,
  `notePath` = the note's own path. A note without a parsable `due:` is skipped silently.
- **Gmail, deterministic**: run `parseLooseDate` on the **raw** subject and keep the hit
  only when the subject also contains a due-word within a reasonable window
  (`due`, `deadline`, `expires`, `expiry`, `last date`, `renew`, `payment`, `submit by`).
  Id: `gmail:<messageId>`. `source: "gmail"`, `status: "open"`, `confidence: 1`,
  `sourceRef`: `https://mail.google.com/mail/u/0/#inbox/<threadId>`,
  `notePath`: `Gmail/<YYYY-MM-DD>-<messageId>.md`. Messages with a due-word but no parsable
  date are the **residue**. Messages with neither are dropped, not residue.
- Titles are cleaned to one line and capped (~120 chars). Past dates are still extracted —
  staling is somebody else's job.

### `src/core/deadlines/llmExtract.ts`

```ts
export function extractWithLlm(ctx: AgentContext, residue: GmailMessage[]): Promise<Deadline[]>;
```

- **One** `ctx.brain.complete()` call per poll, for the whole batch. No `ctx.brain` → return
  `[]`. Empty residue → return `[]` **without** calling the brain.
- Input is `residue.map(gmailToLlmPayload)` (plus each message's `id`). Use `deadlinePrompt`
  and `DEADLINE_SCHEMA` from the **frozen** `src/core/brain/prompts.ts` — it exists now, it
  already fences untrusted data, and you must not build a prompt yourself:
  `const { system, prompt } = deadlinePrompt(items);`
  `ctx.brain.complete({ system, prompt, jsonSchema: DEADLINE_SCHEMA })`.
- Output: `status: "proposed"`, `confidence` clamped to `< 1` (cap at 0.9), id
  `gmail:llm:<messageId>`. A response that does not parse as the expected JSON yields `[]` —
  never a throw, never a partially-trusted deadline.
- Proposed deadlines must never fire a reminder until confirmed; you do not materialise
  reminders at all (that is package C).
- **Do not call `ctx.store.markStale` for gmail-sourced ids.** `markStale` retires `open`
  *and* `proposed` rows, so staling `gmail:` would silently kill an LLM-proposed deadline
  that is still waiting for the user's confirmation once its email ages out of the
  `newer_than:14d` query window. Staling is only safe for a source that re-reports its full
  current set every poll, which Gmail does not.

### `src/core/jobs/gmail.ts`

```ts
export const pollGmail: JobSpec; // name: "poll:gmail", schedule: { everyMinutes: 30 }
```

`fetchGmail` → `extractFromGmail` → `extractWithLlm(residue)` → `extractFromManualNotes` →
`upsertDeadline` for each → write a per-message note under `Gmail/` and re-render the
deadline views with `deadlineFiles(ctx)` from `src/core/jobs/github.ts` (exported for you).
Return a one-line summary like `msgs=12 found=3 proposed=1 manual=2 changed=4`.
When `config.gmail.enabled` is false, return `"disabled"` immediately.

### `src/node/gmailAuth.ts`

```ts
export function gmailAuthCli(): Promise<void>;
```

Loopback OAuth bootstrap for the Mac only: start a `node:http` server on `127.0.0.1`, print
the consent URL (scope `https://www.googleapis.com/auth/gmail.readonly`, `access_type=offline`,
`prompt=consent`, PKCE S256), receive the `code` on the loopback redirect, exchange it, then
**print the refresh token to stdout once** with an instruction to store it in the user's own
`.env` as `GMAIL_REFRESH_TOKEN`. Write nothing to disk. Shut the server down afterwards.
Verify the `state` parameter. This is invoked only by an explicit `npm run cli -- gmail:auth`.

## Tests you must write and pass

`src/core/sources/gmail.test.ts`:

1. `redact` kills `your code is 483920`, `OTP: 8391`, a 12-digit account number, `sk-live_…`,
   and a `?token=…` URL value while keeping the host. `redact(redact(x)) === redact(x)`.
   `redact("")` returns `""`.
2. `gmailToLlmPayload` returns **exactly** `["date","from","snippet","subject"]` as its
   sorted key list, and every value is redacted (assert a planted OTP is gone).
3. Every URL in `fakeFetch.calls` for a message fetch contains `format=metadata` and none
   contains `format=full` or `format=raw`.
4. `fetchGmail` with `gmail.enabled === false` makes zero fetch calls.
5. A missing `GMAIL_REFRESH_TOKEN` throws an error naming the variable and not its value.

`src/core/deadlines/extract.test.ts`:

6. **Ordering** — a subject `Renewal due 2026-10-01, code 483920` yields a deterministic
   deadline with `dueAt` = 09:00 Asia/Kolkata on 2026-10-01 (`2026-10-01T03:30:00.000Z`)
   and `confidence === 1`. This is the test that fails if you redact before extracting.
7. A subject with a due-word but no date becomes residue; a subject with neither is dropped.
8. Manual note frontmatter `due: 2026-11-05` produces `confidence: 1`, `status: "open"`,
   `source: "manual"`.
9. `extractWithLlm` with an empty residue makes **zero** brain calls; with residue it makes
   exactly **one**; its output is `status: "proposed"` with `confidence < 1`; a garbage LLM
   response yields `[]` and does not throw.

Use the frozen helpers: `testContext()` from `src/node/testing/context.ts` and `fakeFetch` /
`MemoryVault` from `src/core/testing/fakes.ts`. For the brain, pass a stub:
`testContext({ brain: { complete: async () => ({ text: "...", entry: "fake", model: "m", cached: false, ms: 1 }) } })`.

## Done when

`npm run typecheck` and `npm test` are both green, your suites pass offline, and no file
outside your list has been modified. Do not run any poll against the real Obsidian vault or
the real Gmail API.
