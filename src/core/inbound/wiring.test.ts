// Integration of P1 (categories/rules), P2 (tasks) and P3 through the chat handler, the way a user drives it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { testContext } from "../../node/testing/context.ts";
import type { AgentContext, InboundMessage } from "../types.ts";
import { handleInbound } from "./commands.ts";

// Frozen clock: 2026-09-20 04:30Z = Sun 20 Sep 10:00 IST.
const patch = { channels: { telegram: { enabled: true, allowedChatIds: ["42"] } } };
const mk = (): AgentContext => testContext({ configPatch: patch });
let n = 0;
const say = (ctx: AgentContext, text: string): Promise<string | null> =>
  handleInbound(ctx, { channel: "telegram", id: String(++n), from: "42", text, at: "2026-09-20T04:30:00.000Z" } satisfies InboundMessage);

test("'I have a flight tomorrow 6pm' becomes a proposed FLIGHT deadline; confirming schedules exactly one reminder, 24h before", async () => {
  const ctx = mk();
  const reply = (await say(ctx, "I have a flight tomorrow 6pm"))!;
  assert.match(reply, /flight/i);
  assert.match(reply, /confirm 1/);
  const [d] = await ctx.store.listDeadlines({ status: ["proposed"] });
  assert.equal(d!.category, "flight");
  assert.equal(d!.timed, true);
  assert.equal(d!.dueAt, "2026-09-21T12:30:00.000Z"); // Mon 21 Sep 18:00 IST
  assert.match((await say(ctx, "confirm 1"))!, /Confirmed/);
  const rows = await ctx.store.listReminders(d!.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.fireAt, "2026-09-20T12:30:00.000Z"); // 24h before, Sun 20 Sep 18:00 IST
});

test("a QUESTION that mentions a date never becomes a reminder", async () => {
  const ctx = mk();
  for (const q of ["what is due tomorrow?", "which flights do I have tomorrow 6pm", "do I have a flight on 4 Oct?", "show my deadlines for 25 Sep"]) {
    await say(ctx, q);
  }
  assert.equal((await ctx.store.listDeadlines()).length, 0);
});

test("a date with no time for a flight asks for the time, then '6pm' completes it", async () => {
  const ctx = mk();
  const ask = (await say(ctx, "I have a flight on 4 Oct"))!;
  assert.match(ask, /time/i);
  assert.equal((await ctx.store.listDeadlines()).length, 0); // nothing created until the time is known
  const reply = (await say(ctx, "6pm"))!;
  assert.match(reply, /Proposed/);
  const [d] = await ctx.store.listDeadlines({ status: ["proposed"] });
  assert.equal(d!.dueAt, "2026-10-04T12:30:00.000Z");
  assert.equal(d!.category, "flight");
});

test("tasks and deadlines share one numbering: done <n> follows the most recent list", async () => {
  const ctx = mk();
  assert.match((await say(ctx, "add task buy milk"))!, /buy milk/i);
  assert.match((await say(ctx, "tasks"))!, /buy milk/i);
  assert.match((await say(ctx, "done 1"))!, /Marked done: buy milk/i);

  await say(ctx, "remind me to file taxes on 1 Oct 2026"); // proposal, listing now points at the deadline
  await say(ctx, "confirm 1");
  await say(ctx, "status");
  assert.match((await say(ctx, "done 1"))!, /Marked done: file taxes/);
  const taxes = (await ctx.store.listDeadlines()).find((d) => d.title === "file taxes");
  assert.equal(taxes?.status, "done"); // the deadline, not just the reply text
  assert.equal((await ctx.store.listDeadlines({ status: ["open"] })).length, 0);
});

test("confirm on a list that points at a task is refused kindly, without touching anything", async () => {
  const ctx = mk();
  await say(ctx, "add task water plants");
  await say(ctx, "tasks");
  assert.match((await say(ctx, "confirm 1"))!, /task/i);
});

test("'rules' shows the per-category schedule", async () => {
  const ctx = mk();
  const r = (await say(ctx, "rules"))!;
  assert.match(r, /flight: 24h/);
  assert.match(r, /assignment: 2h/);
  assert.match(r, /github: 24h/);
});

test("a plain question goes to the smart chat, which answers from facts even with no LLM", async () => {
  const ctx = mk();
  const r = (await say(ctx, "how are my repos doing"))!;
  assert.match(r, /nothing on file|no LLM/i);
  assert.doesNotMatch(r, /error|undefined|null/i);
});

test("the two real messages that failed on the live bot now create an active reminder due in 2 minutes", async () => {
  for (const text of ["Remind me after 2 mins to drink water", "remind me to drink water in 2 minutes", "Can you set a remaining of 2 mins"]) {
    const ctx = mk();
    const reply = (await say(ctx, text))!;
    assert.match(reply, /Reminder set for/, text);
    const [d] = await ctx.store.listDeadlines({ status: ["open"] });
    assert.ok(d, text);
    assert.equal(d!.dueAt, "2026-09-20T04:32:00.000Z", text); // frozen clock 04:30Z + 2 minutes
    const rows = await ctx.store.listReminders(d!.id);
    assert.equal(rows.length, 1, text);
    assert.equal(rows[0]!.fireAt, "2026-09-20T04:32:00.000Z", text);
    assert.equal(rows[0]!.sentAt, null, text);
  }
});

test("a reminder whose time has already passed asks for a new time and creates NOTHING (no past-dated proposal)", async () => {
  const ctx = testContext({ configPatch: patch, at: "2026-09-20T16:00:00.000Z" }); // 21:30 IST: "tonight" (20:00) is over
  const reply = (await say(ctx, "remind me tonight to stretch"))!;
  assert.match(reply, /When should I remind you/i);
  assert.equal((await ctx.store.listDeadlines()).length, 0);
  assert.doesNotMatch(reply, /Proposed|remind me to stretch/); // and no dirty "remind me to ..." title
});

test("'remind me to stretch' with no time asks when, remembers the title, and 'in 10 minutes' completes it", async () => {
  const ctx = mk();
  const ask = (await say(ctx, "remind me to stretch"))!;
  assert.match(ask, /When should I remind you about "stretch"/);
  assert.equal((await ctx.store.listDeadlines()).length, 0);
  const done = (await say(ctx, "in 10 minutes"))!;
  assert.match(done, /Reminder set for .*stretch/);
  const [d] = await ctx.store.listDeadlines({ status: ["open"] });
  assert.equal(d!.title, "stretch");
  assert.equal(d!.dueAt, "2026-09-20T04:40:00.000Z");
  assert.equal((await ctx.store.listReminders(d!.id)).length, 1);
  // the pending question is consumed: the next unrelated message does not create another reminder
  await say(ctx, "in 10 minutes");
  assert.equal((await ctx.store.listDeadlines()).length, 1);
});

test("a STATEMENT about a past time is never proposed", async () => {
  const ctx = testContext({ configPatch: patch, at: "2026-09-20T16:00:00.000Z" });
  await say(ctx, "I have a flight tonight");
  assert.equal((await ctx.store.listDeadlines({ status: ["proposed", "open"] })).length, 0);
});
