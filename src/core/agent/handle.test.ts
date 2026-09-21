// Reminder + dialog scenarios (PLAN_V3 C.3 E/R/I) against runAgent with a scripted brain.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AT, agent, cr, talk, tool } from "./testkit.test.ts";

test("R1: set a reminder / call mom / in 10 minutes -> 1 row, turn 3 has 0 LLM calls", async () => {
  const a = agent();
  const t1 = await a.say("set a reminder", { plan: cr(null, null) }, "whatsapp");
  assert.equal(t1.reply, "What should I remind you about?");
  assert.equal(t1.result.trace.route, "plan");
  assert.deepEqual((await a.dialog("whatsapp"))?.missing, ["what", "when"]);
  const t2 = await a.say("call mom", { plan: cr("call mom", null) }, "whatsapp");
  assert.match(t2.reply, /^When should I remind you to call mom\?/);
  const t3 = await a.say("in 10 minutes", {}, "whatsapp");
  assert.equal(t3.llm, 0);
  assert.equal(t3.result.trace.route, "dialog");
  assert.equal(t3.reply, "Reminder set: call mom, today 15:10 (in 10 min).");
  assert.deepEqual(await a.reminders(), [{ title: "call mom", local: "2026-09-21 15:10", status: "open", origin: "whatsapp" }]);
  assert.equal((await a.dialog("whatsapp"))?.intent, "idle");
  assert.deepEqual(a.sb.unexpected, []);
});

test("R2/E3: a time with no subject asks what, never creates 'Reminder'", async () => {
  const a = agent();
  const t = await a.say("set a reminder in 10 minutes", { plan: cr("a reminder", "in 10 minutes") });
  assert.equal(t.reply, "What should I remind you about?");
  assert.deepEqual(await a.reminders(), []);
  assert.deepEqual((await a.dialog())?.missing, ["what"]);
  const e3 = await a.say("Can you set a remaining of 2 mins", { plan: cr(null, "2 mins") });
  assert.equal(e3.reply, "What should I remind you about?");
  assert.deepEqual(await a.reminders(), []);
});

test("R3 + R4: 6pm is code-only; 'no, make it 7pm' reschedules the same row", async () => {
  const a = agent();
  await a.say("remind me to call mom", { plan: cr("call mom", null) });
  const t2 = await a.say("6pm");
  assert.equal(t2.llm, 0);
  assert.match(t2.reply, /call mom, today 18:00/);
  const t3 = await a.say("no, make it 7pm", { plan: tool("reschedule_reminder", { ref: { last: true }, when_text: "7pm", at_local: null }) });
  assert.equal(t3.reply, "Moved: call mom, today 19:00.");
  assert.deepEqual(await a.reminders(), [{ title: "call mom", local: "2026-09-21 19:00", status: "open", origin: "telegram" }]);
});

test("R5: never mind cancels the dialog with no LLM call", async () => {
  const a = agent();
  await a.say("set a reminder", { plan: cr(null, null) });
  const t = await a.say("never mind");
  assert.equal(t.llm, 0);
  assert.equal(t.reply, "OK, cancelled. Nothing was set.");
  assert.equal(t.result.trace.route, "dialog");
  assert.equal(await a.dialog(), null);
  assert.deepEqual(await a.reminders(), []);
});

test("R6: an expired dialog is ignored; PLAN treats the time as a new request", async () => {
  const a = agent();
  await a.say("remind me to pay rent", { plan: cr("pay rent", null) });
  a.clock.advance(11 * 60_000);
  const t = await a.say("in 10 min", { plan: cr(null, "10 min") });
  assert.equal(t.llm, 1);
  assert.equal(t.reply, "What should I remind you about?");
  assert.deepEqual(await a.reminders(), []);
});

test("R7/R8: 'at 6' -> next future 18:00 at 15:00, 06:00 at 05:00", async () => {
  const a = agent();
  const t = await a.say("remind me at 6 to stretch", { plan: cr("stretch", "at 6") });
  assert.match(t.reply, /stretch, today 18:00/);
  const b = agent({ at: "2026-09-20T23:30:00Z" });
  const u = await b.say("remind me at 6 to stretch", { plan: cr("stretch", "6", null) });
  assert.match(u.reply, /stretch, today 06:00/);
});

