import assert from "node:assert/strict";
import { test } from "node:test";
import { FixedClock } from "../clock.ts";
import { testContext } from "../../node/testing/context.ts";
import { MemoryChannel } from "../testing/fakes.ts";
import { localTimeOf } from "../time.ts";
import type { AgentContext } from "../types.ts";
import { materialise, materialiseAll, sweep, upsertAndMaterialise } from "./engine.ts";
import { createReminder } from "./create.ts";
import { parseReminderRequest } from "./request.ts";

const TZ = "Asia/Kolkata";
const at = (ctx: AgentContext, iso: string): AgentContext => ({ ...ctx, clock: new FixedClock(iso, TZ) });
const base = { title: "drink water", timed: true, category: "default", explicit: true, relative: true, id: "chat:1", sourceRef: "telegram:1" };

test("explicit default reminder: open, confidence 1, exactly one T-0 row", async () => {
  const ctx = testContext({ at: "2026-09-21T10:00:20Z" });
  const out = await createReminder(ctx, { ...base, dueAt: "2026-09-21T10:03:00.000Z" });
  assert.deepEqual(out, { id: "chat:1", dueAt: "2026-09-21T10:03:00.000Z", scheduled: 1, status: "open" });
  const d = (await ctx.store.getDeadline("chat:1"))!;
  assert.deepEqual([d.status, d.confidence, d.source, d.category, d.timed], ["open", 1, "chat", "default", true]);
  const rows = await ctx.store.listReminders("chat:1");
  assert.deepEqual(rows.map((x) => [x.kind, x.fireAt]), [["0", "2026-09-21T10:03:00.000Z"]]);
});

test("explicit reminder ignores quiet hours: 23:00 IST fires at 23:00 IST", async () => {
  const ctx = testContext({ at: "2026-09-21T16:00:00Z" }); // 21:30 IST
  await createReminder(ctx, { ...base, dueAt: "2026-09-21T17:30:00.000Z" }); // 23:00 IST, inside 22:00-08:00
  const rows = await ctx.store.listReminders("chat:1");
  assert.equal(rows.length, 1);
  assert.equal(localTimeOf(new Date(rows[0]!.fireAt), TZ), "23:00");
});

test("a due time within 59 seconds still schedules one reminder at the due instant", async () => {
  const ctx = testContext({ at: "2026-09-21T10:00:20Z" });
  const out = await createReminder(ctx, { ...base, dueAt: "2026-09-21T10:01:00.000Z" });
  assert.equal(out.scheduled, 1);
  assert.equal((await ctx.store.listReminders("chat:1"))[0]!.fireAt, "2026-09-21T10:01:00.000Z");
  const same = await createReminder(testContext({ at: "2026-09-21T10:00:00Z" }), { ...base, dueAt: "2026-09-21T10:00:00.000Z" });
  assert.equal(same.scheduled, 1); // due == now is not past
});

test("category with its own rule: rule offsets that are still ahead PLUS the due time", async () => {
  const ctx = testContext({ at: "2026-09-21T10:00:00Z" });
  const flight = { ...base, title: "flight", category: "flight" };
  const far = await createReminder(ctx, { ...flight, dueAt: "2026-09-23T10:00:00.000Z" }); // 48h out: 24h + 0
  assert.equal(far.scheduled, 2);
  const rows = await ctx.store.listReminders("chat:1");
  assert.deepEqual(rows.map((x) => [x.kind, x.fireAt]).sort(), [["0", "2026-09-23T10:00:00.000Z"], ["24h", "2026-09-22T10:00:00.000Z"]]);
  // 5h out: the 24h fire time is already past, so only T-0 is scheduled
  const ctx2 = testContext({ at: "2026-09-21T10:00:00Z" });
  const near = await createReminder(ctx2, { ...flight, dueAt: "2026-09-21T15:00:00.000Z" });
  assert.equal(near.scheduled, 1);
  assert.deepEqual((await ctx2.store.listReminders("chat:1")).map((x) => x.kind), ["0"]);
});

test("past explicit time is refused and stores nothing", async () => {
  const ctx = testContext({ at: "2026-09-21T10:00:20Z" });
  await assert.rejects(createReminder(ctx, { ...base, dueAt: "2026-09-21T09:59:00.000Z" }), RangeError);
  await assert.rejects(createReminder(ctx, { ...base, dueAt: "garbage" }), RangeError);
  assert.equal(await ctx.store.getDeadline("chat:1"), null);
});

