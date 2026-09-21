import assert from "node:assert/strict";
import { test } from "node:test";
import { testContext } from "../../node/testing/context.ts";
import { MemoryVault } from "../testing/fakes.ts";
import { addTask } from "./service.ts";
import { restoreFromVault, syncTaskNotes } from "./vaultSync.ts";

const MON = "2026-09-20T19:00:00Z";

test("syncTaskNotes writes three files; unchanged re-run writes none", async () => {
  const ctx = testContext({ at: MON });
  await addTask(ctx, { title: "A" }, { writeNotes: false });
  const first = await syncTaskNotes(ctx);
  assert.deepEqual(first.sort(), ["Tasks/2026-09-21.md", "Tasks/index.md", "Tasks/tasks.json"]);
  assert.deepEqual(await syncTaskNotes(ctx), []);
});

test("restoreFromVault round-trips through tasks.json", async () => {
  const a = testContext({ at: MON });
  await addTask(a, { title: "Keep me" }, { writeNotes: false });
  await addTask(a, { title: "Standup", recurrence: "daily" }, { writeNotes: false });
  await syncTaskNotes(a);
  const b = testContext({ at: MON, vault: a.vault });
  assert.equal(await restoreFromVault(b), 3);
  assert.deepEqual(await b.store.listTasks(), await a.store.listTasks());
  assert.equal(await restoreFromVault(b), 0); // table not empty
});

test("hostile tasks.json: bad rows skipped, titles re-sanitised, notePath recomputed", async () => {
  const good = {
    id: "t:ok:2026-09-20", title: "  ok‮ title ", status: "open", dueDate: "2026-09-20", createdDate: "2026-09-20",
    firstDate: "2026-09-20", rollCount: 2, doneAt: null, recurrence: null, source: "chat", notePath: "../../etc/passwd",
  };
  const bad = [
    { ...good, id: "../evil" }, { ...good, id: "t:UP:1" }, { ...good, status: "weird" }, { ...good, source: "x" },
    { ...good, dueDate: "2026-02-30" }, { ...good, dueDate: "nope" }, { ...good, rollCount: -1 }, { ...good, rollCount: 1.5 },
    { ...good, doneAt: "garbage" }, { ...good, title: "​" }, { ...good, title: 5 },
    { ...good, recurrence: "daily" }, // recurrence on a non-template
    { ...good, status: "template", recurrence: null },
    { ...good, status: "template", recurrence: "bogus" }, null, 7, "str", [],
  ];
  const ctx = testContext({
    at: MON,
    vault: new MemoryVault({ "Tasks/tasks.json": JSON.stringify({ version: 1, tasks: [...bad, good] }) }),
  });
  assert.equal(await restoreFromVault(ctx), 1);
  const [t] = await ctx.store.listTasks();
  assert.equal(t!.title, "ok title");
  assert.equal(t!.notePath, "Tasks/2026-09-20.md");
  assert.equal(t!.rollCount, 2);
  for (const junk of ["{", "null", '{"tasks":5}', ""]) {
    const c = testContext({ at: MON, vault: new MemoryVault({ "Tasks/tasks.json": junk }) });
    assert.equal(await restoreFromVault(c), 0, junk);
  }
});
