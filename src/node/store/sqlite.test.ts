import assert from "node:assert/strict";
import { test } from "node:test";
import { FixedClock } from "../../core/clock.ts";
import type { Deadline, DialogState, NewChatTurn, NewTrace, NoteIndexRow, Task } from "../../core/types.ts";
import { SqliteStore } from "./sqlite.ts";

const clock = new FixedClock("2026-09-20T04:30:00Z", "Asia/Kolkata");
const open = (): SqliteStore => new SqliteStore(":memory:", clock);

const dl = (id: string, dueAt: string, status: Deadline["status"] = "open"): Deadline => ({
  id, source: "github", sourceRef: "u", title: id, dueAt, status, confidence: 1, notePath: "GitHub/x.md",
});

test("store keeps human-set done status across re-polls, updates due dates", async () => {
  const s = open();
  await s.upsertDeadline(dl("a", "2026-10-01T00:00:00Z"));
  await s.upsertDeadline(dl("b", "2026-10-02T00:00:00Z"));
  await s.upsertDeadline({ ...dl("a", "2026-10-05T00:00:00Z"), status: "done" });
  await s.upsertDeadline(dl("a", "2026-10-09T00:00:00Z")); // re-poll says open again
  const a = await s.getDeadline("a");
  assert.equal(a!.status, "done");
  assert.equal(a!.dueAt, "2026-10-09T00:00:00Z");
  assert.equal((await s.listDeadlines()).length, 2);
  await s.close();
});

test("listDeadlines filters by status and orders by due date", async () => {
  const s = open();
  await s.upsertDeadline(dl("late", "2026-10-09T00:00:00Z"));
  await s.upsertDeadline(dl("early", "2026-10-01T00:00:00Z"));
  await s.upsertDeadline(dl("prop", "2026-10-02T00:00:00Z", "proposed"));
  assert.deepEqual((await s.listDeadlines()).map((d) => d.id), ["early", "prop", "late"]);
  assert.deepEqual((await s.listDeadlines({ status: ["open"] })).map((d) => d.id), ["early", "late"]);
  assert.deepEqual(await s.listDeadlines({ status: [] }), []);
  await s.setDeadlineStatus("prop", "open");
  assert.equal((await s.getDeadline("prop"))!.status, "open");
  await s.close();
});

test("markStale only touches its own prefix, spares terminal rows, and ignores LIKE wildcards", async () => {
  const s = open();
  await s.upsertDeadline(dl("gh:milestone:me/a_b:1", "2026-10-01T00:00:00Z"));
  await s.upsertDeadline(dl("gh:milestone:me/a_b:2", "2026-10-02T00:00:00Z"));
  await s.upsertDeadline(dl("gh:milestone:me/axb:9", "2026-10-03T00:00:00Z")); // LIKE '_' would match this
  await s.upsertDeadline(dl("gh:milestone:me/other:1", "2026-10-04T00:00:00Z"));
  await s.upsertDeadline({ ...dl("gh:milestone:me/a_b:3", "2026-10-05T00:00:00Z"), status: "done" });

  const staled = await s.markStale("gh:milestone:me/a_b:", ["gh:milestone:me/a_b:1"]);
  assert.equal(staled, 1); // :2 only — :3 is done, the others are out of scope
  const byId = new Map((await s.listDeadlines()).map((d) => [d.id, d.status]));
  assert.equal(byId.get("gh:milestone:me/a_b:1"), "open");
  assert.equal(byId.get("gh:milestone:me/a_b:2"), "stale");
  assert.equal(byId.get("gh:milestone:me/a_b:3"), "done");
  assert.equal(byId.get("gh:milestone:me/axb:9"), "open");
  assert.equal(byId.get("gh:milestone:me/other:1"), "open");

  // An empty present-list stales everything still live under the prefix.
  assert.equal(await s.markStale("gh:milestone:me/other:", []), 1);
  await s.close();
});

