# Brief D — Cloudflare Worker, D1 store, Git Data API writer, ops

You are building one package of a 4-package parallel build in
`/Users/rjangid/Desktop/opensource/Personal/brain-agent`. Read `docs/BUILD_SPEC.md`
sections 1–3 first. This brief is otherwise self-contained.

## Goal

Run the same core in a Cloudflare Worker: D1 instead of SQLite, the GitHub Git Data API
instead of the filesystem, one 15-minute cron instead of a shell, plus the webhook ingress
and the operational docs.

## Files you own (create/edit ONLY these)

```
src/worker.ts                      wrangler.toml
src/core/store/d1.ts               migrations/0001_init.sql
src/core/vault/gitDataApi.ts       README.md, .env.example, docs/OPS.md
src/worker.test.ts   src/core/store/d1.test.ts   src/core/vault/gitDataApi.test.ts
```

Everything else is frozen. **If a type you need is missing, define it in your own file —
never edit `src/core/types.ts`.**

## Rules (non-negotiable)

- Everything you write runs in a Worker: **web-standard APIs only**. No `node:*` anywhere
  outside `*.test.ts` — not even `node:crypto`. Use `src/core/crypto.ts`.
- Erasable TS only: no `enum`, no parameter properties. `.ts` import extensions,
  `import type`. **No new runtime dependencies** — that includes
  `@cloudflare/workers-types`; the minimal `D1Database`, `D1PreparedStatement`,
  `ExecutionContext` and `ScheduledController` interfaces are already in
  `src/core/types.ts`.
- No network in tests, and no `wrangler` invocation in tests.
- Never log a secret, a token, a signature or a webhook path. Never `git push`, never
  `git commit`, never create a remote repo.
- `.env.example` contains **names and placeholder values only** — never a real secret. Do
  not read, create or print the user's real `.env`.
- The Worker must **never** use the local gateway brain entry. You get this for free from
  `chainFor(cfg, { allowLocalGateway: false })` / `ctx.runtime === "worker"` — do not
  hand-roll a filter, and do not pass `allowLocalGateway: true` anywhere.

## Contracts you import

```ts
import type { AgentContext, Clock, D1Database, D1PreparedStatement, ExecutionContext,
  Fetcher, JobRow, ScheduledController, Store, VaultFile, VaultWriter, WorkerDeps } from "./core/types.ts";
import { parseConfig } from "./core/config.ts";
import { SystemClock } from "./core/clock.ts";
import { runDueJobs } from "./core/jobs/dispatch.ts";
import { assertWritable } from "./core/vault/paths.ts";
```

Read `src/core/types.ts` for the full `Store` interface and `src/node/store/sqlite.ts` for
the reference implementation — **your `D1Store` must behave identically**, including:

- a human-set `done`/`dismissed` status surviving a re-poll (`ON CONFLICT ... DO UPDATE`
  with the `CASE` guard);
- `markStale` scoping by `substr(id, 1, ?) = ?` rather than `LIKE` (a repo name containing
  `_` would make `LIKE` over-match);
- `markProcessed` returning `true` only on the first insert;
- `ensureJob` never moving an existing `next_run_at`;
- every method returning a `Promise` — including `close()`, which is a no-op for D1.

## What to build

### `migrations/0001_init.sql`

A **verbatim copy** of `src/core/store/schema.sql`. One of your tests asserts the two files
match after whitespace normalisation — if they ever drift, the Mac and the Worker are
running different databases. `D1Store` must **not** run the schema itself; migrations own it.

### `src/core/store/d1.ts`

```ts
export class D1Store implements Store { constructor(db: D1Database, clock: Clock) }
```

`db.prepare(sql).bind(...).first() / .all() / .run()`. Timestamps come from the injected
clock, never from `Date.now()`. `.run()` reports affected rows as `meta.changes` — use it
for `markStale` and `markProcessed`. Use `db.batch()` where you would have used a
transaction. Variadic `IN (...)` lists need generated `?` placeholders; guard the empty
case exactly as `SqliteStore` does.

### `src/core/vault/gitDataApi.ts`

```ts
export interface GitWriterOpts { repo: string; branch: string; token: string; fetch: Fetcher }
export class GitDataApiWriter implements VaultWriter {
  constructor(o: GitWriterOpts);
  readFile(path: string): Promise<string | null>;
  listFiles(prefix?: string): Promise<string[]>;
  writeFiles(message: string, files: VaultFile[]): Promise<string[]>;
}
```

`writeFiles` does: read ref → read the base commit's tree → **skip files whose blob content
is unchanged** → create blobs → create a tree → create a commit → `PATCH /git/refs/heads/<branch>`
with `force: false`. On a **422** (the ref moved under you) re-read the ref and retry the
commit **once**, then give up with a clear error.

- `writeFiles` calls the shared `assertWritable(path)` for **every** path before any network
  call, and refuses the whole batch if any path fails. **Do not re-implement the allowlist**
  — import it from `src/core/vault/paths.ts`, exactly as `FsWriter` (`src/node/vault/fs.ts`) does.
- `readFile` returns `null` for a 404. `listFiles` reads the tree recursively and returns
  sorted vault-relative paths, excluding dot-directories.
- Send `User-Agent`, `Accept: application/vnd.github+json`,
  `X-GitHub-Api-Version: 2022-11-28`, and `AbortSignal.timeout`.
- Return the changed paths, like `FsWriter` does, and make an unchanged batch a no-op that
  creates **no commit**.

### `src/worker.ts`

```ts
export function createWorker(deps?: WorkerDeps): {
  fetch(req: Request, env: Record<string, unknown>, ectx: ExecutionContext): Promise<Response>;
  scheduled(c: ScheduledController, env: Record<string, unknown>, ectx: ExecutionContext): Promise<void>;
};
export default createWorker();
```