test("R9: a past time asks again, no row; R10: in 2 days at 5pm is exact", async () => {
  const a = agent();
  const t = await a.say("remind me today at 1pm to x", { plan: cr("x", "today at 1pm") });
  assert.match(t.reply, /^That time has passed\. When should I remind you to x\?/);
  assert.deepEqual(await a.reminders(), []);
  const r10 = await a.say("remind me in 2 days at 5pm to submit form", { plan: cr("submit form", "in 2 days at 5pm") });
  assert.match(r10.reply, /submit form/);
  assert.equal((await a.reminders())[0]?.local, "2026-09-23 17:00");
});

test("audit 1/7: 'parso subah' is +2 days; 'aaj shaam ko' is today 18:00", async () => {
  const a = agent();
  const p = await a.say("parso subah yaad dilana gym jana hai", { plan: cr("gym jana hai", "parso subah") });
  assert.match(p.reply, /gym jana hai, Wed 23 Sept? 09:00/);
  const s = await a.say("aaj shaam ko yaad dilana ghar jana hai", { plan: cr("ghar jana hai", "aaj shaam ko") });
  assert.equal(s.reply, "Reminder set: ghar jana hai, today 18:00.");
  assert.deepEqual((await a.reminders()).map((r) => r.local).sort(), ["2026-09-21 18:00", "2026-09-23 09:00"]);
});

test("audit 4: 'in an hour and a half' is 90 minutes, not 60", async () => {
  const a = agent();
  const t = await a.say("remind me in an hour and a half to check the oven", { plan: cr("check the oven", "in an hour and a half") });
  assert.equal(t.reply, "Reminder set: check the oven, today 16:30.");
});

test("audit 2: 'remind me at 6 call mom' -> title 'call mom', not 'at 6 call mom'", async () => {
  const a = agent();
  const t = await a.say("remind me at 6 call mom", { plan: cr("at 6 call mom", "at 6") });
  assert.equal(t.reply, "Reminder set: call mom, today 18:00.");
  assert.deepEqual(await a.reminders(), [{ title: "call mom", local: "2026-09-21 18:00", status: "open", origin: "telegram" }]);
});

test("audit 5: a bare hour after a date word asks am/pm instead of defaulting to 09:00", async () => {
  const a = agent();
  const t = await a.say("remind me next friday 5 to call the bank", { plan: cr("call the bank", "next friday 5") });
  assert.equal(t.reply, "Did you mean friday 5 am or friday 5 pm?");
  assert.deepEqual(await a.reminders(), []);
  assert.match(t.result.trace.flags ?? "", /ambiguous_hour/);
  const done = await a.say("next friday 5pm");
  assert.equal(done.llm, 0);
  assert.match(done.reply, /^Reminder set: call the bank, Fri 25 Sept? 17:00\.$/);
  // an unambiguous hour is untouched
  const b = agent();
  const u = await b.say("remind me tomorrow 9am to stretch", { plan: cr("stretch", "tomorrow 9am") });
  assert.match(u.reply, /stretch, tomorrow 09:00/);
});

test("audit 9: 'snooze 90' is 90 minutes, and 'snooze 90m' snoozes the reminder just set", async () => {
  const a = agent();
  await a.say("remind me in 5 min to stretch", { plan: cr("stretch", "in 5 min") });
  const m = await a.say("snooze 90m"); // uses dialog.lastAction, like bare cancel
  assert.equal(m.llm, 0);
  assert.equal(m.reply, "Snoozed: stretch until 16:30.");
  const b = agent();
  await b.say("remind me in 5 min to stretch", { plan: cr("stretch", "in 5 min") });
  const n = await b.say("snooze 90"); // no item 90 in any list: the bare number is minutes, not an index
  assert.equal(n.llm, 0);
  assert.equal(n.reply, "Snoozed: stretch until 16:30.");
});

test("audit 3: a mutating tool before a read still composes the read", async () => {
  const a = agent({ seed: { involvement: { login: "me", assignedIssues: [{ repo: "o/r", number: 1, title: "fix it", url: "u", updatedAt: "2026-09-20T00:00:00Z", state: "open" }], myOpenPrs: [], reviewRequests: [], mentions: [], recentRepos: [], totals: { assignedIssues: 1, myOpenPrs: 0, reviewRequests: 0, mentions: 0 }, fetchedAt: AT, partial: [] } } });
  const plan = {
    intent: "create_reminder",
    tools: [
      { name: "create_reminder", args: { what: "stretch", when_text: "in 5 min", at_local: null } },
      { name: "github_involvement", args: { bucket: "all" } },
    ],
    say: "", compose: false,
  };
  const t = await a.say("remind me in 5 min to stretch and tell me everything on github", { plan, compose: "One issue is assigned to you." });
  assert.equal(t.result.trace.route, "plan+compose");
  assert.match(t.reply, /^Reminder set: stretch, today 15:05 \(in 5 min\)\.\nOne issue is assigned to you\.$/);
});

