import assert from "node:assert/strict";
import { test } from "node:test";
import { testContext } from "../../node/testing/context.ts";
import { MemoryChannel } from "../testing/fakes.ts";
import type { AgentContext, Deadline, Reminder, Store } from "../types.ts";
import type { Target } from "../agent/contract.ts";
import { addTask, replyTasks, resolveDoneIndex } from "../tasks/index.ts";
import { formatStatus } from "../channels/format.ts";
import { sweepReminders } from "../jobs/reminders.ts";
import { createReminder } from "./create.ts";
import { deliverDue, targetFor } from "./deliver.ts";
import { materialiseAll } from "./engine.ts";
import { reminderBatchText, reminderText } from "./message.ts";
import { snoozeReminder } from "./snooze.ts";

const PATCH = {
  channels: {
    telegram: { enabled: true, allowedChatIds: ["42"] },
    whatsapp: { enabled: true, allowedWaIds: ["919900000000"] },
    defaultChannel: "telegram",
  },
};

function setup(at: string) {
  const tg = new MemoryChannel("telegram");
  const wa = new MemoryChannel("whatsapp");
  const ctx = testContext({ at, configPatch: PATCH, channels: [tg, wa] });
  return { ctx, tg, wa };
}

/** Same store, later instant: FixedClock cannot advance, so build a sibling context. */
function at(store: Store, iso: string, channels: AgentContext["channels"]): AgentContext {
  return testContext({ at: iso, configPatch: PATCH, store, channels });
}

const explicit = (id: string, title: string, dueAt: string, origin: Target, sourceRef = `${origin.channel}:1`) => ({
  title, dueAt, timed: true, category: "default", explicit: true, relative: true, id, sourceRef, origin,
});

/* --------------------------------------------------------------------- targetFor */

test("targetFor: origin wins when reachable, else defaultChannel, else the first enabled channel, else null", () => {
  const cfg = testContext({ configPatch: PATCH }).config;
  const d = (over: Partial<Deadline> = {}): Deadline => ({
    id: "x", source: "chat", sourceRef: "y", title: "t", dueAt: "2026-09-21T09:00:00.000Z",
    status: "open", confidence: 1, notePath: "Deadlines/index.md", ...over,
  });
  assert.deepEqual(
    targetFor(d({ originChannel: "whatsapp", originPeer: "919900000000" }), cfg, ["telegram", "whatsapp"]),
    { channel: "whatsapp", peer: "919900000000" },
  );
  // origin channel not currently reachable -> default channel
  assert.deepEqual(targetFor(d({ originChannel: "whatsapp", originPeer: "919900000000" }), cfg, ["telegram"]), { channel: "telegram", peer: "42" });
  // origin peer no longer allowlisted -> default channel
  assert.deepEqual(targetFor(d({ originChannel: "whatsapp", originPeer: "000" }), cfg, ["telegram", "whatsapp"]), { channel: "telegram", peer: "42" });
  // non-chat (no origin) -> default channel
  assert.deepEqual(targetFor(d({ source: "github", originChannel: null, originPeer: null }), cfg, ["telegram", "whatsapp"]), { channel: "telegram", peer: "42" });
  // default channel unreachable -> first enabled channel
  assert.deepEqual(targetFor(d({ source: "github" }), cfg, ["whatsapp"]), { channel: "whatsapp", peer: "919900000000" });
  // nothing reachable
  assert.equal(targetFor(d({ source: "github" }), cfg, []), null);
});

/* -------------------------------------------------------------------- message.ts */

test("reminderText: empty/generic titles render as 'Reminder (no subject given)'", () => {
  const ctx = testContext({ at: "2026-09-21T09:00:00Z" });
  const d = (title: string): Deadline => ({
    id: "x", source: "chat", sourceRef: "y", title, dueAt: "2026-09-21T09:00:00.000Z",
    status: "open", confidence: 1, notePath: "p", timed: true,
  });
  const r: Reminder = { id: 1, deadlineId: "x", kind: "0", fireAt: "2026-09-21T09:00:00.000Z", sentAt: null, createdAt: "2026-09-21T08:55:00.000Z" };
  for (const title of ["", "Reminder", "default", "   "]) {
    assert.match(reminderText(d(title), r, ctx), /Reminder \(no subject given\)/);
  }
});

