import assert from "node:assert/strict";
import { test } from "node:test";
import { FixedClock } from "../clock.ts";
import { testContext } from "../../node/testing/context.ts";
import type { AgentContext, Task } from "../types.ts";
import {
  addTask, completeByName, completeTask, dropTask, parseListRefs, replyAddTask, replyDoneNamed, replyDrop,
  replyTasks, resolveDoneIndex, resolveListRef, persistTaskListing, listToday,
} from "./service.ts";

const MON = "2026-09-20T19:00:00Z"; // Mon 2026-09-21 00:30 IST
const SUN = "2026-09-19T19:00:00Z"; // Sun 2026-09-20
const at = (ctx: AgentContext, iso: string): AgentContext => ({ ...ctx, clock: new FixedClock(iso, ctx.clock.tz) });
const add = (ctx: AgentContext, title: string, recurrence: string | null = null) => addTask(ctx, { title, recurrence }, { writeNotes: false });

test("addTask: plain, duplicate (case-folded), empty, bad recurrence", async () => {
  const ctx = testContext({ at: MON });
  const r = await add(ctx, "  Pay   Bill ");
  assert.ok(r.ok && r.created && r.task.id === "t:pay-bill:2026-09-21" && r.task.source === "chat");
  const d = await add(ctx, "pay bill");
  assert.ok(d.ok && !d.created && d.task.id === r.task.id);
  assert.deepEqual(await add(ctx, "​"), { ok: false, reason: "empty" });
  assert.deepEqual(await add(ctx, "x", "every blursday"), { ok: false, reason: "bad-recurrence" });
  assert.equal((await ctx.store.listTasks()).length, 1);
});

test("addTask: id collision suffixes when the earlier task is done", async () => {
  const ctx = testContext({ at: MON });
  const a = await add(ctx, "Same");
  assert.ok(a.ok);
  if (a.ok) await completeTask(ctx, a.task.id, { writeNotes: false });
  const b = await add(ctx, "Same");
  assert.ok(b.ok && b.created && b.task.id === "t:same:2026-09-21-2");
});

test("addTask: limit counts open tasks due today or earlier", async () => {
  const ctx = testContext({ at: MON, configPatch: { tasks: { maxPerDay: 2 } } });
  await add(ctx, "a");
  await add(ctx, "b");
  assert.deepEqual(await add(ctx, "c"), { ok: false, reason: "limit" });
  const dup = await add(ctx, "a"); // duplicate wins over limit
  assert.ok(dup.ok && !dup.created);
});

test("recurring add on Monday = template + instance; on Sunday = template only; reuse", async () => {
  const mon = testContext({ at: MON });
  const r = await add(mon, "Standup", "every mon");
  assert.ok(r.ok && r.created && r.instantiated);
  if (r.ok) {
    assert.equal(r.template!.status, "template");
    assert.equal(r.template!.id, "t:tpl:standup:2026-09-21");
    assert.equal(r.task.id, "t:rec:t:tpl:standup:2026-09-21:2026-09-21");
    assert.equal(r.task.source, "recurrence");
  }
  const again = await add(mon, "standup", "weekly:MO");
  assert.ok(again.ok && !again.created && !again.instantiated && again.task.status === "open");
  assert.equal((await mon.store.listTasks({ status: ["template"] })).length, 1);

  const sun = testContext({ at: SUN });
  const s = await add(sun, "Standup", "every mon");
  assert.ok(s.ok && s.created && !s.instantiated && s.task.status === "template");
  assert.equal((await listToday(sun)).open.length, 0);
  assert.match(await replyAddTask(sun, { title: "Standup", recurrence: "every mon" }), /^Already recurring: Standup \(weekly:MO\)/);
});

test("double-complete keeps first doneAt; carried task completes onto today", async () => {
  const ctx = testContext({ at: MON });
  await ctx.store.upsertTask({
    id: "t:old:2026-09-18", title: "Old", status: "open", dueDate: "2026-09-18", createdDate: "2026-09-18",
    firstDate: "2026-09-18", rollCount: 0, doneAt: null, recurrence: null, source: "chat", notePath: "Tasks/2026-09-18.md",
  });
  assert.equal((await listToday(ctx)).open.length, 1); // overdue shows even if the cron missed
  const one = (await completeTask(ctx, "t:old:2026-09-18", { writeNotes: false }))!;
  assert.equal(one.status, "done");
  assert.equal(one.dueDate, "2026-09-21");
  assert.equal(one.firstDate, "2026-09-18");
  const later = at(ctx, "2026-09-21T10:00:00Z");
  const two = (await completeTask(later, "t:old:2026-09-18", { writeNotes: false }))!;
  assert.equal(two.doneAt, one.doneAt);
  assert.equal((await listToday(ctx)).done.length, 1);
  assert.equal(await completeTask(ctx, "nope"), null);
});

test("dropTask only drops open tasks", async () => {
  const ctx = testContext({ at: MON });
  const r = await add(ctx, "Skip me");
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal((await dropTask(ctx, r.task.id, { writeNotes: false }))!.status, "dropped");
  assert.equal((await ctx.store.getTask(r.task.id))!.status, "dropped");
  assert.equal((await listToday(ctx)).open.length, 0);
});