test("audit 10: a plan whose every tool is unknown is unsupported, not an empty-args tool", async () => {
  const a = agent();
  const plan = { intent: "add_tasks", tools: [{ name: "send_email", args: { to: "bob" } }], say: "", compose: false };
  const t = await a.say("email bob about the wifi", { plan });
  assert.notEqual(t.reply, "Which tasks should I add?");
  assert.equal(t.result.trace.intent, "unsupported");
  assert.match(t.result.trace.flags ?? "", /all_tools_dropped/);
  assert.deepEqual(await a.tasks(), []);
});

test("audit 12: a smalltalk reply may echo the user's own digits", async () => {
  const a = agent();
  const t = await a.say("is 6pm too late to call?", { plan: talk("smalltalk", "6pm sounds fine to me.") });
  assert.equal(t.reply, "6pm sounds fine to me.");
  const u = await a.say("how are things", { plan: talk("smalltalk", "You have 3 tasks left.") }); // invented digit: dropped
  assert.equal(u.reply, "Hi! What can I do for you?");
});

test("audit 14: the plan retry differs from the first attempt", async () => {
  const a = agent();
  const t = await a.say("what are today's tasks", { plan: ["not json at all", tool("list_tasks", { day: "today", include_done: false })] });
  assert.equal(t.llm, 2);
  assert.equal(t.reply, "No tasks for today.");
  const [first, second] = a.sb.calls;
  assert.ok(!first!.prompt.includes("not valid JSON"));
  assert.match(second!.prompt, /Your previous output was not valid JSON\. Output ONLY the JSON object\.$/);
  assert.equal(first!.temperature, 0);
  assert.equal(second!.temperature, 0.3);
});

test("audit 15 + D: greetings, acks and the agenda cost 0 LLM calls", async () => {
  const a = agent({ seed: { tasks: ["buy milk"], deadlines: [{ id: "x", title: "call mom", dueAt: "2026-09-21T12:30:00Z", source: "chat" }] } });
  for (const [text, reply] of [["hi", "Good afternoon! What can I do for you?"], ["thx", "Anytime! Anything else?"], ["ok", "Got it."], ["👍", "Got it."], ["a", "Got it."]] as const) {
    const t = await a.say(text);
    assert.equal(t.llm, 0, text);
    assert.equal(t.result.trace.route, "fast", text);
    assert.equal(t.reply, reply, text);
  }
  const hin = await a.say("kya haal hai");
  assert.equal(hin.reply, "Good afternoon! Bataiye, kya karna hai?");
  const ag = await a.say("what's next");
  assert.equal(ag.llm, 0);
  assert.match(ag.reply, /^Your day - Monday 21 Sept?:\nTasks \(1\):\n• 1\. buy milk\nDue today \(1\):\n• call mom - today 18:00\nNext reminder: call mom, today 18:00\.$/);
  const rem = await a.say("my reminders");
  assert.equal(rem.llm, 0);
  assert.equal(rem.reply, "Upcoming reminders (1):\n• 1. call mom - today 18:00");
});

test("audit 15: an open question still owns short words like 'ok'", async () => {
  const a = agent();
  await a.say("set a reminder", { plan: cr(null, null) });
  const t = await a.say("ok", { plan: cr(null, null) });
  assert.notEqual(t.reply, "Got it."); // the dialog answers it, the greeting path does not swallow it
  assert.equal(t.result.trace.route, "plan");
});

test("audit 11 + B: a fired, auto-closed reminder is still visible today, and 'fired' is its own range", async () => {
  const a = agent({
    seed: { deadlines: [{ id: "f1", title: "take meds", dueAt: "2026-09-21T04:00:00Z", source: "chat", status: "done" }] },
  });
  const t = await a.say("which reminders did I have today", { plan: tool("list_reminders", { range: "today" }) });
  assert.equal(t.reply, "Reminders today (1):\n• 1. take meds - today 09:30 (done)");
  const h = await a.say("what did you remind me today", { plan: tool("list_reminders", { range: "fired" }) });
  assert.equal(h.reply, "I reminded you today about (1):\n• 1. take meds - today 09:30 (done)");
  const b = agent();
  const none = await b.say("what did you remind me today", { plan: tool("list_reminders", { range: "fired" }) });
  assert.equal(none.reply, "I didn't remind you about anything today.");
});