test("reminders are unique per (deadline, kind), re-materialise idempotently and never resend", async () => {
  const s = open();
  await s.upsertReminder({ deadlineId: "a", kind: "24h", fireAt: "2026-09-30T03:30:00Z" });
  await s.upsertReminder({ deadlineId: "a", kind: "24h", fireAt: "2026-09-30T03:30:00Z" });
  await s.upsertReminder({ deadlineId: "a", kind: "0", fireAt: "2026-10-01T03:30:00Z" });
  assert.equal((await s.listReminders("a")).length, 2);

  assert.deepEqual((await s.dueReminders("2026-09-29T00:00:00Z")).map((r) => r.kind), []);
  const due = await s.dueReminders("2026-09-30T04:00:00Z");
  assert.deepEqual(due.map((r) => r.kind), ["24h"]);

  await s.markRemindersSent(due.map((r) => r.id), "2026-09-30T04:00:00Z");
  assert.deepEqual(await s.dueReminders("2026-09-30T04:00:00Z"), []);
  // A later poll re-materialises the same reminder: it must NOT fire twice.
  await s.upsertReminder({ deadlineId: "a", kind: "24h", fireAt: "2026-09-30T03:30:00Z" });
  assert.deepEqual(await s.dueReminders("2026-09-30T04:00:00Z"), []);

  await s.deleteUnsentReminders("a");
  assert.deepEqual((await s.listReminders("a")).map((r) => r.kind), ["24h"]); // the sent one survives
  await s.close();
});

test("markProcessed is the webhook idempotency gate", async () => {
  const s = open();
  assert.equal(await s.markProcessed("wamid.1", "2026-09-20T04:30:00Z"), true);
  assert.equal(await s.markProcessed("wamid.1", "2026-09-20T04:31:00Z"), false);
  assert.equal(await s.markProcessed("wamid.2", "2026-09-20T04:31:00Z"), true);
  await s.close();
});

test("cache expires by the caller's clock and purges", async () => {
  const s = open();
  await s.cacheSet("k", "v", "2026-09-21T00:00:00Z");
  assert.equal(await s.cacheGet("k", "2026-09-20T00:00:00Z"), "v");
  assert.equal(await s.cacheGet("k", "2026-09-21T00:00:00Z"), null); // expiry is exclusive
  assert.equal(await s.cacheGet("missing", "2026-09-20T00:00:00Z"), null);
  await s.cacheSet("k", "v2", "2026-09-22T00:00:00Z");
  assert.equal(await s.cacheGet("k", "2026-09-21T00:00:00Z"), "v2");
  assert.equal(await s.cachePurge("2026-09-23T00:00:00Z"), 1);
  await s.close();
});

test("kv round-trips and overwrites", async () => {
  const s = open();
  assert.equal(await s.kvGet("gmail:historyId"), null);
  await s.kvSet("gmail:historyId", "123", "2026-09-20T04:30:00Z");
  await s.kvSet("gmail:historyId", "456", "2026-09-20T04:31:00Z");
  assert.equal(await s.kvGet("gmail:historyId"), "456");
  await s.close();
});

test("jobs table: ensureJob never moves an existing schedule, dueJobs respects it", async () => {
  const s = open();
  await s.ensureJob("poll:github", "2026-09-20T00:00:00Z");
  await s.ensureJob("poll:github", "2030-01-01T00:00:00Z"); // must not push it into the future
  await s.ensureJob("digest:daily", "2026-09-21T00:00:00Z");
  assert.deepEqual((await s.dueJobs("2026-09-20T04:30:00Z")).map((j) => j.name), ["poll:github"]);

  await s.recordJobRun("poll:github", "2026-09-20T04:30:00Z", "ok", "repos=3");
  await s.setJobNextRun("poll:github", "2026-09-20T05:30:00Z");
  const row = await s.getJob("poll:github");
  assert.equal(row!.lastStatus, "ok");
  assert.equal(row!.lastDetail, "repos=3");
  assert.equal(row!.nextRunAt, "2026-09-20T05:30:00Z");
  assert.deepEqual(await s.dueJobs("2026-09-20T04:30:00Z"), []);
  assert.deepEqual((await s.listJobs()).map((j) => j.name), ["digest:daily", "poll:github"]);
  assert.equal(await s.getJob("nope"), null);
  await s.close();
});

const task = (id: string, dueDate: string, over: Partial<Task> = {}): Task => ({
  id, title: id, status: "open", dueDate, createdDate: dueDate, firstDate: dueDate, rollCount: 0,
  doneAt: null, recurrence: null, source: "chat", notePath: "Tasks/index.md", ...over,
});

const turn = (i: number, over: Partial<NewChatTurn> = {}): NewChatTurn => ({
  channel: "telegram", peer: "p1", localDate: "2026-09-20", role: "user", text: `m${i}`,
  at: new Date(Date.UTC(2026, 8, 20, 0, 0, i)).toISOString(), ...over,
});