`WorkerDeps` is `{ telegram?: WebhookAdapter; whatsapp?: WebhookAdapter; onInbound?: InboundHandler }`,
supplied at integration by package C. **Build and test against stubs — never import C's
files.** An absent adapter means that route answers 503, not a crash.

Routes:

| Route | Behaviour |
|---|---|
| `GET /health` | 200 JSON: ok, tz, runtime, job rows from `store.listJobs()`. No secrets. |
| `GET /wh/whatsapp` | the `hub.challenge` echo when `hub.verify_token` matches (constant-time), else 403 |
| `POST /wh/whatsapp` | read the **raw body text once**, `deps.whatsapp.verify(req, raw, ctx)`; on failure 403 and stop. On success **return 200 immediately** and do the work in `ectx.waitUntil(...)` |
| `POST /wh/tg/<path>` | `<path>` must equal `env.TELEGRAM_WEBHOOK_PATH`, compared constant-time; then verify the `X-Telegram-Bot-Api-Secret-Token` header. Same ack-then-`waitUntil` shape |
| `POST /admin/run?job=<name>` | requires `Authorization: Bearer <env.ADMIN_TOKEN>` (constant-time); runs one job and returns its summary |
| anything else | 404 |

- Build the `AgentContext` per request: `runtime: "worker"`, `store: new D1Store(env.DB, clock)`,
  `vault: new GitDataApiWriter(...)`, `fetch: (u, i) => fetch(u, i)`,
  `env: (n) => typeof env[n] === "string" ? env[n] : undefined`,
  `config: parseConfig(JSON.parse(env.BRAIN_CONFIG ?? "{}"))`, `githubToken: async () => env.GITHUB_TOKEN`.
- `scheduled` calls `runDueJobs(ctx)` inside `ectx.waitUntil`. One cron drives every job; the
  `jobs` table decides what is actually due.
- A webhook must **never** block on the work. Ack first, always.

### `wrangler.toml`

`main = "src/worker.ts"`, `compatibility_date`, `nodejs_compat` **off**, a D1 binding named
`DB`, `[triggers] crons = ["*/15 * * * *"]`, and `[vars]` for the non-secret values
(`BRAIN_CONFIG`, `VAULT_REPO`, `VAULT_BRANCH`). Secrets (`GITHUB_TOKEN`, `ADMIN_TOKEN`,
`TELEGRAM_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_WEBHOOK_PATH`, `WHATSAPP_*`,
`OPENROUTER_KEY`, `GMAIL_*`) are `wrangler secret put` only — list them as comments, never
as values. **`OMNIROUTE_*` must not appear in `wrangler.toml` at all.**

### Docs

`README.md`: what the agent is, the two runtimes, setup on the Mac (`npm run cli -- help`,
`poll:github`, `cron`), and how to deploy. `.env.example`: every env var name with a
placeholder and a one-line comment. `docs/OPS.md`: first deploy, `wrangler d1 migrations
apply`, registering both webhooks, rotating a secret, reading `/health`, replaying a job
with `/admin/run`, and what to do when the cron silently stops (check `jobs.last_status`).

## Tests you must write and pass

`src/core/store/d1.test.ts` — write a **fake D1** over `node:sqlite` in the test file
(`DatabaseSync` wrapped in the `D1Database` shape; `node:*` is fine in tests) and run the
same assertions as `src/node/store/sqlite.test.ts`:

1. `done` survives a re-poll while `due_at` updates;
2. `markStale` respects its prefix, spares `done` rows, and does not over-match `a_b` vs `axb`;
3. reminders are unique per `(deadline_id, kind)` and a re-materialised sent row never fires again;
4. `markProcessed` returns `true` once and `false` after;
5. cache expiry is exclusive and `cachePurge` removes expired rows;
6. `ensureJob` does not move an existing schedule; `dueJobs` respects `next_run_at`.
7. **Schema parity**: `migrations/0001_init.sql` equals `src/core/store/schema.sql` after
   normalising whitespace. Read both with `node:fs` in the test.

`src/core/vault/gitDataApi.test.ts` (all with `fakeFetch`):

8. A non-allowlisted path (`Daily/x.md`) rejects the whole batch and makes **zero** fetch calls.
9. A happy path issues ref → tree → blob(s) → tree → commit → PATCH in order and returns the
   changed paths.
10. A 422 on the ref update triggers exactly one re-read and retry; a second 422 throws.
11. An unchanged file produces no blob creation and no commit.

`src/worker.test.ts` (stub `WorkerDeps`, fake D1, `fakeFetch`):

12. `GET /health` is 200 JSON and leaks no secret value; an unknown path is 404.
13. `POST /wh/tg/<wrong-path>` is 403 and the stub handler is never called; the right path
    with a wrong secret header is also 403.
14. A verified webhook returns 200 **before** the handler resolves — assert the work promise
    was handed to `ectx.waitUntil` (use a stub `ExecutionContext` that records promises, and
    a handler that resolves only when you let it).
15. `GET /wh/whatsapp` echoes `hub.challenge` on a matching verify token and 403s otherwise.
16. `POST /admin/run?job=poll:github` without the bearer token is 401/403 and runs nothing.
17. The Worker context never reaches the local gateway: assert no URL in `fakeFetch.calls`
    contains `localhost:20128`, and that `chainFor(ctx.config, { allowLocalGateway: false })`
    contains no `local` entry.

## Done when

`npm run typecheck` and `npm test` are both green, your suites pass offline, and no file
outside your list has been modified. Do not deploy, do not run `wrangler` against a real
account, and do not write to the real vault repo.
