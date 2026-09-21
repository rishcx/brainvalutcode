import assert from "node:assert/strict";
import { test } from "node:test";
import { isCancelWords, parseFast } from "./fast.ts";

test("exact commands", () => {
  assert.deepEqual(parseFast("status"), { kind: "status" });
  assert.deepEqual(parseFast("/Tasks"), { kind: "tasks" });
  assert.deepEqual(parseFast("today"), { kind: "tasks" });
  assert.deepEqual(parseFast("help"), { kind: "help" });
  assert.deepEqual(parseFast("rules."), { kind: "rules" });
  assert.deepEqual(parseFast("done 2"), { kind: "done", index: 2 });
  assert.deepEqual(parseFast("done"), { kind: "done" });
  assert.deepEqual(parseFast("drop #3"), { kind: "drop", index: 3 });
  assert.deepEqual(parseFast("confirm 1 please"), { kind: "confirm", index: 1 });
  assert.deepEqual(parseFast("cancel"), { kind: "cancel" });
  assert.deepEqual(parseFast("cancel 2"), { kind: "cancel", index: 2 });
  assert.deepEqual(parseFast("trace"), { kind: "trace", n: 5 });
  assert.deepEqual(parseFast("trace 50"), { kind: "trace", n: 10 });
});

test("snooze grammar", () => {
  assert.deepEqual(parseFast("snooze"), { kind: "snooze", minutes: 10 });
  assert.deepEqual(parseFast("snooze 10m"), { kind: "snooze", minutes: 10 });
  assert.deepEqual(parseFast("snooze 1h"), { kind: "snooze", minutes: 60 });
  assert.deepEqual(parseFast("snooze 2 10m"), { kind: "snooze", index: 2, minutes: 10 });
  assert.deepEqual(parseFast("snooze for 15 mins"), { kind: "snooze", minutes: 15 });
  assert.equal(parseFast("snooze 30h"), null);
});

test("natural phrasings go to PLAN (T6, T12, E10)", () => {
  for (const t of ["task list", "done for today, thanks", "what are today's tasks", "add task milk", "set a reminder", "show tasks", "done 0"]) {
    assert.equal(parseFast(t), null, t);
  }
});

test("cancel words incl. Hinglish", () => {
  for (const t of ["never mind", "Nevermind!", "forget it", "no need", "rehne do", "chhodo", "jane do", "mat karo", "cancel"]) {
    assert.ok(isCancelWords(t), t);
  }
  for (const t of ["cancel the call mom reminder", "stop the reminder at 6", "ok"]) assert.ok(!isCancelWords(t), t);
});