test("rollOpenTasks moves only open tasks, bumps rollCount, keeps firstDate", async () => {
  const s = open();
  await s.upsertTask(task("t:a", "2026-09-20"));
  await s.upsertTask(task("t:done", "2026-09-20", { status: "done", doneAt: "2026-09-20T05:00:00Z" }));
  await s.upsertTask(task("t:drop", "2026-09-20", { status: "dropped" }));
  await s.upsertTask(task("t:tpl", "2026-09-20", { status: "template", recurrence: "daily" }));
  await s.upsertTask(task("t:today", "2026-09-21"));
  assert.equal(await s.rollOpenTasks("2026-09-21", "2026-09-21T03:00:00Z"), 1);
  const a = (await s.getTask("t:a"))!;
  assert.equal(a.dueDate, "2026-09-21");
  assert.equal(a.rollCount, 1);
  assert.equal(a.firstDate, "2026-09-20");
  for (const id of ["t:done", "t:drop", "t:tpl"]) {
    const t = (await s.getTask(id))!;
    assert.equal(t.dueDate, "2026-09-20");
    assert.equal(t.rollCount, 0);
  }
  assert.equal((await s.getTask("t:today"))!.rollCount, 0);
  await s.close();
});

test("upsertTask keeps createdDate and firstDate; listTasks filters and orders", async () => {
  const s = open();
  await s.upsertTask(task("t:b", "2026-09-20"));
  await s.upsertTask(task("t:b", "2026-09-25", { title: "renamed", createdDate: "2026-09-25", firstDate: "2026-09-25", rollCount: 2 }));
  const b = (await s.getTask("t:b"))!;
  assert.equal(b.createdDate, "2026-09-20");
  assert.equal(b.firstDate, "2026-09-20");
  assert.equal(b.title, "renamed");
  assert.equal(b.dueDate, "2026-09-25");
  assert.equal(b.rollCount, 2);
  await s.upsertTask(task("t:a", "2026-09-20"));
  await s.upsertTask(task("t:c", "2026-09-22", { status: "done" }));
  assert.deepEqual((await s.listTasks()).map((t) => t.id), ["t:a", "t:c", "t:b"]);
  assert.deepEqual((await s.listTasks({ dueDate: "2026-09-22" })).map((t) => t.id), ["t:c"]);
  assert.deepEqual((await s.listTasks({ dueOnOrBefore: "2026-09-22" })).map((t) => t.id), ["t:a", "t:c"]);
  // dueDate wins when both are given.
  assert.deepEqual((await s.listTasks({ dueDate: "2026-09-20", dueOnOrBefore: "2026-09-30" })).map((t) => t.id), ["t:a"]);
  assert.deepEqual((await s.listTasks({ status: ["open"] })).map((t) => t.id), ["t:a", "t:b"]);
  assert.deepEqual(await s.listTasks({ status: [] }), []);
  await s.setTaskStatus("t:a", "done", "2026-09-20T06:00:00Z");
  assert.equal((await s.getTask("t:a"))!.doneAt, "2026-09-20T06:00:00Z");
  await s.setTaskStatus("t:a", "open", null);
  assert.equal((await s.getTask("t:a"))!.doneAt, null);
  assert.equal(await s.getTask("nope"), null);
  await s.close();
});

test("appendTurn caps a peer/day at 200 newest rows", async () => {
  const s = open();
  for (let i = 0; i < 205; i++) await s.appendTurn(turn(i));
  await s.appendTurn(turn(0, { peer: "p2" }));
  const rows = await s.turnsForDay("telegram", "p1", "2026-09-20");
  assert.equal(rows.length, 200);
  assert.equal(rows[0]!.text, "m5");
  assert.equal(rows.at(-1)!.text, "m204");
  assert.equal((await s.turnsForDay("telegram", "p2", "2026-09-20")).length, 1);
  await s.close();
});

test("turnsForDay is per-day and chronological; purgeTurnsBefore is strict", async () => {
  const s = open();
  await s.appendTurn(turn(2, { text: "second" }));
  await s.appendTurn(turn(1, { text: "first" }));
  await s.appendTurn(turn(0, { localDate: "2026-09-19", text: "old" }));
  await s.appendTurn(turn(0, { localDate: "2026-09-21", text: "new" }));
  assert.deepEqual((await s.turnsForDay("telegram", "p1", "2026-09-20")).map((t) => t.text), ["first", "second"]);
  assert.equal(await s.purgeTurnsBefore("2026-09-20"), 1);
  assert.equal((await s.turnsForDay("telegram", "p1", "2026-09-19")).length, 0);
  assert.equal((await s.turnsForDay("telegram", "p1", "2026-09-20")).length, 2);
  assert.equal((await s.turnsForDay("telegram", "p1", "2026-09-21")).length, 1);
  await s.close();
});

