# Brief C — Reminder engine, channels, inbound commands, digest job

You are building one package of a 4-package parallel build in
`/Users/rjangid/Desktop/opensource/Personal/brain-agent`. Read `docs/BUILD_SPEC.md`
sections 1–3 first. This brief is otherwise self-contained.

## Goal

Turn deadlines into idempotent, quiet-hours-aware reminders; deliver them over Telegram and
WhatsApp as one batched message per channel; handle inbound commands; and narrate the daily
digest with the LLM when one is available.

## Files you own (create/edit ONLY these)

```
src/core/reminders/engine.ts       src/core/inbound/commands.ts
src/core/channels/telegram.ts      src/core/jobs/reminders.ts
src/core/channels/whatsapp.ts      src/core/jobs/digest.ts   (exists as a deterministic placeholder — replace its body)
src/core/channels/format.ts
src/core/reminders/reminders.test.ts   src/core/channels/channels.test.ts
src/core/inbound/inbound.test.ts
```

Everything else is frozen. **If a type you need is missing, define it in your own file —
never edit `src/core/types.ts`.**

## Rules (non-negotiable)

- `src/core/**` is web-standard only: `fetch`, `crypto.subtle`, `URL`, `TextEncoder`,
  `AbortSignal.timeout`, `Intl`. No `node:*` outside `*.test.ts`.
- Erasable TS only: no `enum`, no parameter properties. `.ts` import extensions,
  `import type`. No new runtime dependencies.
- No network in tests — use `fakeFetch` / `MemoryChannel` from `src/core/testing/fakes.ts`.
- Never `new Date()` — always `ctx.clock.now()`. Every test uses `FixedClock`.
- Secrets come from `ctx.env` only; never log a token, a webhook secret or a signature.
- **Sending is idempotent or it is broken.** A reminder row that has been sent must never
  be sent again, and a replayed webhook must never act twice.

## Contracts you import

```ts
import type { AgentContext, Channel, ChannelId, Command, Deadline, InboundHandler,
  InboundMessage, JobSpec, Reminder, WebhookAdapter } from "../types.ts";
import { dueAtFromLocalDate, isQuietHours, localDate, localDateOf, parseLooseDate,
  parseOffset, shiftOutOfQuietHours } from "../time.ts";
import { hmacSha256Hex, timingSafeEqualHex } from "../crypto.ts";
import { digestPrompt } from "../brain/prompts.ts";   // frozen, shared with A and B
```

Store methods you need (all async):

```ts
upsertReminder({ deadlineId, kind, fireAt })   // UNIQUE(deadline_id, kind); never resurrects a sent row
dueReminders(nowIso): Reminder[]               // unsent, fire_at <= now, oldest first
markRemindersSent(ids: number[], atIso)
deleteUnsentReminders(deadlineId)
listDeadlines({ status: ["open"] }), getDeadline(id), setDeadlineStatus(id, status)
markProcessed(id, atIso): boolean              // true only the first time — the idempotency gate
kvGet(key) / kvSet(key, value, atIso)
```

Config: `ctx.config.reminders = { offsets: ["7d","2d","24h","3h","0"],
quietHours: { start: "22:00", end: "08:00" }, dueHourLocal: 9 }`;
`ctx.config.channels.telegram = { enabled, allowedChatIds }`;
`ctx.config.channels.whatsapp = { enabled, allowedWaIds, templateName }`.

## What to build

### `src/core/reminders/engine.ts`

```ts
export function materialise(ctx: AgentContext, d: Deadline): Promise<number>;
export function materialiseAll(ctx: AgentContext): Promise<number>;
export function sweep(ctx: AgentContext): Promise<{ sent: number; channels: string[] }>;
```

- `materialise`: for each label in `config.reminders.offsets`, fire at
  `d.dueAt - parseOffset(label)`, then `shiftOutOfQuietHours(fire, ctx.clock.tz, quietHours)`.
  Write one row per label via `upsertReminder` with `kind = label`.
  - **Only `status: "open"` deadlines materialise.** `proposed` (LLM-extracted or
    chat-proposed, `confidence < 1`) must produce **no rows at all** until confirmed;
    `done`/`dismissed`/`stale` produce none and their unsent rows are deleted.
  - Skip offsets whose shifted fire time is already in the past **by more than the offset's
    own span** (do not spam a week of missed reminders when a deadline is first seen late);
    a T-0 whose instant has passed still fires once.
  - When a due date moves, `upsertReminder` updates `fire_at` in place; call
    `deleteUnsentReminders` first only when the deadline left `open`.