test("non-explicit: proposed, confidence 0.9, NO reminder rows", async () => {
  const ctx = testContext({ at: "2026-09-21T10:00:20Z" });
  const out = await createReminder(ctx, { ...base, explicit: false, title: "flight", category: "flight", dueAt: "2026-09-22T12:30:00.000Z" });
  assert.deepEqual(out, { id: "chat:1", dueAt: "2026-09-22T12:30:00.000Z", scheduled: 0, status: "proposed" });
  const d = (await ctx.store.getDeadline("chat:1"))!;
  assert.deepEqual([d.status, d.confidence], ["proposed", 0.9]);
  assert.equal((await ctx.store.listReminders("chat:1")).length, 0);
  assert.equal(await materialiseAll(ctx), 0); // still none
});

test("retrying the same message is idempotent", async () => {
  const ctx = testContext({ at: "2026-09-21T10:00:20Z" });
  await createReminder(ctx, { ...base, dueAt: "2026-09-21T10:03:00.000Z" });
  await createReminder(ctx, { ...base, dueAt: "2026-09-21T10:03:00.000Z" });
  assert.equal((await ctx.store.listReminders("chat:1")).length, 1);
});

test("the every-minute cron cannot re-plan an explicit reminder (no quiet-hours shift, no early offsets)", async () => {
  const ctx = testContext({ at: "2026-09-21T16:00:00Z" }); // 21:30 IST
  await createReminder(ctx, { ...base, dueAt: "2026-09-21T17:30:00.000Z" }); // 23:00 IST
  await materialiseAll(ctx);
  await materialise(ctx, (await ctx.store.getDeadline("chat:1"))!);
  const rows = await ctx.store.listReminders("chat:1");
  assert.deepEqual(rows.map((x) => [x.kind, x.fireAt]), [["0", "2026-09-21T17:30:00.000Z"]]);
});

test("end to end: the user's message fires once, on time, as a friendly line", async () => {
  const ch = new MemoryChannel("telegram");
  const ctx = testContext({ at: "2026-09-21T10:00:20Z", channels: [ch] });
  const req = parseReminderRequest("Remind me after 2 mins to drink water", ctx.config.reminders.rules, TZ, ctx.clock.now(), 9)!;
  await createReminder(ctx, { ...req, id: "chat:9", sourceRef: "telegram:9" });
  assert.deepEqual(await sweep(at(ctx, "2026-09-21T10:02:00Z")), { sent: 0, channels: [] }); // too early
  assert.deepEqual(await sweep({ ...at(ctx, "2026-09-21T10:03:05Z"), channels: [ch] }), { sent: 1, channels: ["telegram"] });
  assert.equal(ch.sent[0], "⏰ drink water");
  assert.deepEqual(await sweep({ ...at(ctx, "2026-09-21T10:09:00Z"), channels: [ch] }), { sent: 0, channels: [] });
});

test("upsertAndMaterialise (source jobs, PLAN_V3 B.10): new rows get reminders now; unchanged rows cost no writes; closed stays closed", async () => {
  const ctx = testContext({ at: "2026-09-21T09:30:00Z" });
  const d = {
    id: "manual:x", source: "manual" as const, sourceRef: "Deadlines/manual/x.md", title: "pay rent",
    dueAt: "2026-09-21T10:00:00.000Z", status: "open" as const, confidence: 1, notePath: "p", timed: true,
  };
  assert.ok((await upsertAndMaterialise(ctx, [d])) > 0);
  const rows = await ctx.store.listReminders("manual:x");
  assert.ok(rows.some((r) => r.kind === "0" && r.fireAt === "2026-09-21T10:00:00.000Z"));
  assert.equal(await upsertAndMaterialise(ctx, [d]), 0); // unchanged: skipped
  await ctx.store.setDeadlineStatus("manual:x", "done");
  await upsertAndMaterialise(ctx, [{ ...d, dueAt: "2026-09-21T11:00:00.000Z" }]); // a re-poll moves the date
  assert.equal((await ctx.store.getDeadline("manual:x"))?.status, "done");
  assert.equal((await ctx.store.listReminders("manual:x")).filter((r) => r.sentAt === null).length, 0);
});
