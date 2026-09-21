import assert from "node:assert/strict";
import { test } from "node:test";
import { FixedClock } from "../clock.ts";
import { testContext } from "../../node/testing/context.ts";
import type { AgentContext, Task } from "../types.ts";
import { MemoryVault } from "../testing/fakes.ts";
import { rollover } from "./rollover.ts";
import { addTask, completeTask } from "./service.ts";

const SUN = "2026-09-19T19:00:00Z"; // Sun 09-20
const MON = "2026-09-20T19:00:00Z"; // Mon 09-21
const TUE = "2026-09-21T19:00:00Z"; // Tue 09-22
const at = (ctx: AgentContext, iso: string): AgentContext => ({ ...ctx, clock: new FixedClock(iso, ctx.clock.tz) });
const files = (ctx: AgentContext) => (ctx.vault as MemoryVault).files;
const plain = (o: Partial<Task>): Task => ({
  id: "t:x:2026-09-20", title: "x", status: "open", dueDate: "2026-09-20", createdDate: "2026-09-20", firstDate: "2026-09-20",
  rollCount: 0, doneAt: null, recurrence: null, source: "chat", notePath: "Tasks/2026-09-20.md", ...o,
});

test("PLAN 12: rolls yesterday's task once; second run is a no-op; done/dropped/template untouched", async () => {
  const sun = testContext({ at: SUN });
  await sun.store.upsertTask(plain({ id: "t:open:1", title: "open" }));
  await sun.store.upsertTask(plain({ id: "t:done:1", title: "done", status: "done", doneAt: SUN }));
  await sun.store.upsertTask(plain({ id: "t:drop:1", title: "drop", status: "dropped" }));
  const mon = at(sun, MON);
  assert.match(await rollover(mon), /^rolled 1, instantiated 0, wrote 3 files$/);
  const t = (await mon.store.getTask("t:open:1"))!;
  assert.equal(t.dueDate, "2026-09-21");
  assert.equal(t.rollCount, 1);
  assert.equal(t.firstDate, "2026-09-20");
  assert.equal((await mon.store.getTask("t:done:1"))!.dueDate, "2026-09-20");
  assert.equal((await mon.store.getTask("t:drop:1"))!.dueDate, "2026-09-20");
  assert.equal(await rollover(mon), "already rolled");
  assert.equal((await mon.store.getTask("t:open:1"))!.rollCount, 1);
  assert.match(files(mon).get("Tasks/2026-09-21.md")!, /- \[ \] open {2}_\(carried 1 day\)_/);
});

test("PLAN 13: daily template gives one instance per day, even with the gate cleared; done is not reopened", async () => {
  const mon = testContext({ at: MON });
  await addTask(mon, { title: "Standup", recurrence: "daily" }, { writeNotes: false }); // Monday's instance
  const rows = async () => (await mon.store.listTasks({ status: ["open", "done"] })).filter((t) => t.source === "recurrence");
  assert.equal((await rows()).length, 1);
  assert.match(await rollover(mon), /instantiated 0/); // already there (PK guard + open-instance guard)
  await mon.store.kvSet("tasks:rolledFor", "", MON); // gate cleared: still one row
  await rollover(mon);
  assert.equal((await rows()).length, 1);
  const inst = (await rows())[0]!;
  await completeTask(mon, inst.id, { writeNotes: false });
  await mon.store.kvSet("tasks:rolledFor", "", MON);
  assert.match(await rollover(mon), /instantiated 0/); // done instance is not reopened, no second copy
  assert.equal((await rows()).length, 1);
  assert.equal((await mon.store.getTask(inst.id))!.status, "done");
  const tue = at(mon, TUE); // next day: exactly one new instance
  assert.match(await rollover(tue), /instantiated 1/);
  assert.equal((await tue.store.listTasks({ status: ["open"] })).length, 1);
});

