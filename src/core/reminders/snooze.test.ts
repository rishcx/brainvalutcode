import assert from "node:assert/strict";
import { test } from "node:test";
import { testContext } from "../../node/testing/context.ts";
import { MemoryChannel } from "../testing/fakes.ts";
import type { Store } from "../types.ts";
import { createReminder } from "./create.ts";
import { deliverDue } from "./deliver.ts";
import { closeReminder, lastDelivered, parseSnoozeDuration, snoozeReminder } from "./snooze.ts";

const PATCH = {
  channels: {
    telegram: { enabled: true, allowedChatIds: ["42"] },
    whatsapp: { enabled: true, allowedWaIds: ["919900000000"] },
    defaultChannel: "telegram",
  },
};

function at(store: Store | undefined, iso: string, channels?: import("../types.ts").Channel[]) {
  return testContext({ at: iso, configPatch: PATCH, store, channels });
}

test("parseSnoozeDuration: minutes/hours/bare numbers, clamped 1..1440, garbage rejected", () => {
  assert.equal(parseSnoozeDuration("10m"), 10);
  assert.equal(parseSnoozeDuration("10 min"), 10);
  assert.equal(parseSnoozeDuration("1h"), 60);
  assert.equal(parseSnoozeDuration("2 hours"), 120);
  assert.equal(parseSnoozeDuration("90"), 90);
  assert.equal(parseSnoozeDuration("0"), null);
  assert.equal(parseSnoozeDuration("-5m"), null);
  assert.equal(parseSnoozeDuration("2000m"), null); // > 1440
  assert.equal(parseSnoozeDuration("soon"), null);
  assert.equal(parseSnoozeDuration(""), null);
});

/* -------------------------------------------------------------------------------- R15 */

test("R15: after a chat reminder fires and auto-closes, snoozeReminder reopens it and fires at +10 min", async () => {
  const tg = new MemoryChannel("telegram");
  const ctx = testContext({ at: "2026-09-21T09:00:00Z", configPatch: PATCH, channels: [tg] }); // 14:30 IST
  await createReminder(ctx, {
    title: "call mom", dueAt: "2026-09-21T09:05:00.000Z", timed: true, category: "default",
    explicit: true, relative: true, id: "chat:r15", sourceRef: "telegram:1", origin: { channel: "telegram", peer: "42" },
  });
  const fired = at(ctx.store, "2026-09-21T09:05:05Z", [tg]);
  assert.equal((await deliverDue(fired)).sent, 1);
  assert.equal((await fired.store.getDeadline("chat:r15"))!.status, "done");

  const s = await snoozeReminder(fired, "chat:r15", 10);
  assert.equal(s.ok, true);
  if (s.ok) {
    assert.equal(s.title, "call mom");
    assert.equal(s.fireAt, "2026-09-21T09:16:00.000Z"); // 09:05:05 + 10 min, ceiled to the minute
  }
  assert.equal((await fired.store.getDeadline("chat:r15"))!.status, "open"); // reopened

  const before = at(ctx.store, "2026-09-21T09:15:59Z", [tg]);
  assert.equal((await deliverDue(before)).sent, 0);
  const due = at(ctx.store, "2026-09-21T09:16:00Z", [tg]);
  const r = await deliverDue(due);
  assert.equal(r.sent, 1);
  assert.match(tg.sentTo.at(-1)!.text, /call mom/);
});

test("snoozeReminder: quiet hours are ignored; bad duration / missing deadline are refused", async () => {
  const ctx = testContext({ at: "2026-09-21T18:30:00Z" }); // 00:00 IST: deep in quiet hours
  await createReminder(ctx, {
    title: "night task", dueAt: "2026-09-21T19:00:00.000Z", timed: true, category: "default",
    explicit: true, relative: true, id: "chat:snz", sourceRef: "telegram:1",
  });
  const s = await snoozeReminder(ctx, "chat:snz", 10);
  assert.equal(s.ok, true);
  if (s.ok) assert.equal(s.fireAt, "2026-09-21T18:40:00.000Z"); // exactly +10 min, no quiet-hours shift
  assert.deepEqual(await snoozeReminder(ctx, "chat:snz", 0), { ok: false, reason: "bad-duration" });
  assert.deepEqual(await snoozeReminder(ctx, "chat:snz", 2000), { ok: false, reason: "bad-duration" });
  assert.deepEqual(await snoozeReminder(ctx, "chat:missing", 10), { ok: false, reason: "not-found" });
});

/* -------------------------------------------------------------------------------- R16 */

test("R16: closeReminder marks a deadline done and drops its unsent reminder rows", async () => {
  const ctx = testContext({ at: "2026-09-21T09:00:00Z" });
  await createReminder(ctx, {
    title: "call mom", dueAt: "2026-09-22T09:00:00.000Z", timed: true, category: "default",
    explicit: true, relative: true, id: "chat:r16", sourceRef: "telegram:1",
  });
  const d = await closeReminder(ctx, "chat:r16", "done");
  assert.equal(d!.status, "done");
  assert.equal((await ctx.store.getDeadline("chat:r16"))!.status, "done");
  assert.equal((await ctx.store.listReminders("chat:r16")).length, 0);
  assert.equal(await closeReminder(ctx, "nope", "done"), null);
});

test("cancel: closeReminder(..., 'dismissed') dismisses and drops unsent rows too", async () => {
  const ctx = testContext({ at: "2026-09-21T09:00:00Z" });
  await createReminder(ctx, {
    title: "gym", dueAt: "2026-09-22T09:00:00.000Z", timed: true, category: "default",
    explicit: true, relative: true, id: "chat:cancel", sourceRef: "telegram:1",
  });
  const d = await closeReminder(ctx, "chat:cancel", "dismissed");
  assert.equal(d!.status, "dismissed");
  assert.equal((await ctx.store.listReminders("chat:cancel")).length, 0);
});

/* ----------------------------------------------------------------------------- lastDelivered */

test("lastDelivered: deadline ids from the most recent delivery, only within the window", async () => {
  const tg = new MemoryChannel("telegram");
  const ctx = testContext({ at: "2026-09-21T09:00:00Z", configPatch: PATCH, channels: [tg] });
  await createReminder(ctx, {
    title: "call mom", dueAt: "2026-09-21T09:05:00.000Z", timed: true, category: "default",
    explicit: true, relative: true, id: "chat:ld", sourceRef: "telegram:1", origin: { channel: "telegram", peer: "42" },
  });
  const who = { channel: "telegram" as const, peer: "42" };
  assert.deepEqual(await lastDelivered(ctx, who), []); // nothing delivered yet

  const fired = at(ctx.store, "2026-09-21T09:05:05Z", [tg]);
  await deliverDue(fired);
  assert.deepEqual(await lastDelivered(fired, who), ["chat:ld"]);

  const later = at(ctx.store, "2026-09-21T13:00:00Z", [tg]); // > 3h later
  assert.deepEqual(await lastDelivered(later, who), []);
  assert.deepEqual(await lastDelivered(later, who, 24 * 3_600_000), ["chat:ld"]); // wider window still finds it
});