test("note index: list omits excerpts, upsert replaces, excerpts and deletes are targeted", async () => {
  const s = open();
  const n = (path: string, sha: string): NoteIndexRow => ({ path, sha, title: path, tokens: "a b", excerpt: `ex ${path}`, updatedAt: "2026-09-20T00:00:00Z" });
  await s.upsertNote(n("b.md", "1"));
  await s.upsertNote(n("a.md", "1"));
  await s.upsertNote(n("b.md", "2"));
  const list = await s.listNoteIndex();
  assert.deepEqual(list.map((x) => [x.path, x.sha]), [["a.md", "1"], ["b.md", "2"]]);
  assert.equal("excerpt" in list[0]!, false);
  assert.deepEqual((await s.getNoteExcerpts(["b.md", "zzz.md"])).map((x) => x.excerpt), ["ex b.md"]);
  assert.equal(await s.deleteNotes(["a.md", "zzz.md"]), 1);
  assert.deepEqual((await s.listNoteIndex()).map((x) => x.path), ["b.md"]);
  await s.close();
});

test("deadline category and timed round-trip; absent means default/false", async () => {
  const s = open();
  await s.upsertDeadline(dl("x", "2026-10-01T00:00:00Z"));
  await s.upsertDeadline({ ...dl("y", "2026-10-02T00:00:00Z"), category: "flight", timed: true });
  const x = (await s.getDeadline("x"))!;
  assert.equal(x.category, "default");
  assert.equal(x.timed, false);
  const y = (await s.getDeadline("y"))!;
  assert.equal(y.category, "flight");
  assert.equal(y.timed, true);
  await s.close();
});

const V3 = "";

/* ------------------------------------------------------------------ v3 (V3-0) contract */

const v3Trace = (i: number, at: string): NewTrace => ({
  at, localDate: "2026-09-20", kind: "inbound", channel: "telegram", peer: "p1", msgKey: `telegram:${i}`,
  route: "plan", intent: "list_tasks", toolsJson: '[{"name":"list_tasks","ok":true}]', llmCalls: 1, model: "m",
  provider: "groq", replyChars: 10, replyPreview: `reply ${i}`, delivery: "ok", latencyMs: 812, stagesJson: '{"plan":600}',
  flags: null, error: null,
});

const v3Dialog = (over: Partial<DialogState> = {}): Omit<DialogState, "version"> => ({
  channel: "whatsapp", peer: "9199", intent: "create_reminder",
  slots: { what: "call mom", timed: true, ref: { last: true } }, missing: ["when"], asked: "when",
  sources: ["set a reminder", "call mom"], lastAction: { tool: "create_reminder", id: "chat:1:0", title: "x", at: "2026-09-20T04:20:00Z" },
  questions: 1, expiresAt: "2026-09-20T04:40:00.000Z", updatedAt: "2026-09-20T04:30:00.000Z", ...over,
});

test(`${V3}legacy rows read back originChannel null and attempts 0`, async () => {
  const s = open();
  await s.upsertDeadline(dl("a", "2026-10-01T00:00:00Z"));
  const a = (await s.getDeadline("a"))!;
  assert.equal(a.originChannel, null);
  assert.equal(a.originPeer, null);
  await s.upsertReminder({ deadlineId: "a", kind: "0", fireAt: "2026-10-01T00:00:00Z" });
  const r = (await s.listReminders("a"))[0]!;
  assert.equal(r.attempts, 0);
  assert.equal(r.claimedAt, null);
  assert.equal(r.lastError, null);
  await s.close();
});

test(`${V3}deadline origin round-trips; an upsert without origin keeps it (COALESCE)`, async () => {
  const s = open();
  await s.upsertDeadline({ ...dl("chat:1", "2026-10-01T00:00:00Z"), source: "chat", originChannel: "whatsapp", originPeer: "9199" });
  await s.upsertDeadline({ ...dl("chat:1", "2026-10-02T00:00:00Z"), source: "chat" }); // re-upsert, no origin
  let d = (await s.getDeadline("chat:1"))!;
  assert.equal(d.originChannel, "whatsapp");
  assert.equal(d.originPeer, "9199");
  assert.equal(d.dueAt, "2026-10-02T00:00:00Z");
  await s.upsertDeadline({ ...dl("chat:1", "2026-10-02T00:00:00Z"), originChannel: "telegram", originPeer: "111" });
  d = (await s.getDeadline("chat:1"))!;
  assert.deepEqual([d.originChannel, d.originPeer], ["telegram", "111"]);
  assert.equal((await s.listDeadlines())[0]!.originChannel, "telegram");
  await s.close();
});

