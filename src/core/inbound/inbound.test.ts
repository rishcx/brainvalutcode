import assert from "node:assert/strict";
import { test } from "node:test";
import { testContext } from "../../node/testing/context.ts";
import type { AgentContext, InboundMessage } from "../types.ts";
import { handleInbound, parseCommand } from "./commands.ts";

const patch = { channels: { telegram: { enabled: true, allowedChatIds: ["42"] } } };
const mk = (o: Parameters<typeof testContext>[0] = {}): AgentContext => testContext({ configPatch: patch, ...o });
const msg = (id: string, text: string, from = "42"): InboundMessage => ({
  channel: "telegram", id, from, text, at: "2026-09-20T04:30:00.000Z",
});

test("the same provider message id is handled once; replay returns null", async () => {
  const ctx = mk();
  const first = await handleInbound(ctx, msg("1", "help"));
  assert.match(first!, /Commands/);
  assert.equal(await handleInbound(ctx, msg("1", "help")), null);
});

test("messages from senders off the allowlist do nothing and are not even marked processed", async () => {
  const ctx = mk();
  assert.equal(await handleInbound(ctx, msg("9", "remind me to x on 1 Oct 2026", "666")), null);
  assert.equal((await ctx.store.listDeadlines()).length, 0);
  assert.equal(await ctx.store.markProcessed("telegram:9", ctx.clock.now().toISOString()), true);
});

test("an explicit 'remind me to X on <date>' is ACTIVE immediately (no confirm) with one reminder at the due time", async () => {
  const ctx = mk();
  const reply = await handleInbound(ctx, msg("2", "remind me to file taxes on 1 Oct 2026"));
  assert.match(reply!, /Reminder set for .*file taxes/i);
  assert.doesNotMatch(reply!, /confirm/i);
  const d = (await ctx.store.getDeadline("chat:2"))!;
  assert.deepEqual([d.status, d.source, d.confidence, d.title], ["open", "chat", 1, "file taxes"]);
  assert.equal(d.dueAt, "2026-10-01T03:30:00.000Z");
  const rows = await ctx.store.listReminders("chat:2");
  assert.equal(rows.length, 1); // a plain reminder fires once, at the time asked for
  assert.equal(rows[0]!.fireAt, "2026-10-01T03:30:00.000Z");
});

test("a STATEMENT still needs confirmation: it is proposed with no reminder rows until 'confirm 1'", async () => {
  const ctx = mk();
  const reply = await handleInbound(ctx, msg("2", "I have a flight tomorrow 6pm"));
  assert.match(reply!, /confirm 1/);
  const [d] = await ctx.store.listDeadlines({ status: ["proposed"] });
  assert.equal(d!.status, "proposed");
  assert.equal((await ctx.store.listReminders(d!.id)).length, 0);
  assert.match((await handleInbound(ctx, msg("3", "confirm 1")))!, /Confirmed/);
  assert.equal((await ctx.store.getDeadline(d!.id))!.status, "open");
  assert.ok((await ctx.store.listReminders(d!.id)).length >= 1);
});

test("done n resolves against the stored numbering; out-of-range and missing list are friendly errors", async () => {
  const ctx = mk();
  const base = { source: "manual" as const, sourceRef: "r", status: "open" as const, confidence: 1, notePath: "Deadlines/index.md" };
  for (const [i, day] of ["01", "02", "03"].entries()) {
    await ctx.store.upsertDeadline({ ...base, id: `m:${i + 1}`, title: `Item ${i + 1}`, dueAt: `2026-10-${day}T03:30:00.000Z` });
  }
  assert.match((await handleInbound(ctx, msg("a", "done 1")))!, /No item 1/); // nothing listed yet
  assert.match((await handleInbound(ctx, msg("b", "status")))!, /3\. 2026-10-03 - Item 3/);
  assert.match((await handleInbound(ctx, msg("c", "done 2")))!, /Marked done: Item 2/);
  assert.equal((await ctx.store.getDeadline("m:2"))!.status, "done");
  assert.match((await handleInbound(ctx, msg("d", "done 9")))!, /No item 9/);
});

test("parseCommand covers the union; unparsable remind falls back to help; ask degrades without a brain", async () => {
  const ctx = mk();
  assert.deepEqual(parseCommand("/status", ctx), { kind: "status" });
  assert.deepEqual(parseCommand("Done 3", ctx), { kind: "done", index: 3 });
  assert.deepEqual(parseCommand("confirm #2", ctx), { kind: "confirm", index: 2 });
  assert.deepEqual(parseCommand("remind me to file taxes", ctx), { kind: "help" });
  assert.deepEqual(parseCommand("what is due?", ctx), { kind: "ask", question: "what is due?" });
  const r = parseCommand("remind me to call bob on phone on 2026-10-01", ctx);
  assert.equal(r.kind === "remind" && r.title, "call bob on phone");
  assert.match((await handleInbound(ctx, msg("q", "what is due?")))!, /nothing on file|no LLM/i); // smart-chat fallback: facts, never an error string
});
