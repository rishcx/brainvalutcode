import assert from "node:assert/strict";
import { test } from "node:test";
import { testContext } from "../../node/testing/context.ts";
import { nextRunAt } from "./dispatch.ts";
import { rolloverTasks } from "./tasks.ts";
import { addTask } from "../tasks/service.ts";

test("rollover:tasks name, schedule and next run (03:00 local)", () => {
  assert.equal(rolloverTasks.name, "rollover:tasks");
  assert.deepEqual(rolloverTasks.schedule, { dailyAtLocal: "03:00" });
  // 2026-09-20T19:00Z = 00:30 IST on 09-21 -> next 03:00 IST is 21:30Z the same UTC day
  assert.equal(nextRunAt(rolloverTasks.schedule, new Date("2026-09-20T19:00:00Z"), "Asia/Kolkata").toISOString(), "2026-09-20T21:30:00.000Z");
});

test("job runs once per day and reports disabled when off", async () => {
  const ctx = testContext({ at: "2026-09-20T19:00:00Z" });
  await addTask(ctx, { title: "Standup", recurrence: "daily" }, { writeNotes: false });
  assert.match(await rolloverTasks.run(ctx), /^rolled 0, instantiated 0, wrote 3 files$/);
  assert.equal(await rolloverTasks.run(ctx), "already rolled");
  const off = testContext({ configPatch: { tasks: { enabled: false } } });
  assert.equal(await rolloverTasks.run(off), "disabled");
  assert.equal((await off.store.listTasks()).length, 0);
});