test("PLAN 15: mixed, legacy and junk last:list", async () => {
  const ctx = testContext({ at: MON });
  const r = await add(ctx, "Laundry");
  assert.ok(r.ok);
  if (!r.ok) return;
  await ctx.store.kvSet("last:list", JSON.stringify([{ k: "d", id: "dl1" }, { k: "t", id: r.task.id }]), MON);
  assert.deepEqual(await resolveListRef(ctx, 1), { k: "d", id: "dl1" });
  assert.deepEqual(await resolveDoneIndex(ctx, 1), { kind: "deadline", id: "dl1" });
  assert.deepEqual(await resolveDoneIndex(ctx, 2), { kind: "reply", text: "Marked done: Laundry" });
  assert.deepEqual(await resolveDoneIndex(ctx, 2), { kind: "reply", text: "Already done: Laundry" });
  assert.deepEqual(await resolveDoneIndex(ctx, 3), { kind: "reply", text: "No item 3 in the last list. Send 'tasks' or 'status'." });
  await ctx.store.kvSet("last:list", JSON.stringify(["d1", "d2"]), MON); // legacy v1
  assert.deepEqual(await resolveDoneIndex(ctx, 2), { kind: "deadline", id: "d2" });
  assert.match(await replyDrop(ctx, 1), /is a deadline\. Use 'done 1'\./);
  for (const junk of ["not json", "{}", "[1]", '[{"k":"x","id":"a"}]', '["a", null]', "", "null"]) {
    assert.deepEqual(parseListRefs(junk), [], junk);
  }
  assert.deepEqual(parseListRefs(null), []);
  assert.equal(await resolveListRef(ctx, 0), null);
});

test("PLAN 16: one match, two => ambiguous, zero => none; never guesses", async () => {
  const ctx = testContext({ at: MON });
  for (const t of ["Pay electricity bill", "Pay rent", "Call mom"]) await add(ctx, t);
  const one = await completeByName(ctx, "BILL");
  assert.ok(one.kind === "done" && one.task.title === "Pay electricity bill");
  await add(ctx, "Pay tax");
  const amb = await completeByName(ctx, "pay");
  assert.ok(amb.kind === "ambiguous" && amb.candidates.length === 2);
  assert.equal((await ctx.store.getTask("t:pay-rent:2026-09-21"))!.status, "open");
  assert.deepEqual(await completeByName(ctx, "zzz"), { kind: "none" });
  assert.match(await replyDoneNamed(ctx, "pay"), /^Several tasks match "pay"\..*\n1\. Pay rent\n2\. Pay tax$/s);
  assert.equal(await replyDoneNamed(ctx, "zzz"), 'No open task matching "zzz".');
  assert.equal(await replyDoneNamed(ctx, "call"), "Marked done: Call mom");
});

test("reply branches: tasks, add, list numbering, drop", async () => {
  const ctx = testContext({ at: MON });
  assert.equal(await replyTasks(ctx), "No tasks for 2026-09-21. Send 'add task <title>' to add one.");
  assert.equal(await replyAddTask(ctx, { title: "", recurrence: null }), "Give the task a title: add task <title>");
  assert.equal(await replyAddTask(ctx, { title: "Finish job", recurrence: null }), "Added: Finish job as item 1.");
  assert.equal(await replyAddTask(ctx, { title: "finish job", recurrence: null }), "Already on your list: Finish job (item 1).");
  assert.equal(await replyAddTask(ctx, { title: "Standup", recurrence: "daily" }), "Added: Standup as item 2 (repeats: daily).");
  assert.match(await replyAddTask(ctx, { title: "x", recurrence: "sometimes" }), /could not read that repeat rule/);
  await ctx.store.upsertTask({
    id: "t:pay:2026-09-21", title: "Pay bill", status: "done", dueDate: "2026-09-21", createdDate: "2026-09-21",
    firstDate: "2026-09-21", rollCount: 0, doneAt: MON, recurrence: null, source: "chat", notePath: "Tasks/2026-09-21.md",
  });
  await ctx.store.upsertTask({
    id: "t:aa:2026-09-18", title: "Older", status: "open", dueDate: "2026-09-21", createdDate: "2026-09-18",
    firstDate: "2026-09-18", rollCount: 1, doneAt: null, recurrence: null, source: "chat", notePath: "Tasks/2026-09-21.md",
  });
  assert.equal(
    await replyTasks(ctx),
    "Tasks for 2026-09-21:\n1. Older (carried 3 days)\n2. Finish job\n3. Standup (recurring)\n\nDone today:\n4. Pay bill",
  );
  assert.equal(await replyDrop(ctx, 2), "Dropped: Finish job");
  assert.equal(await replyDrop(ctx, 2), "Not an open task: Finish job");
  assert.match(await replyDrop(ctx, 9), /^No item 9/);
  const view = await listToday(ctx);
  await persistTaskListing(ctx, view);
  assert.deepEqual(JSON.parse((await ctx.store.kvGet("last:list"))!).map((r: { k: string }) => r.k), ["t", "t", "t"]);
});

test("a vault write failure never fails a command", async () => {
  const ctx = testContext({
    at: MON,
    vault: { readFile: async () => null, listFiles: async () => [], writeFiles: async () => { throw new Error("boom"); } },
  });
  const r = await addTask(ctx, { title: "Still works" });
  assert.ok(r.ok && r.created);
  assert.ok(await completeTask(ctx, (r as { task: Task }).task.id));
});