test(`${V3}dialog: JSON round-trip, insert-if-absent, CAS on version, expiry takeover, clear`, async () => {
  const s = open();
  assert.equal(await s.getDialog("whatsapp", "9199"), null);
  assert.equal(await s.putDialog(v3Dialog(), null), true);
  const got = (await s.getDialog("whatsapp", "9199"))!;
  assert.deepEqual(got, { ...v3Dialog(), version: 1 }); // a fresh insert stores version 1
  assert.equal(await s.getDialog("telegram", "9199"), null); // keyed by (channel, peer)

  // null over an unexpired row is a conflict.
  assert.equal(await s.putDialog(v3Dialog({ intent: "add_tasks" }), null), false);
  // Two writers holding version 1: exactly one wins.
  const w1 = await s.putDialog(v3Dialog({ questions: 2 }), 1);
  const w2 = await s.putDialog(v3Dialog({ questions: 3 }), 1);
  assert.deepEqual([w1, w2], [true, false]);
  let row = (await s.getDialog("whatsapp", "9199"))!;
  assert.equal(row.version, 2);
  assert.equal(row.questions, 2);
  assert.equal(await s.putDialog(v3Dialog(), 7), false); // wrong version

  // Expired (expires_at <= updatedAt): null takes it over and bumps the version.
  const later = v3Dialog({ intent: "idle", missing: [], asked: null, lastAction: null, updatedAt: "2026-09-20T04:40:00.000Z", expiresAt: "2026-09-20T04:50:00.000Z" });
  assert.equal(await s.putDialog(later, null), true);
  row = (await s.getDialog("whatsapp", "9199"))!;
  assert.deepEqual(row, { ...later, version: 3 });

  await s.clearDialog("whatsapp", "9199");
  assert.equal(await s.getDialog("whatsapp", "9199"), null);
  await s.close();
});

test(`${V3}trace: newest first, limit clamped 1..200, purge is strict`, async () => {
  const s = open();
  await s.appendTrace(v3Trace(1, "2026-09-01T00:00:00Z"));
  await s.appendTrace(v3Trace(2, "2026-09-10T00:00:00Z"));
  await s.appendTrace({ ...v3Trace(3, "2026-09-20T00:00:00Z"), kind: "reminder", msgKey: null, intent: null, error: "boom" });
  const rows = await s.listTrace(2);
  assert.deepEqual(rows.map((r) => r.msgKey), [null, "telegram:2"]);
  assert.equal(rows[0]!.error, "boom");
  assert.equal(typeof rows[0]!.id, "number");
  const { id: _id, ...rest } = rows[1]!;
  assert.deepEqual(rest, v3Trace(2, "2026-09-10T00:00:00Z"));
  assert.equal((await s.listTrace(0)).length, 1);
  assert.equal((await s.listTrace(-5)).length, 1);
  for (let i = 0; i < 200; i++) await s.appendTrace(v3Trace(10 + i, "2026-09-20T01:00:00Z"));
  assert.equal((await s.listTrace(1000)).length, 200);
  assert.equal(await s.purgeTraceBefore("2026-09-10T00:00:00Z"), 1); // strictly before
  assert.equal(await s.purgeTraceBefore("2026-09-10T00:00:00Z"), 0);
  await s.close();
});