test("reminderText: T-0 chat text has the title, 'Due now', the local fire time and 'snooze'", () => {
  const ctx = testContext({ at: "2026-09-21T09:00:00Z" }); // 14:30 IST
  const d: Deadline = {
    id: "chat:1", source: "chat", sourceRef: "telegram:1", title: "call mom", dueAt: "2026-09-21T09:05:00.000Z",
    status: "open", confidence: 1, notePath: "p", timed: true,
  };
  const r: Reminder = { id: 1, deadlineId: "chat:1", kind: "0", fireAt: "2026-09-21T09:05:00.000Z", sentAt: null, createdAt: "2026-09-21T09:00:00.000Z" };
  const text = reminderText(d, r, ctx);
  assert.match(text, /call mom/);
  assert.match(text, /Due now \(14:35\)/);
  assert.match(text, /You set it at 14:30\./);
  assert.match(text, /snooze/);
});

test("reminderText: early offset wording, date-only deadline drops the time", () => {
  const ctx = testContext({ at: "2026-09-19T00:00:00Z" });
  const d: Deadline = {
    id: "x", source: "manual", sourceRef: "y", title: "Flight to BLR", dueAt: "2026-09-22T00:30:00.000Z",
    status: "open", confidence: 1, notePath: "p", timed: true,
  }; // 06:00 IST
  const r: Reminder = { id: 1, deadlineId: "x", kind: "24h", fireAt: "2026-09-21T00:30:00.000Z", sentAt: null, createdAt: "2026-09-19T00:00:00.000Z" };
  assert.match(
    reminderText(d, r, ctx),
    /^⏰ In 24 hours: Flight to BLR \([A-Za-z]{3,4} 22 Sept?, 06:00\)\nReply: done, snooze 10m, or snooze 1h$/,
  );
  const dateOnly = reminderText({ ...d, timed: false }, r, ctx);
  assert.match(dateOnly, /^⏰ In 24 hours: Flight to BLR \([A-Za-z]{3,4} 22 Sept?\)\n/);
});

test("reminderText: an early-offset row fired late is re-phrased from the real time left, never a false 'In 24 hours'", () => {
  const d: Deadline = {
    id: "x", source: "manual", sourceRef: "y", title: "Flight to BLR", dueAt: "2026-09-22T00:30:00.000Z",
    status: "open", confidence: 1, notePath: "p", timed: true,
  }; // 06:00 IST on 22 Sep
  const r: Reminder = { id: 1, deadlineId: "x", kind: "24h", fireAt: "2026-09-21T00:30:00.000Z", sentAt: null, createdAt: "2026-09-21T20:00:00.000Z" };
  // Discovered at 01:30 IST on the 22nd: 4.5 h left.
  assert.match(reminderText(d, r, testContext({ at: "2026-09-21T20:00:00Z" })), /^⏰ In 5 hours: Flight to BLR/);
  assert.match(reminderText(d, r, testContext({ at: "2026-09-22T00:10:00Z" })), /^⏰ In 20 minutes: Flight to BLR/);
  assert.match(reminderText(d, r, testContext({ at: "2026-09-22T00:30:30Z" })), /^⏰ Due now: Flight to BLR/);
  // Within the grace (a retry a few minutes after the slot): the offset label stands.
  assert.match(reminderText(d, r, testContext({ at: "2026-09-21T00:35:00Z" })), /^⏰ In 24 hours: Flight to BLR/);
  // Date-only: phrased by day.
  assert.match(reminderText({ ...d, timed: false }, r, testContext({ at: "2026-09-21T20:00:00Z" })), /^⏰ Due today: Flight to BLR/);
});

test("reminderText: non-chat T-0 has no reply line and shows owner/repo for a GitHub sourceRef", () => {
  const ctx = testContext({ at: "2026-09-21T09:00:00Z" });
  const d: Deadline = {
    id: "gh:1", source: "github", sourceRef: "https://github.com/me/app/milestone/1", title: "v2 milestone",
    dueAt: "2026-09-21T09:00:00.000Z", status: "open", confidence: 1, notePath: "p", timed: true,
  };
  const r: Reminder = { id: 1, deadlineId: "gh:1", kind: "0", fireAt: "2026-09-21T09:00:00.000Z", sentAt: null, createdAt: "2026-09-21T09:00:00.000Z" };
  assert.equal(reminderText(d, r, ctx), "⏰ Due now: v2 milestone (me/app)");
});

