import assert from "node:assert/strict";
import { test } from "node:test";
import { inLabel, numberedList, reminderSet, tasksAdded, whenLabel } from "./render.ts";

const TZ = "Asia/Kolkata";
const NOW = new Date("2026-09-21T09:35:00Z"); // Mon 15:05 IST

test("time labels", () => {
  assert.equal(whenLabel("2026-09-21T09:45:00Z", NOW, TZ), "today 15:15");
  assert.equal(whenLabel("2026-09-22T03:30:00Z", NOW, TZ), "tomorrow 09:00");
  assert.match(whenLabel("2026-09-23T11:30:00Z", NOW, TZ), /^Wed 23 Sept? 17:00$/);
  assert.equal(inLabel("2026-09-21T09:45:00Z", NOW), "in 10 min");
  assert.equal(inLabel("2026-09-21T11:40:00Z", NOW), "");
  assert.equal(inLabel("2026-09-25T09:45:00Z", NOW), "");
});

test("reminder and task templates", () => {
  assert.equal(reminderSet("call mom", "2026-09-21T09:45:00Z", NOW, TZ), "Reminder set: call mom, today 15:15 (in 10 min).");
  // audit 8: added/existing tasks are now rendered as a numbered list, matching the list "done N" resolves against.
  const num = (title: string, n: number) => ({ n, title });
  assert.equal(tasksAdded([num("milk", 1), num("eggs", 2), num("gym", 3)], [], []), "Added 3 tasks:\n• 1. milk\n• 2. eggs\n• 3. gym");
  assert.equal(tasksAdded([], [num("gym", 4)], ["wire money"]), 'Already on your list:\n• 4. gym\nI skipped "wire money" because it isn\'t in your message.');
  assert.equal(tasksAdded([num("milk", 0)], [], []), "Added 1 task:\n• milk"); // not on today's list: no number invented
});

test("lists cap at 8 with a tail", () => {
  const out = numberedList("Today (10 open):", Array.from({ length: 10 }, (_, i) => `t${i + 1}`));
  assert.equal(out.split("\n").length, 10);
  assert.match(out, /^Today \(10 open\):\n• 1\. t1\n/);
  assert.match(out, /\.\.\. and 2 more$/);
});