test("audit A: 'note that ...' saves a note under Inbox/ and search_notes finds it", async () => {
  const a = agent();
  const t = await a.say("note that the wifi is hunter2", { plan: tool("add_note", { text: "the wifi is hunter2" }) });
  assert.equal(t.reply, "Noted: the wifi is hunter2");
  const files = await a.ctx.vault.listFiles();
  const path = files.find((p) => p.startsWith("Inbox/"))!;
  assert.ok(path, `no Inbox note in ${files.join(",")}`);
  assert.match((await a.ctx.vault.readFile(path))!, /the wifi is hunter2/);
  assert.ok((await a.ctx.store.listNoteIndex()).some((n) => n.path === path), "the note is indexed at once");
  const found = await a.say("what did I write about the wifi", { plan: tool("search_notes", { query: "wifi" }), compose: "The wifi password is hunter2." });
  assert.match(found.reply, /hunter2/);
  // a model-invented note body is refused, like any other mutation
  const b = agent();
  const bad = await b.say("hows the weather", { plan: tool("add_note", { text: "the wifi is hunter2" }) });
  assert.equal(bad.reply, "What should I write down?");
});

test("R11: unsupported recurring -> honest say, no rows", async () => {
  const a = agent();
  const t = await a.say("remind me every day at 9 to take meds", { plan: talk("unsupported", "I can't do recurring reminders yet.") });
  assert.equal(t.reply, "I can't do recurring reminders yet.");
  assert.deepEqual(await a.reminders(), []);
});

test("R12: topic switch answers, keeps the dialog and nudges once", async () => {
  const a = agent({ seed: { deadlines: [{ title: "essay", dueAt: "2026-09-22T03:30:00Z" }] } });
  await a.say("set a reminder", { plan: cr(null, null) });
  const t = await a.say("what's due tomorrow?", { plan: tool("list_deadlines", { range: "tomorrow" }) });
  assert.match(t.reply, /essay/);
  assert.match(t.reply, /Still want that reminder\?/);
  assert.deepEqual((await a.dialog())?.missing, ["what", "when"]);
  const again = await a.say("anything overdue?", { plan: tool("list_deadlines", { range: "overdue" }) });
  assert.equal(again.reply, "Nothing is overdue.");
});

test("R13/R14: list reminders, then cancel one by span", async () => {
  const a = agent({ seed: { deadlines: [{ id: "c1", title: "call mom", dueAt: "2026-09-21T10:00:00Z", source: "chat" }] } });
  const l = await a.say("list my reminders", { plan: tool("list_reminders", { range: "upcoming" }) });
  assert.equal(l.reply, "Upcoming reminders (1):\n• 1. call mom - today 15:30");
  const c = await a.say("cancel the call mom reminder", { plan: tool("cancel_reminder", { ref: { text: "call mom" } }) });
  assert.equal(c.reply, "Cancelled: call mom.");
  assert.equal((await a.reminders())[0]?.status, "dismissed");
});

test("two create_reminder calls in one plan -> 2 rows with distinct ids", async () => {
  const a = agent();
  const plan = {
    intent: "create_reminder",
    tools: [
      { name: "create_reminder", args: { what: "call mom", when_text: "at 6pm", at_local: null } },
      { name: "create_reminder", args: { what: "call dad", when_text: "at 7pm", at_local: null } },
    ],
    say: "",
    compose: false,
  };
  const t = await a.say("remind me to call mom at 6pm and call dad at 7pm", { plan });
  assert.equal(t.reply.split("\n").length, 2);
  assert.equal((await a.reminders()).length, 2);
});

test("E4 + E9: grounded subject is set; hallucinated subject from history becomes a question", async () => {
  const a = agent();
  const e4 = await a.say("Remind me after 2 mins to drink water", { plan: cr("drink water", "after 2 mins") });
  assert.equal(e4.reply, "Reminder set: drink water, today 15:02 (in 2 min).");
  const b = agent();
  await b.say("I might need to drink water later", { plan: talk("smalltalk", "Got it.") });
  const e9 = await b.say("Can you share a reminder of 1 min", { plan: cr("drink water", "1 min") });
  assert.equal(e9.reply, "What should I remind you about?");
  assert.match(e9.result.trace.flags ?? "", /provenance_miss:what/);
  assert.deepEqual(await b.reminders(), []);
  // the answer completes it, reusing the dialog's time
  const done = await b.say("drink water", { plan: cr("drink water", null) });
  assert.match(done.reply, /^Reminder set: drink water, today 15:01/);
});