- `sweep`: `dueReminders(now)` → resolve each to its deadline → **dedupe by deadline id**
  (quiet-hours shifting can land T-3h and T-0 on the same instant; the message must list a
  deadline once) → drop rows whose deadline is no longer `open` → format **one** message
  with `formatReminderBatch` → send it once per enabled channel → `markRemindersSent` with
  every swept row id, including the deduped ones. A send failure on one channel must not
  prevent `markRemindersSent` for a channel that succeeded — but a total failure must leave
  the rows unsent so the next tick retries. No channels configured ⇒ a no-op returning
  `{ sent: 0, channels: [] }`.

### `src/core/channels/format.ts`

```ts
export function chunk(text: string, limit?: number): string[];          // default 4096
export function formatReminderBatch(ds: Deadline[], ctx: AgentContext): string;
export function formatStatus(ctx: AgentContext): Promise<string>;
```

`chunk` splits on paragraph, then line, then hard-cuts; never emits an empty chunk; never
splits a surrogate pair. `formatReminderBatch` groups overdue / today / upcoming using
**local calendar days** (`localDateOf`, not elapsed ms) and numbers the items `1.`, `2.`, …
so `done <n>` can refer to them — persist that numbering with
`kvSet("last:list", JSON.stringify(ids), now)` so the numbers survive to the next inbound
message. `formatStatus` renders open deadlines, the next reminder, and the last job status.

### `src/core/channels/telegram.ts`

```ts
export class TelegramChannel implements Channel { constructor(ctx: AgentContext) }  // id: "telegram"
export const telegramWebhook: WebhookAdapter;
```

`send` POSTs `https://api.telegram.org/bot<TELEGRAM_TOKEN>/sendMessage` with
`{ chat_id, text }` per chunk, in order, using `ctx.fetch` and `AbortSignal.timeout`.
`verify` requires the header `X-Telegram-Bot-Api-Secret-Token` to equal
`ctx.env("TELEGRAM_WEBHOOK_SECRET")`, compared with `timingSafeEqualHex`-style constant-time
logic (compare hex digests of both sides if the values are not hex).
`parse` maps `update.message` to `InboundMessage` (`id` = `update_id`, `from` = `chat.id`)
and **drops anything whose chat id is not in `allowedChatIds`**. It must never throw on junk.

### `src/core/channels/whatsapp.ts`

```ts
export class WhatsappChannel implements Channel { constructor(ctx: AgentContext) }  // id: "whatsapp"
export const whatsappWebhook: WebhookAdapter;
export function whatsappVerifyChallenge(url: URL, ctx: AgentContext): string | null;
```

- `whatsappVerifyChallenge`: the GET handshake — when `hub.mode === "subscribe"` and
  `hub.verify_token` equals `ctx.env("WHATSAPP_VERIFY_TOKEN")` (constant-time), return
  `hub.challenge`; otherwise `null`.
- `verify`: `X-Hub-Signature-256` is `sha256=<hex>`; recompute
  `hmacSha256Hex(ctx.env("WHATSAPP_APP_SECRET"), rawBody)` over the **raw body string you
  were handed** — never over a re-serialised object — and compare with
  `timingSafeEqualHex`. A missing/short/malformed header is a failure, not a throw.
- `parse`: walk `entry[].changes[].value.messages[]`, keep `type === "text"`, `id` =
  `wamid`, `from` = the WA id, and drop anything not in `allowedWaIds`.
- `send`: POST `https://graph.facebook.com/v21.0/<WHATSAPP_PHONE_ID>/messages`. Free-form
  text **only if** the last inbound from that WA id was under 24h ago (track it with
  `kvSet("wa:lastInbound:<id>", iso, now)` on every inbound); otherwise send the approved
  template named `config.channels.whatsapp.templateName`. Chunk at 4096.

### `src/core/inbound/commands.ts`

```ts
export function parseCommand(text: string, ctx: AgentContext): Command;
export const handleInbound: InboundHandler;   // (ctx, msg) => Promise<string | null>
```

