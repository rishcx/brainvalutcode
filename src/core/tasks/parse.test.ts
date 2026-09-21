import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTaskCommand as p } from "./parse.ts";

test("parseTaskCommand table", () => {
  assert.deepEqual(p("tasks"), { kind: "tasks" });
  assert.deepEqual(p("/Today"), { kind: "tasks" });
  assert.deepEqual(p("add task Buy milk"), { kind: "addTask", title: "Buy milk", recurrence: null });
  assert.deepEqual(p("Task buy milk"), { kind: "addTask", title: "buy milk", recurrence: null });
  assert.deepEqual(p("todo Standup every day"), { kind: "addTask", title: "Standup", recurrence: "daily" });
  assert.deepEqual(p("add task Gym daily"), { kind: "addTask", title: "Gym", recurrence: "daily" });
  assert.deepEqual(p("add task Report every weekday"), { kind: "addTask", title: "Report", recurrence: "weekdays" });
  assert.deepEqual(p("add task Bins every friday"), { kind: "addTask", title: "Bins", recurrence: "weekly:FR" });
  assert.deepEqual(p("add task Sync every mon, wed"), { kind: "addTask", title: "Sync", recurrence: "weekly:MO,WE" });
  assert.deepEqual(p("add task walk every dog"), { kind: "addTask", title: "walk every dog", recurrence: null });
  assert.deepEqual(p("add task every day"), { kind: "addTask", title: "every day", recurrence: null });
  assert.deepEqual(p("done 3"), { kind: "done", index: 3 });
  assert.deepEqual(p("done #12"), { kind: "done", index: 12 });
  assert.deepEqual(p("done pay bill"), { kind: "doneNamed", title: "pay bill" });
  assert.deepEqual(p("done 12345"), { kind: "doneNamed", title: "12345" });
  assert.deepEqual(p("drop 3"), { kind: "drop", index: 3 });
  assert.deepEqual(p("not doing 2"), { kind: "drop", index: 2 });
  for (const n of ["task", "status", "confirm 1", "remind me to call mom", "hello there", "done", "done 0", "drop 0", "drop x", "add task ​"]) {
    assert.equal(p(n), null, n);
  }
});

test("the tasks command is forgiving", () => {
  for (const t of ["Tasks?", "tasks please", "Tasks, please!", "please tasks", "my tasks", "My Tasks.", "show tasks", "show me my tasks", "show my tasks", "list tasks", "list my tasks", "what are my tasks", "what are my tasks?", "What's on my todo list?", "whats on my todo list", "what\u2019s on my to-do list", "what is on my tasks", "today's tasks", "Today\u2019s tasks", "give me all tasks", "/tasks", "  tasks  "]) {
    assert.deepEqual(p(t), { kind: "tasks" }, t);
  }
});

test("forgiving tasks does not touch add / done / drop, and lookalikes stay null", () => {
  assert.deepEqual(p("todo list"), { kind: "addTask", title: "list", recurrence: null });
  assert.deepEqual(p("add task my tasks"), { kind: "addTask", title: "my tasks", recurrence: null });
  assert.deepEqual(p("done my tasks"), { kind: "doneNamed", title: "my tasks" });
  assert.deepEqual(p("done 2"), { kind: "done", index: 2 });
  assert.deepEqual(p("drop 2"), { kind: "drop", index: 2 });
  for (const t of ["task", "task?", "show task", "what are my taskforce plans", "tasks for tomorrow", "what is due tomorrow?", "my tasks are hard", "show me my tasks tomorrow", "what's on my calendar"]) {
    assert.equal(p(t), null, t);
  }
});