test(`${V3}claimReminders is exclusive, stale claims can be re-won, finishReminder needs the claim`, async () => {
  const s = open();
  for (const k of ["a", "b", "c"]) await s.upsertReminder({ deadlineId: k, kind: "0", fireAt: "2026-09-20T04:00:00Z" });
  const ids = (await s.dueReminders("2026-09-20T04:30:00Z")).map((r) => r.id);
  assert.equal(ids.length, 3);
  const now = "2026-09-20T04:30:00.000Z";
  const stale = "2026-09-20T04:25:00.000Z";
  assert.deepEqual(await s.claimReminders([], "x", now, stale), []);
  const a = await s.claimReminders(ids.slice(0, 2), "tok-a", now, stale);
  const b = await s.claimReminders(ids, "tok-b", now, stale);
  assert.deepEqual(a, ids.slice(0, 2));
  assert.deepEqual(b, [ids[2]]); // disjoint
  assert.equal((await s.listReminders("a"))[0]!.claimedAt, now);

  // Wrong claim: no-op either way.
  await s.finishReminder(ids[0]!, "tok-b", { sentAt: now });
  await s.finishReminder(ids[0]!, "tok-b", { error: "nope" });
  let ra = (await s.listReminders("a"))[0]!;
  assert.deepEqual([ra.sentAt, ra.attempts, ra.lastError], [null, 0, null]);

  // Success marks sent; a sent row can never be claimed again.
  await s.finishReminder(ids[0]!, "tok-a", { sentAt: now });
  assert.equal((await s.listReminders("a"))[0]!.sentAt, now);
  assert.deepEqual(await s.claimReminders([ids[0]!], "tok-z", "2026-09-21T00:00:00.000Z", "2026-09-20T23:00:00.000Z"), []);

  // Failure releases the claim, counts the attempt, keeps a capped error.
  await s.finishReminder(ids[1]!, "tok-a", { error: "x".repeat(500) });
  const rb = (await s.listReminders("b"))[0]!;
  assert.deepEqual([rb.sentAt, rb.claimedAt, rb.attempts, rb.lastError!.length], [null, null, 1, 200]);
  assert.deepEqual(await s.claimReminders([ids[1]!], "tok-c", now, stale), [ids[1]]); // released -> claimable

  // A live claim cannot be taken; once older than staleBefore it can.
  assert.deepEqual(await s.claimReminders([ids[2]!], "tok-d", now, stale), []);
  assert.deepEqual(await s.claimReminders([ids[2]!], "tok-e", "2026-09-20T04:40:00.000Z", "2026-09-20T04:35:00.000Z"), [ids[2]]);
  await s.finishReminder(ids[2]!, "tok-b", { sentAt: now }); // the stale holder lost it
  assert.equal((await s.listReminders("c"))[0]!.sentAt, null);
  ra = (await s.listReminders("a"))[0]!;
  assert.equal(ra.attempts, 0);
  await s.close();
});

test(`${V3}bumpUsage adds counters; optional fields overwrite only when provided`, async () => {
  const s = open();
  const key = { day: "2026-09-20", provider: "groq", model: "qwen/qwen3.8-27b" };
  assert.deepEqual(await s.getUsage("2026-09-20"), []);
  await s.bumpUsage({ ...key, requests: 1, tokensIn: 100, tokensOut: 20, rateLimited: 0, remainingReq: 999, resetAt: "2026-09-21T00:00:00Z", atIso: "2026-09-20T04:30:00Z" });
  await s.bumpUsage({ ...key, requests: 1, tokensIn: 50, tokensOut: 5, rateLimited: 1, cooldownUntil: "2026-09-20T04:31:00Z", atIso: "2026-09-20T04:30:30Z" });
  await s.bumpUsage({ ...key, day: "2026-09-19", requests: 7, tokensIn: 0, tokensOut: 0, rateLimited: 0, atIso: "2026-09-19T04:00:00Z" });
  let [u] = await s.getUsage("2026-09-20");
  assert.deepEqual(u, {
    ...key, requests: 2, tokensIn: 150, tokensOut: 25, rateLimited: 1, remainingReq: 999, remainingTok: null,
    cooldownUntil: "2026-09-20T04:31:00Z", resetAt: "2026-09-21T00:00:00Z", updatedAt: "2026-09-20T04:30:30Z",
  });
  // An explicit null clears; undefined keeps.
  await s.bumpUsage({ ...key, requests: 0, tokensIn: 0, tokensOut: 0, rateLimited: 0, cooldownUntil: null, remainingReq: 0, atIso: "2026-09-20T04:32:00Z" });
  [u] = await s.getUsage("2026-09-20");
  assert.deepEqual([u!.cooldownUntil, u!.remainingReq, u!.resetAt, u!.requests], [null, 0, "2026-09-21T00:00:00Z", 2]);
  await s.bumpUsage({ ...key, model: "openai/gpt-oss-20b", requests: 1, tokensIn: 1, tokensOut: 1, rateLimited: 0, atIso: "2026-09-20T04:33:00Z" });
  assert.deepEqual((await s.getUsage("2026-09-20")).map((r) => r.model), ["openai/gpt-oss-20b", "qwen/qwen3.8-27b"]);
  await s.close();
});