test("reminderBatchText: numbered list with a generic done/snooze reply line", () => {
  const ctx = testContext({ at: "2026-09-21T09:00:00Z" });
  const item = (id: string, title: string, fireAt: string): { d: Deadline; r: Reminder } => ({
    d: { id, source: "chat", sourceRef: "y", title, dueAt: fireAt, status: "open", confidence: 1, notePath: "p", timed: true },
    r: { id: 1, deadlineId: id, kind: "0", fireAt, sentAt: null, createdAt: fireAt },
  });
  const text = reminderBatchText(
    [item("a", "first", "2026-09-21T09:00:00.000Z"), item("b", "second", "2026-09-21T09:01:00.000Z")],
    ctx,
  );
  assert.equal(text, "⏰ 2 reminders\n• 1. first (due 14:30)\n• 2. second (due 14:31)\nReply 'done <n>' or 'snooze <n> <dur>'.");
});

/* --------------------------------------------------------------------- E12 / D1-D6 / S2 */

test("E12a: a WhatsApp-origin explicit reminder fires only on WhatsApp; auto-closes; persists per-peer state", async () => {
  const { ctx, tg, wa } = setup("2026-09-21T09:00:00Z"); // 14:30 IST
  await createReminder(ctx, explicit("chat:1", "call mom", "2026-09-21T09:05:00.000Z", { channel: "whatsapp", peer: "919900000000" }));
  const later = at(ctx.store, "2026-09-21T09:05:10Z", [tg, wa]);
  const r = await deliverDue(later);
  assert.deepEqual(r, { sent: 1, failed: 0, targets: ["whatsapp"] });
  assert.equal(tg.sentTo.length, 0);
  assert.equal(wa.sentTo.length, 1);
  assert.equal(wa.sentTo[0]!.peer, "919900000000");
  assert.match(wa.sentTo[0]!.text, /call mom/);
  assert.match(wa.sentTo[0]!.text, /Due now/);

  assert.equal((await later.store.getDeadline("chat:1"))!.status, "done"); // auto-close
  assert.deepEqual(JSON.parse((await later.store.kvGet("last:list:whatsapp:919900000000"))!), [{ k: "d", id: "chat:1" }]);
  assert.deepEqual(JSON.parse((await later.store.kvGet("last:reminder:whatsapp:919900000000"))!).ids, ["chat:1"]);
  const trace = await later.store.listTrace(1);
  assert.equal(trace[0]!.route, "reminder");
  assert.equal(trace[0]!.delivery, "ok");
  assert.equal(trace[0]!.channel, "whatsapp");
});

test("E12b/D3: a non-chat T-0 row delivers to the default channel only and never auto-closes", async () => {
  const { ctx, tg, wa } = setup("2026-09-21T09:00:00Z");
  const d: Deadline = {
    id: "gh:milestone:me/app:1", source: "github", sourceRef: "https://github.com/me/app/milestone/1",
    title: "v2 milestone", dueAt: "2026-09-21T09:00:00.000Z", status: "open", confidence: 1,
    notePath: "GitHub/repos/me__app.md", timed: true,
  };
  await ctx.store.upsertDeadline(d);
  await ctx.store.upsertReminder({ deadlineId: d.id, kind: "0", fireAt: d.dueAt });
  const later = at(ctx.store, "2026-09-21T09:00:10Z", [tg, wa]);
  const r = await deliverDue(later);
  assert.deepEqual(r, { sent: 1, failed: 0, targets: ["telegram"] });
  assert.equal(wa.sentTo.length, 0);
  assert.equal(tg.sentTo[0]!.text, "⏰ Due now: v2 milestone (me/app)");
  assert.equal((await later.store.getDeadline(d.id))!.status, "open");
});

test("D4: a WhatsApp send failure falls back to the default channel, trace delivery = fallback:telegram", async () => {
  const { ctx, tg } = setup("2026-09-21T09:00:00Z");
  const failingWa = {
    id: "whatsapp" as const,
    send: async () => { throw new Error("boom"); },
    sendTo: async () => { throw new Error("(#132001) template not approved"); },
  };
  await createReminder(ctx, explicit("chat:wa1", "pay rent", "2026-09-21T09:00:00.000Z", { channel: "whatsapp", peer: "919900000000" }));
  const later = at(ctx.store, "2026-09-21T09:00:10Z", [tg, failingWa]);
  const r = await deliverDue(later);
  assert.deepEqual(r, { sent: 1, failed: 0, targets: ["telegram"] });
  assert.equal(tg.sentTo.length, 1);
  assert.match(tg.sentTo[0]!.text, /pay rent/);
  const trace = await later.store.listTrace(1);
  assert.equal(trace[0]!.delivery, "fallback:telegram");
});