`Command` is already defined as a union:
`{kind:"status"} | {kind:"ask",question} | {kind:"remind",title,dueAt} | {kind:"done",index} | {kind:"confirm",index} | {kind:"help"}`.

- `status` → `formatStatus`. `done <n>` / `confirm <n>` resolve `n` against the numbering
  stored in `kv("last:list")` and call `setDeadlineStatus` (`done`, or `open` for a confirm,
  which then materialises reminders). An `n` with no stored list is a friendly error, not a
  crash.
- `remind me to X on <date>` → `parseLooseDate` → `dueAtFromLocalDate(date, tz,
  config.reminders.dueHourLocal)` → a **`proposed`** deadline (`source: "chat"`,
  `confidence: 0.9`, id `chat:<msg.id>`) plus a reply asking for confirmation. It must fire
  no reminder until confirmed.
- Anything else → `ask` (package A) via `ctx.brain`; with no `ctx.brain`, reply with the
  deterministic status dump rather than an error.
- `handleInbound` **must** gate on `await ctx.store.markProcessed(msg.id, now)` and return
  `null` when it returns false. A replayed webhook does nothing and says nothing.

### Jobs

```ts
// src/core/jobs/reminders.ts
export const sweepReminders: JobSpec;  // name "sweep:reminders", schedule { everyMinutes: 15 }
// src/core/jobs/digest.ts  (replace the placeholder body)
export const digestDaily: JobSpec;     // name "digest:daily", schedule { dailyAtLocal: "08:00" }
```

`sweepReminders` = `materialiseAll` then `sweep`, returning `materialised=N sent=M channels=…`.
`digestDaily` keeps its current deterministic behaviour and adds narration: build the facts
with the existing `renderDigest(...)` (do not invent a second fact source), pass them to
`ctx.brain.complete()` via `digestPrompt`, and prepend the prose to the deterministic
sections. **With no `ctx.brain`, or when the result's `entry` is `"deterministic"`, write
exactly what it writes today** — the digest must never regress to empty or to an error.
Keep the frontmatter `model:` field truthful (the `BrainResult.entry` that answered).

## Tests you must write and pass

`src/core/reminders/reminders.test.ts` (all with `FixedClock`):

1. A `2026-10-01` open deadline materialises exactly `offsets.length` rows; **no** fire
   instant is after the due instant; the T-3h row lands at 08:00 local (quiet-hours shift).
2. A `proposed` deadline materialises **zero** rows; confirming it (`setDeadlineStatus` →
   `materialise`) then produces the full set.
3. Sweeping at a time when two offsets coincide sends a message listing the deadline
   **once**, and marks **both** rows sent.
4. Running the identical sweep twice sends nothing the second time (`MemoryChannel.sent`
   has length 1).
5. A deadline marked `done` between materialisation and sweep is not announced.

`src/core/channels/channels.test.ts`:

6. `chunk` turns a 5000-char message into 2 non-empty chunks, each ≤ 4096; a channel `send`
   of that message produces 2 fetch calls in order.
7. WhatsApp: a correct `X-Hub-Signature-256` over the raw body verifies; a wrong one, a
   missing header and a truncated one all fail without throwing; a signature computed over
   re-serialised JSON fails (proving the raw body is used).
8. Telegram: a wrong `X-Telegram-Bot-Api-Secret-Token` fails; a chat id outside
   `allowedChatIds` is dropped by `parse`.
9. WhatsApp free-form vs template: with a recorded inbound 1h ago the body is a text
   message; with one 30h ago it is the `deadline_reminder` template.

`src/core/inbound/inbound.test.ts`:

10. The same provider message id handled twice acts once and returns `null` the second time.
11. `remind me to file taxes on 1 Oct 2026` creates a `proposed` deadline with zero reminder
    rows; `confirm 1` flips it to `open` and materialises them.
12. `done 2` resolves against the stored numbering; `done 9` with a 3-item list replies with
    an error instead of throwing.

Use `testContext()` from `src/node/testing/context.ts` with
`channels: [new MemoryChannel("telegram")]`, `fakeFetch` for HTTP-level channel tests, and
`configPatch` to enable channels.

## Done when

`npm run typecheck` and `npm test` are both green, your suites pass offline, and no file
outside your list has been modified. Never send a real message to a real chat.
