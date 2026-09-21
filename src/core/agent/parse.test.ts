import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePlan } from "./parse.ts";

test("clean JSON", () => {
  const { plan, flags } = parsePlan('{"intent":"list_tasks","tools":[{"name":"list_tasks","args":{"day":"today"}}],"say":"","compose":false}');
  assert.deepEqual(flags, []);
  assert.equal(plan?.intent, "list_tasks");
  assert.deepEqual(plan?.tools, [{ name: "list_tasks", args: { day: "today", include_done: false } }]);
});

test("prose, fences, think and drafts: the last object with intent wins", () => {
  const raw = '<think>{"intent":"help"}</think>Sure!\n```json\n{"intent":"smalltalk","say":"a"}\n```\nfinal: {"intent":"smalltalk","say":"b",}';
  assert.equal(parsePlan(raw).plan?.say, "b");
});

test("junk and empty -> null", () => {
  assert.equal(parsePlan("I cannot help").plan, null);
  assert.equal(parsePlan("").plan, null);
  assert.equal(parsePlan('{"reply":"x"}').plan, null);
});

test("U8: > 4 tools truncated and flagged; unknown tool dropped", () => {
  const tools = Array.from({ length: 6 }, () => ({ name: "list_tasks", args: {} }));
  const { plan, flags } = parsePlan(JSON.stringify({ intent: "list_tasks", tools: [...tools, { name: "rm_rf", args: {} }] }));
  assert.equal(plan?.tools.length, 4);
  assert.ok(flags.includes("too_many_tools"));
  assert.ok(flags.includes("bad_tool"));
});

test("args coerced: refs, items, minutes, at_local", () => {
  const { plan, flags } = parsePlan(
    JSON.stringify({
      intent: "add_tasks",
      tools: [
        { name: "add_tasks", args: { items: ["milk", { text: "gym", every: "every monday" }, { text: 5 }, ...Array(10).fill("x")] } },
        { name: "complete_task", args: { ref: 2 } },
        { name: "reschedule_reminder", args: { ref: "last", when_text: "7pm", at_local: "bogus" } },
        { name: "snooze_reminder", args: { ref: { index: "1" }, minutes: 5000 } },
      ],
    }),
  );
  const [add, done, re, sn] = plan!.tools;
  assert.equal((add!.args.items as unknown[]).length, 9); // first 10, minus the non-string one
  assert.deepEqual((add!.args.items as unknown[])[1], { text: "gym", every: "monday" });
  assert.ok(flags.includes("too_many_items"));
  assert.deepEqual(done!.args.ref, { index: 2 });
  assert.deepEqual(re!.args, { ref: { last: true }, when_text: "7pm", at_local: null });
  assert.deepEqual(sn!.args, { ref: { index: 1 }, minutes: null });
});

test("action intent with no tools gets its tool with empty args; unknown intent borrows the tool", () => {
  assert.deepEqual(parsePlan('{"intent":"create_reminder","tools":[]}').plan?.tools, [
    { name: "create_reminder", args: { what: null, when_text: null, at_local: null } },
  ]);
  const p = parsePlan('{"intent":"reminder","tools":[{"name":"list_reminders","args":{"range":"today"}}]}');
  assert.equal(p.plan?.intent, "list_reminders");
  assert.ok(p.flags.includes("bad_intent"));
});