test("D5: two overlapping deliverDue calls on the same due row send exactly once", async () => {
  const { ctx, tg, wa } = setup("2026-09-21T09:00:00Z");
  await createReminder(ctx, explicit("chat:overlap", "standup", "2026-09-21T09:00:00.000Z", { channel: "telegram", peer: "42" }));
  const later = at(ctx.store, "2026-09-21T09:00:05Z", [tg, wa]);
  const [a, b] = await Promise.all([deliverDue(later), deliverDue(later)]);
  assert.equal(a.sent + b.sent, 1);
  assert.equal(tg.sentTo.length, 1);
});

test("D6: a failed send is retried next tick (attempts increments); the 3rd attempt gives up as sent", async () => {
  const { ctx } = setup("2026-09-21T09:00:00Z");
  let calls = 0;
  const alwaysFails = {
    id: "telegram" as const,
    send: async () => {},
    sendTo: async () => {
      calls++;
      throw new Error("down");
    },
  };
  await createReminder(ctx, explicit("chat:giveup", "water plants", "2026-09-21T09:00:00.000Z", { channel: "telegram", peer: "42" }));

  const t1 = at(ctx.store, "2026-09-21T09:00:05Z", [alwaysFails]);
  const r1 = await deliverDue(t1);
  assert.deepEqual(r1, { sent: 0, failed: 1, targets: ["telegram"] });
  let rows = await t1.store.listReminders("chat:giveup");
  assert.equal(rows[0]!.attempts, 1);
  assert.equal(rows[0]!.sentAt, null);

  const t2 = at(ctx.store, "2026-09-21T09:01:05Z", [alwaysFails]);
  await deliverDue(t2);
  rows = await t2.store.listReminders("chat:giveup");
  assert.equal(rows[0]!.attempts, 2);
  assert.equal(rows[0]!.sentAt, null);

  const t3 = at(ctx.store, "2026-09-21T09:02:05Z", [alwaysFails]);
  const r3 = await deliverDue(t3);
  assert.deepEqual(r3, { sent: 0, failed: 1, targets: ["telegram"] });
  rows = await t3.store.listReminders("chat:giveup");
  assert.ok(rows[0]!.sentAt !== null); // given up: finished as sent so it stops retrying
  const trace = await t3.store.listTrace(1);
  assert.equal(trace[0]!.delivery, "error:gave-up");
  assert.equal(calls, 3);
});

test("S2: a reminder due 09:35 IST is not sent before it, and fires on the tick at or after it", async () => {
  const { ctx, tg } = setup("2026-09-21T03:00:00Z"); // 08:30 IST: before the due instant
  await createReminder(ctx, explicit("chat:s2", "call", "2026-09-21T04:05:00.000Z", { channel: "telegram", peer: "42" })); // 09:35 IST
  const before = at(ctx.store, "2026-09-21T04:04:59Z", [tg]);
  assert.equal((await deliverDue(before)).sent, 0);
  const onTime = at(ctx.store, "2026-09-21T04:05:00Z", [tg]);
  assert.equal((await deliverDue(onTime)).sent, 1);
});

test("deliverDue with no channels is a no-op; the row is left untouched", async () => {
  const { ctx } = setup("2026-09-21T08:00:00Z");
  await createReminder(ctx, explicit("chat:nochan", "x", "2026-09-21T09:00:00.000Z", { channel: "telegram", peer: "42" }));
  const later = at(ctx.store, "2026-09-21T09:00:05Z", undefined);
  assert.deepEqual(await deliverDue(later), { sent: 0, failed: 0, targets: [] });
  const rows = await later.store.listReminders("chat:nochan");
  assert.equal(rows[0]!.sentAt, null);
  assert.equal(rows[0]!.claimedAt ?? null, null);
});

/* -------------------------------------------------------------------------- R17/R18 */

test("R17: two reminders due the same minute for one peer send as two separate messages; the latest wins the listing", async () => {
  const { ctx, tg } = setup("2026-09-21T08:00:00Z");
  await createReminder(ctx, explicit("chat:r17a", "first", "2026-09-21T09:00:00.000Z", { channel: "telegram", peer: "42" }));
  await createReminder(ctx, explicit("chat:r17b", "second", "2026-09-21T09:00:00.000Z", { channel: "telegram", peer: "42" }));
  const later = at(ctx.store, "2026-09-21T09:00:10Z", [tg]);
  const r = await deliverDue(later);
  assert.equal(r.sent, 2);
  assert.equal(tg.sentTo.length, 2);
  const list = JSON.parse((await later.store.kvGet("last:list:telegram:42"))!) as { id: string }[];
  assert.deepEqual(list, [{ k: "d", id: "chat:r17b" }]);
});