test("a carried instance blocks the next copy; 5-day gap = one roll, no back-fill", async () => {
  const ctx = testContext({ at: "2026-09-14T19:00:00Z" }); // Tue 09-15 IST
  await addTask(ctx, { title: "Chore", recurrence: "daily" }, { writeNotes: false });
  const later = at(ctx, "2026-09-20T19:00:00Z"); // Mon 09-21: 6 days later, cron never ran
  assert.match(await rollover(later), /^rolled 1, instantiated 0/);
  const open = await later.store.listTasks({ status: ["open"] });
  assert.equal(open.length, 1);
  assert.equal(open[0]!.rollCount, 1);
  assert.equal(open[0]!.firstDate, "2026-09-15");
  assert.equal(open[0]!.dueDate, "2026-09-21");
});

test("weekly template only instantiates on its day; month end works", async () => {
  const ctx = testContext({ at: "2026-06-29T00:00:00Z" }); // Mon 2026-06-29
  await addTask(ctx, { title: "Bins", recurrence: "weekly:MO,TU" }, { writeNotes: false });
  const done = (await ctx.store.listTasks({ status: ["open"] }))[0]!;
  await completeTask(ctx, done.id, { writeNotes: false });
  const tue = at(ctx, "2026-06-30T06:00:00Z");
  assert.match(await rollover(tue), /instantiated 1/);
  const wed = at(ctx, "2026-07-01T06:00:00Z"); // month rollover, Wednesday: no match
  await completeTask(wed, (await wed.store.listTasks({ status: ["open"] }))[0]!.id, { writeNotes: false });
  assert.match(await rollover(wed), /instantiated 0/);
});

test("writeFiles failing once leaves the gate unset; retry works", async () => {
  const inner = new MemoryVault();
  let fail = true;
  const vault = {
    readFile: (p: string) => inner.readFile(p),
    listFiles: (p?: string) => inner.listFiles(p),
    writeFiles: async (m: string, f: { path: string; content: string }[]) => {
      if (fail) { fail = false; throw new Error("github 502"); }
      return inner.writeFiles(m, f);
    },
  };
  const sun = testContext({ at: SUN, vault });
  await sun.store.upsertTask(plain({ id: "t:open:1" }));
  const mon = at(sun, MON);
  await assert.rejects(() => rollover(mon), /502/);
  assert.equal(await mon.store.kvGet("tasks:rolledFor"), null);
  assert.match(await rollover(mon), /^rolled 0, instantiated 0, wrote 3 files$/); // store step already applied, retry safe
  assert.equal((await mon.store.getTask("t:open:1"))!.rollCount, 1);
  assert.equal(await mon.store.kvGet("tasks:rolledFor"), "2026-09-21");
});

test("empty table restores from a hostile Tasks/tasks.json", async () => {
  const seed = JSON.stringify({
    version: 1,
    tasks: [plain({ id: "t:good:1", title: "Good‮" }), { id: "../x", title: "evil" }, plain({ id: "t:tpl:x:1", status: "template", recurrence: "junk" })],
  });
  const ctx = testContext({ at: MON, vault: new MemoryVault({ "Tasks/tasks.json": seed }) });
  await rollover(ctx);
  const all = await ctx.store.listTasks();
  assert.deepEqual(all.map((t) => t.id), ["t:good:1"]);
  assert.equal(all[0]!.title, "Good");
  assert.equal(all[0]!.dueDate, "2026-09-21"); // restored open task rolled
});

test("past day notes are never rewritten; unchanged same-day sync writes 0 files", async () => {
  const sun = testContext({ at: SUN });
  await addTask(sun, { title: "A" }, { writeNotes: false });
  await rollover(sun);
  const past = files(sun).get("Tasks/2026-09-20.md")!;
  const mon = at(sun, MON);
  await rollover(mon);
  assert.equal(files(mon).get("Tasks/2026-09-20.md"), past);
  assert.ok(files(mon).has("Tasks/2026-09-21.md"));
  const { syncTaskNotes } = await import("./vaultSync.ts");
  assert.deepEqual(await syncTaskNotes(mon), []);
});
