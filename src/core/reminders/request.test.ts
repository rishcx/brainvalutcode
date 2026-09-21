import assert from "node:assert/strict";
import { test } from "node:test";
import { testContext } from "../../node/testing/context.ts";
import { localDateOf, localTimeOf } from "../time.ts";
import type { ReminderRule } from "../types.ts";
import { parseReminderRequest, type ReminderRequest } from "./request.ts";

const TZ = "Asia/Kolkata";
const NOW = new Date("2026-09-21T10:00:20Z"); // Mon 15:30:20 IST
const RULES: ReminderRule[] = testContext().config.reminders.rules;
const r = (t: string, now: Date = NOW): ReminderRequest | null => parseReminderRequest(t, RULES, TZ, now, 9);
const local = (q: ReminderRequest | null): string => `${localDateOf(new Date(q!.dueAt), TZ)} ${localTimeOf(new Date(q!.dueAt), TZ)}`;

test("the two real Telegram messages", () => {
  const a = r("Remind me after 2 mins to drink water")!;
  assert.deepEqual(a, { title: "drink water", dueAt: "2026-09-21T10:03:00.000Z", timed: true, category: "default", explicit: true, relative: true });
  const b = r("Can you set a remaining of 2 mins")!;
  assert.deepEqual([b.title, b.dueAt, b.explicit, b.category], ["Reminder", "2026-09-21T10:03:00.000Z", true, "default"]);
});

test("imperative forms are explicit", () => {
  const cases: Array<[string, string, string]> = [
    ["remind me to drink water in 2 minutes", "drink water", "2026-09-21T10:03:00.000Z"],
    ["Remind me in 10 minutes about the oven", "the oven", "2026-09-21T10:11:00.000Z"],
    ["please remind me in an hour to stretch", "stretch", "2026-09-21T11:01:00.000Z"],
    ["Could you remind me in 5 min to call the bank?", "call the bank", "2026-09-21T10:06:00.000Z"],
    ["set me a reminder in 5 minutes to check rice", "check rice", "2026-09-21T10:06:00.000Z"],
    ["set a reminder for 10 mins to leave", "leave", "2026-09-21T10:11:00.000Z"],
    ["reminder: in 15 minutes join standup", "join standup", "2026-09-21T10:16:00.000Z"],
    ["Reminder: pay rent in 2 hours", "pay rent", "2026-09-21T12:01:00.000Z"],
    ["hey, can you please set a reminder of 3 minutes to hydrate", "hydrate", "2026-09-21T10:04:00.000Z"],
    ["remind me 2 minutes later to stand up", "stand up", "2026-09-21T10:03:00.000Z"],
    ["remind me to call mom in 30 sec please", "call mom", "2026-09-21T10:02:00.000Z"],
  ];
  for (const [text, title, dueAt] of cases) {
    const q = r(text);
    assert.ok(q, text);
    assert.deepEqual([q.title, q.dueAt, q.explicit, q.relative, q.timed], [title, dueAt, true, true, true], text);
  }
  assert.equal(r("set a timer for 5 minutes")!.title, "Timer");
  assert.equal(r("set an alarm in 5 minutes")!.title, "Alarm");
  assert.equal(r("set a timer for 5 minutes")!.explicit, true);
});

test("absolute times go through parseLooseWhen and stay explicit", () => {
  const a = r("remind me at 5pm to call mom")!;
  assert.deepEqual([a.title, a.explicit, a.timed, a.relative, a.category], ["call mom", true, true, true, "default"]);
  assert.equal(local(a), "2026-09-21 17:00");
  const b = r("remind me tomorrow 6pm to call mom")!;
  assert.deepEqual([b.title, local(b), b.explicit, b.timed], ["call mom", "2026-09-22 18:00", true, true]);
  const c = r("remind me to pay rent on 4 Oct")!; // date only: dueHourLocal
  assert.deepEqual([c.title, local(c), c.timed, c.explicit, c.relative], ["pay rent", "2026-10-04 09:00", false, true, false]);
  const d = r("remind me tomorrow morning to email Sam")!;
  assert.deepEqual([d.title, local(d), d.timed], ["email Sam", "2026-09-22 09:00", true]);
  assert.equal(local(r("remind me tonight to lock up")), "2026-09-21 20:00");
  assert.equal(local(r("remind me at noon to eat")), "2026-09-22 12:00");
});

test("statements stay proposals: explicit false", () => {
  const q = r("I have a flight tomorrow 6pm")!;
  assert.deepEqual([q.explicit, q.title, q.category, q.timed, local(q)], [false, "flight", "flight", true, "2026-09-22 18:00"]);
  const s = r("I have a dentist appointment in 2 hours")!;
  assert.deepEqual([s.explicit, s.title, s.dueAt], [false, "dentist appointment", "2026-09-21T12:01:00.000Z"]);
  assert.equal(r("I have a flight tomorrow"), null); // flight needs a clock time: the caller asks
});

test("questions, chatter and time-less text are null", () => {
  for (const t of ["what is due tomorrow?", "when is my flight tomorrow", "remind me to call mom", "remind me", "hello", "", "tasks", "show my reminders", "how long is 5 minutes", "what reminders do I have in 2 hours"]) {
    assert.equal(r(t), null, t);
  }
});

test("past times are refused, never scheduled", () => {
  const late = new Date("2026-09-21T16:00:00Z"); // 21:30 IST
  assert.equal(r("remind me tonight to lock up", late), null); // 20:00 gone
  assert.equal(r("remind me at 5pm to call mom", late)!.dueAt.slice(0, 10), "2026-09-22"); // next 5pm, not today's
  assert.equal(r("remind me today to X", late), null); // 09:00 today is gone
  assert.equal(r("remind me on 2020-01-01 to X"), null);
});

test("quiet-hours and midnight boundaries", () => {
  const night = new Date("2026-09-21T18:25:00Z"); // 23:55 IST
  const q = r("remind me in 10 minutes to check the door", night)!;
  assert.equal(local(q), "2026-09-22 00:05");
  assert.equal(local(r("remind me at midnight to sleep", night)), "2026-09-22 00:00");
  assert.equal(local(r("remind me tomorrow morning to run", night)), "2026-09-22 09:00");
});

test("titles are cleaned and sanitised", () => {
  const q = r("remind me in 5 minutes to **call**   `mom`​ [now] <b>x</b> | y_z")!;
  assert.ok(!/[*`_\[\]<>|\\~]/.test(q.title), q.title);
  assert.ok(!q.title.includes("​") && !q.title.includes("  "), q.title);
  const long = r(`remind me in 5 minutes to ${"a".repeat(500)}`)!;
  assert.ok(long.title.length <= 200);
  assert.equal(r("remind me in 5 minutes to call\nmom\r\n")!.title, "call mom");
});

test("hashtag category and never throws", () => {
  assert.equal(r("remind me in 3 hours to pack #flight")!.category, "flight");
  for (const bad of [undefined, null, 5, {}, "\u0000", "in ".repeat(500)]) {
    assert.doesNotThrow(() => parseReminderRequest(bad as unknown as string, RULES, TZ, NOW, 9));
  }
  assert.doesNotThrow(() => parseReminderRequest("remind me in 5 min", RULES, "Nowhere/Land", NOW, 9));
  assert.equal(parseReminderRequest("remind me in 5 min", RULES, TZ, new Date(NaN), 9), null);
});
