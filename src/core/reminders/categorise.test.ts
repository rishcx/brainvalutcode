import assert from "node:assert/strict";
import { test } from "node:test";
import { testContext } from "../../node/testing/context.ts";
import { dueAtFromLocalDate } from "../time.ts";
import { completePending, extractHashtag, proposeReminder } from "./categorise.ts";
import { categorise } from "./rules.ts";

const TZ = "Asia/Kolkata";
const rules = testContext().config.reminders.rules;
const NOW = new Date("2026-09-21T09:00:00Z"); // 14:30 IST
const d = (title: string, source: "github" | "gmail" | "manual" | "chat" = "manual", category?: string) =>
  ({ title, sourceRef: "", source, category });

test("explicit category beats keywords; unknown explicit falls through", () => {
  assert.equal(categorise(d("flight x", "manual", "assignment"), rules), "assignment");
  assert.equal(categorise(d("flight x", "manual", "zzz"), rules), "flight");
  assert.equal(categorise(d("renew insurance", "manual", "zzz"), rules), "default");
  assert.equal(categorise(d("renew insurance", "manual", "default"), rules), "default");
});

test("source-bound rules", () => {
  assert.equal(categorise(d("flight", "github"), rules), "github");
  assert.equal(categorise(d("flight", "gmail"), rules), "flight");
  assert.equal(categorise(d("Ship v1", "gmail"), rules), "default");
  const tie = [
    { id: "b", offsets: [], keywords: ["x"] },
    { id: "a", offsets: [], keywords: ["x"] },
  ];
  assert.equal(categorise(d("x"), tie), "b");
});

test("extra text is searched case-insensitively", () => {
  assert.equal(categorise(d("Your trip"), rules, "IndiGo <a@b.c> Web check-in: Boarding Pass"), "flight");
});

test("extractHashtag only strips known tags", () => {
  assert.deepEqual(extractHashtag("pay rent #assignment tomorrow", rules), { text: "pay rent tomorrow", category: "assignment" });
  assert.deepEqual(extractHashtag("pay #nope x", rules), { text: "pay #nope x", category: null });
});

test("flight tomorrow 6pm is a timed relative flight", () => {
  const p = proposeReminder("I have a flight tomorrow 6pm", rules, TZ, NOW, 9);
  assert.ok(p.ok);
  assert.equal(p.category, "flight");
  assert.equal(p.dueAt, "2026-09-22T12:30:00.000Z");
  assert.equal(p.timed, true);
  assert.equal(p.relative, true);
  assert.equal(p.title, "flight");
});

test("flight without a time asks; a bare time completes it", () => {
  const p = proposeReminder("I have a flight on 4 Oct", rules, TZ, NOW, 9);
  assert.ok(!p.ok && p.reason === "needs-time");
  assert.match(p.ask, /what time/);
  assert.equal(p.pending.date, "2026-10-04");
  const done = completePending(p.pending, "6pm", rules, TZ, NOW, 9);
  assert.ok(done);
  assert.equal(done.timed, true);
  assert.equal(done.dueAt, "2026-10-04T12:30:00.000Z");
  assert.equal(completePending(p.pending, "banana", rules, TZ, NOW, 9), null);
});

test("date-only remind stays 09:00 local; numeric dates refused; #tag wins", () => {
  const p = proposeReminder("remind me to renew insurance on 1 Nov 2026", rules, TZ, NOW, 9);
  assert.ok(p.ok);
  assert.equal(p.category, "default");
  assert.equal(p.title, "renew insurance");
  assert.equal(p.dueAt, dueAtFromLocalDate("2026-11-01", TZ, 9));
  assert.equal(p.timed, false);
  assert.deepEqual(proposeReminder("remind me to renew insurance on 01/10/2026", rules, TZ, NOW, 9), { ok: false, reason: "no-date" });
  const t = proposeReminder("pay rent #assignment tomorrow", rules, TZ, NOW, 9);
  assert.ok(t.ok);
  assert.equal(t.category, "assignment");
});