test("I6: model-invented subject and time -> asks, no row; H-typo: 'call mum' stored as the user's words", async () => {
  const a = agent();
  const t = await a.say("remind me later", { plan: cr("call mom", "in 10 minutes") });
  assert.equal(t.reply, "What should I remind you about?");
  assert.deepEqual((await a.dialog())?.missing, ["what", "when"]);
  const b = agent();
  const u = await b.say("remnd me in 10 min to cal mom", { plan: cr("call mom", "in 10 min") });
  assert.match(u.reply, /Reminder set: cal mom, today 15:10/);
});

test("H2/H6/H10: Hinglish and shorthand times", async () => {
  const a = agent();
  const h2 = await a.say("kal subah 9 baje yaad dila dena doctor ko call karna hai", { plan: cr("doctor ko call karna", "kal subah 9 baje") });
  assert.match(h2.reply, /doctor ko call karna, tomorrow 09:00/);
  const h6 = await a.say("shaam ko 6 baje remind karna meeting", { plan: cr("meeting", null, "2026-09-21T18:00") });
  assert.match(h6.reply, /meeting, today 18:00/);
  const h10 = await a.say("plz remind me abt the dentist tmrw 5pm", { plan: cr("the dentist", "tmrw 5pm") });
  assert.match(h10.reply, /the dentist, tomorrow 17:00/);
  const h4 = await a.say("10 min baad reminder lagao chai", { plan: cr("chai", "10 min baad") });
  assert.match(h4.reply, /chai, today 15:10/);
});

test("3 unanswered questions -> gives up with a hint and clears the dialog", async () => {
  const a = agent();
  for (let i = 0; i < 3; i++) await a.say(`reminder pls ${i}`, { plan: cr(null, null) });
  const t = await a.say("reminder pls again", { plan: cr(null, null) });
  assert.match(t.reply, /^I still need what it's for\. Try: remind me at 6pm to call mom\./);
  assert.equal(await a.dialog(), null);
});

test("never mind after a completed reminder offers to cancel it; 'cancel' does it (no LLM)", async () => {
  const a = agent();
  await a.say("remind me in 5 min to stretch", { plan: cr("stretch", "in 5 min") });
  const offer = await a.say("never mind");
  assert.equal(offer.reply, "Cancel the reminder to stretch? Reply 'cancel'.");
  const c = await a.say("cancel");
  assert.equal(c.llm, 0);
  assert.equal(c.reply, "Cancelled: stretch.");
});

test("reschedule by name with no time asks when; the pure-time answer moves THAT reminder (0 LLM)", async () => {
  const a = agent({
    seed: {
      deadlines: [
        { id: "a", title: "pay rent", dueAt: "2026-09-21T12:00:00Z", source: "chat" },
        { id: "b", title: "call mom", dueAt: "2026-09-21T11:00:00Z", source: "chat" },
      ],
    },
  });
  await a.say("remind me in 5 min to stretch", { plan: cr("stretch", "in 5 min") }); // lastAction = stretch
  const q = await a.say("move the pay rent reminder", { plan: tool("reschedule_reminder", { ref: { text: "pay rent" }, when_text: null, at_local: null }) });
  assert.match(q.reply, /^When should I remind you to pay rent\?/);
  const t = await a.say("tomorrow 9am");
  assert.equal(t.llm, 0);
  assert.equal(t.reply, "Moved: pay rent, tomorrow 09:00.");
});

test("deferAfter: the reply is returned BEFORE turns are saved; after() then saves them (the Worker sends in between)", async () => {
  const { testContext } = await import("../../node/testing/context.ts");
  const { runAgent } = await import("./handle.ts");
  const ctx = testContext({ configPatch: { channels: { telegram: { enabled: true, allowedChatIds: ["42"] } } } });
  ctx.brain = { complete: async () => ({ text: '{"intent":"smalltalk","tools":[],"say":"Hi!","compose":false}', entry: "groq", model: "m", ms: 1, cached: false }) } as never;
  // not a bare greeting: greetings are answered by the fast path now (audit 15), and this test needs the plan route
  const msg = { channel: "telegram" as const, id: "1", from: "42", text: "how are things going", at: "2026-09-20T04:30:00.000Z" };
  const res = await runAgent(ctx, msg, { deferAfter: true });
  assert.equal(res.reply, "Hi!");
  assert.equal((await ctx.store.turnsForDay("telegram", "42", "2026-09-20")).length, 0, "nothing saved yet");
  await res.after!();
  assert.equal((await ctx.store.turnsForDay("telegram", "42", "2026-09-20")).length, 2);
});