test("R18: five reminders due the same minute for one peer become one numbered batch; a numbered item resolves for snoozing", async () => {
  const { ctx, tg } = setup("2026-09-21T08:00:00Z");
  for (let i = 1; i <= 5; i++) {
    await createReminder(ctx, explicit(`chat:b${i}`, `task ${i}`, "2026-09-21T09:00:00.000Z", { channel: "telegram", peer: "42" }));
  }
  const later = at(ctx.store, "2026-09-21T09:00:10Z", [tg]);
  const r = await deliverDue(later);
  assert.equal(r.sent, 5);
  assert.equal(tg.sentTo.length, 1); // one batch message, not 5
  assert.match(tg.sentTo[0]!.text, /^⏰ 5 reminders/);
  for (let i = 1; i <= 5; i++) assert.match(tg.sentTo[0]!.text, new RegExp(`${i}\\. task ${i} \\(due`));
  const list = JSON.parse((await later.store.kvGet("last:list:telegram:42"))!) as { id: string }[];
  assert.deepEqual(list.map((x) => x.id), ["chat:b1", "chat:b2", "chat:b3", "chat:b4", "chat:b5"]);
  const s = await snoozeReminder(later, list[1]!.id, 10);
  assert.equal(s.ok, true);
});

/* --------------------------------------------------------------------------------- T10 */

test("T10: per-channel numbering — TG tasks, WA status, TG done 1 resolves against TG's own list", async () => {
  const { ctx } = setup("2026-09-21T09:00:00Z");
  const tg: Target = { channel: "telegram", peer: "42" };
  const wa: Target = { channel: "whatsapp", peer: "919900000000" };
  await addTask(ctx, { title: "buy milk" });
  await ctx.store.upsertDeadline({
    id: "d:wa", source: "manual", sourceRef: "x", title: "renew passport",
    dueAt: "2026-10-01T00:00:00.000Z", status: "open", confidence: 1, notePath: "Deadlines/index.md",
  });

  await replyTasks(ctx, tg); // TG's item 1 = buy milk
  await formatStatus(ctx, wa); // WA's item 1 = renew passport (a deadline)

  assert.deepEqual(await resolveDoneIndex(ctx, 1, tg), { kind: "reply", text: "Marked done: buy milk" });
});

/* ------------------------------------------------------------------------ tick cost */

test("minute tick cost: 20 open deadlines, nothing due -> sweep:reminders touches <= 3 store calls; re-materialise writes no rows", async () => {
  const { ctx, tg } = setup("2026-09-01T04:30:00Z");
  for (let i = 0; i < 20; i++) {
    await ctx.store.upsertDeadline({
      id: `manual:${i}`, source: "manual", sourceRef: "x", title: `task ${i}`,
      dueAt: "2026-10-15T03:30:00.000Z", status: "open", confidence: 1, notePath: "Deadlines/index.md",
    });
  }
  await materialiseAll(ctx); // far-future due date: nothing is due yet

  let calls = 0;
  const counting = new Proxy(ctx.store, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv) as unknown;
      if (typeof v !== "function") return v;
      return (...args: unknown[]) => {
        calls++;
        return (v as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as unknown as Store;
  const detail = await sweepReminders.run({ ...ctx, store: counting, channels: [tg] });
  assert.match(detail, /^sent=0 failed=0 targets=none$/);
  assert.ok(calls <= 3, `expected <= 3 store calls, got ${calls}`);

  let upserts = 0;
  const countingUpserts = new Proxy(ctx.store, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv) as unknown;
      if (prop !== "upsertReminder" || typeof v !== "function") return v;
      return (...args: unknown[]) => {
        upserts++;
        return (v as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as unknown as Store;
  await materialiseAll({ ...ctx, store: countingUpserts });
  assert.equal(upserts, 0);
});

test("reconcile stays cheap with many CLOSED deadlines (was: one write each, breaking the 50-subrequest limit at ~46)", async () => {
  const { testContext } = await import("../../node/testing/context.ts");
  const { materialiseAll } = await import("./engine.ts");
  const ctx = testContext({});
  for (let i = 0; i < 80; i++) {
    await ctx.store.upsertDeadline({ id: `old:${i}`, source: "manual", sourceRef: "x", title: `old ${i}`, dueAt: "2026-08-01T03:30:00.000Z", status: "done", confidence: 1, notePath: "Deadlines/index.md", category: "default", timed: false });
  }
  let writes = 0;
  const real = ctx.store.deleteUnsentReminders.bind(ctx.store);
  ctx.store.deleteUnsentReminders = async (id: string) => { writes++; return real(id); };
  await materialiseAll(ctx);
  assert.equal(writes, 0);
});
