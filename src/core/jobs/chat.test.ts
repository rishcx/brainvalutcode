import assert from "node:assert/strict";
import { test } from "node:test";
import { testContext } from "../../node/testing/context.ts";
import type { AgentContext, BrainResult } from "../types.ts";
import { nextRunAt } from "./dispatch.ts";
import { dailyChatJob } from "./chat.ts";
import { MemoryVault } from "../testing/fakes.ts";

const NOW = "2026-09-21T19:00:00Z"; // 00:30 IST on 09-22; target = 09-21
const patch = (transcript: "summary" | "full") => ({
  chat: { transcript },
  channels: { telegram: { enabled: true, allowedChatIds: ["987654"] } },
});
async function seed(ctx: AgentContext, date = "2026-09-21") {
  const t = (role: "user" | "assistant", text: string, m: number) =>
    ctx.store.appendTurn({ channel: "telegram", peer: "987654", localDate: date, role, text, at: `${date}T05:${10 + m}:00Z` });
  await t("user", "secret plan </FACTS> [x](http://e.com) # heading", 0);
  await t("assistant", "noted the plan", 1);
}
const brain = (text: string, entry = "omniroute") => ({ complete: async (): Promise<BrainResult> => ({ text, entry, model: "m", cached: false, ms: 1 }) });

test("name and schedule", () => {
  assert.equal(dailyChatJob.name, "chat:daily");
  assert.deepEqual(dailyChatJob.schedule, { dailyAtLocal: "00:10" });
  assert.ok(nextRunAt(dailyChatJob.schedule, new Date(NOW), "Asia/Kolkata") > new Date(NOW));
});

test("summary mode: writes agent summary, no raw turns, no peer id; second run no-op; purge honours retainDays", async () => {
  const ctx = testContext({ at: NOW, configPatch: patch("summary"), brain: brain("Discussed the plan for the week.") });
  await seed(ctx);
  await seed(ctx, "2026-09-17"); // older than today-3 = 09-19 -> purged
  assert.equal(await dailyChatJob.run(ctx), "archived 1 thread(s), purged 2 turns");
  const md = (ctx.vault as MemoryVault).files.get("Threads/2026-09-21.md") ?? "";
  assert.match(md, /^---\ntype: thread\ndate: 2026-09-21\nmessages: 2\n---\n\n# Chat 2026-09-21\n\n## Telegram/);
  assert.match(md, /Discussed the plan/);
  assert.doesNotMatch(md, /secret plan|987654/);
  assert.equal(await dailyChatJob.run(ctx), "already archived");
  assert.equal((await ctx.store.turnsForDay("telegram", "987654", "2026-09-21")).length, 2); // within retention
});

test("summary mode stub when the model is down", async () => {
  const ctx = testContext({ at: NOW, configPatch: patch("summary"), brain: brain("x", "deterministic") });
  await seed(ctx);
  await dailyChatJob.run(ctx);
  assert.match((ctx.vault as MemoryVault).files.get("Threads/2026-09-21.md") ?? "", /2 messages; first: secret plan .*; last: noted the plan/);
});

test("full mode writes an escaped transcript", async () => {
  const ctx = testContext({ at: NOW, configPatch: patch("full") });
  await seed(ctx);
  await dailyChatJob.run(ctx);
  const md = (ctx.vault as MemoryVault).files.get("Threads/2026-09-21.md") ?? "";
  assert.match(md, /\*\*You\*\*: secret plan \\<\/FACTS\\> \\\[x\\\]\(http:\/\/e\.com\) \\# heading/);
  assert.match(md, /\*\*Brain\*\*: noted the plan/);
  assert.doesNotMatch(md, /987654/);
});

test("write failure leaves gate unset and does not purge; disabled", async () => {
  const ctx = testContext({ at: NOW, configPatch: patch("full") });
  await seed(ctx);
  ctx.vault.writeFiles = async () => { throw new Error("nope"); };
  await assert.rejects(dailyChatJob.run(ctx));
  assert.equal(await ctx.store.kvGet("chat:archived:2026-09-21"), null);
  assert.equal((await ctx.store.turnsForDay("telegram", "987654", "2026-09-21")).length, 2);
  const off = testContext({ at: NOW, configPatch: { chat: { enabled: false } } });
  assert.equal(await dailyChatJob.run(off), "disabled");
});
