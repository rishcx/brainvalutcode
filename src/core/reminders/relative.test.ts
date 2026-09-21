import assert from "node:assert/strict";
import { test } from "node:test";
import { localTimeOf, localDateOf } from "../time.ts";
import { parseRelativeWhen } from "./relative.ts";

const TZ = "Asia/Kolkata";
const NOW = new Date("2026-09-21T10:00:20Z"); // 15:30:20 IST
const p = (t: string, now: Date = NOW) => parseRelativeWhen(t, TZ, now);
const due = (t: string, now: Date = NOW) => p(t, now)?.dueAt;

test("durations round up to the next whole minute, never early", () => {
  assert.equal(due("in 2 minutes"), "2026-09-21T10:03:00.000Z");
  assert.equal(due("Remind me after 2 mins to drink water"), "2026-09-21T10:03:00.000Z");
  assert.equal(due("within 10 min"), "2026-09-21T10:11:00.000Z");
  assert.equal(due("in 2 mins", new Date("2026-09-21T10:00:00Z")), "2026-09-21T10:02:00.000Z"); // exact minute stays exact
  assert.equal(due("in 30 seconds"), "2026-09-21T10:02:00.000Z"); // min 1 minute
  assert.equal(due("in 1 sec"), "2026-09-21T10:02:00.000Z");
});

test("units, decimals, words, compounds", () => {
  assert.equal(due("in 1.5 hours"), "2026-09-21T11:31:00.000Z");
  assert.equal(due("in an hour"), "2026-09-21T11:01:00.000Z");
  assert.equal(due("in half an hour"), "2026-09-21T10:31:00.000Z");
  assert.equal(due("in a minute"), "2026-09-21T10:02:00.000Z");
  assert.equal(due("in five minutes"), "2026-09-21T10:06:00.000Z");
  assert.equal(due("5 mins later"), "2026-09-21T10:06:00.000Z");
  assert.equal(due("10 minutes from now"), "2026-09-21T10:11:00.000Z");
  assert.equal(due("2h"), "2026-09-21T12:01:00.000Z");
  assert.equal(due("30 min"), "2026-09-21T10:31:00.000Z");
  assert.equal(due("in 1h30m"), "2026-09-21T11:31:00.000Z");
  assert.equal(due("in 1 hour and 30 minutes"), "2026-09-21T11:31:00.000Z");
  assert.equal(due("in 2 hrs"), "2026-09-21T12:01:00.000Z");
  assert.equal(due("in 3 days"), "2026-09-24T10:01:00.000Z");
  assert.equal(due("in 2 weeks"), "2026-10-05T10:01:00.000Z");
  assert.equal(due("in 5m"), "2026-09-21T10:06:00.000Z");
  assert.deepEqual(p("remind me in 10 minutes about the oven"), { dueAt: "2026-09-21T10:11:00.000Z", matched: "in 10 minutes", relative: true });
  assert.equal(p("Can you set a remaining of 2 mins")?.matched, "2 mins");
});

test("bounds and nonsense are refused", () => {
  for (const t of ["in 0 minutes", "in 0.0 hours", "in 100001 minutes", "in 400 days", "in 367 days", "5 minutes ago", "in 5 minutes ago", "for 2 hours", "v2h", "admin5m", "in 5 m", "in 1e3 minutes", "", "hello", "in the morning"]) {
    assert.equal(p(t), null, t);
  }
  assert.ok(p("in 366 days"));
  assert.equal(parseRelativeWhen("in 5 min", "Nowhere/Land", NOW)?.relative, true); // durations need no tz
  assert.equal(parseRelativeWhen("tonight", "Nowhere/Land", NOW), null); // bad zone never throws
  assert.equal(parseRelativeWhen("in 5 min", TZ, new Date(NaN)), null);
});

test("does not match inside other words and leaves clock times alone", () => {
  assert.equal(p("remind me at 5pm"), null);
  assert.equal(p("tomorrow 6pm"), null);
  assert.equal(p("tonight at 9"), null);
  assert.equal(p("in 2 days at 5pm"), null);
  assert.equal(p("thin 5 minutes")?.matched, "5 minutes"); // "thin" is not the word "in": only the bare form matches
  assert.equal(p("noonday sun"), null);
  assert.equal(p("tomorrow noon"), null);
});

test("day parts", () => {
  const at = (t: string, now: Date = NOW) => {
    const r = p(t, now);
    return r ? `${localDateOf(new Date(r.dueAt), TZ)} ${localTimeOf(new Date(r.dueAt), TZ)}` : null;
  };
  assert.equal(at("tonight"), "2026-09-21 20:00");
  assert.equal(at("this evening"), "2026-09-21 18:00");
  assert.equal(at("this afternoon"), null); // 15:00 already passed at 15:30
  assert.equal(at("this morning"), "2026-09-22 09:00"); // already past: next day
  assert.equal(at("tomorrow morning"), "2026-09-22 09:00");
  assert.equal(at("tomorrow afternoon"), "2026-09-22 15:00");
  assert.equal(at("tomorrow evening"), "2026-09-22 18:00");
  assert.equal(at("tomorrow night"), "2026-09-22 21:00");
  assert.equal(at("at noon"), "2026-09-22 12:00");
  assert.equal(at("midnight"), "2026-09-22 00:00");
  assert.equal(p("at noon")?.matched, "at noon");
  const early = new Date("2026-09-21T01:00:00Z"); // 06:30 IST
  assert.equal(at("this morning", early), "2026-09-21 09:00");
  assert.equal(at("this afternoon", early), "2026-09-21 15:00");
  assert.equal(at("noon", early), "2026-09-21 12:00");
});

test("audit 1/7: day after tomorrow and today/bare day parts", () => {
  const at = (t: string, now: Date = NOW) => {
    const r = p(t, now);
    return r ? `${localDateOf(new Date(r.dueAt), TZ)} ${localTimeOf(new Date(r.dueAt), TZ)}` : null;
  };
  // "parso subah" normalises to "day after tomorrow morning": it used to match the "tomorrow morning" tail.
  assert.equal(at("day after tomorrow morning"), "2026-09-23 09:00");
  assert.equal(at("day after tomorrow evening"), "2026-09-23 18:00");
  assert.equal(p("day after tomorrow morning")?.matched, "day after tomorrow morning");
  // "aaj shaam ko yaad dilana" normalises to "today evening": it used to fall through and read as a past time.
  assert.equal(at("today evening"), "2026-09-21 18:00");
  assert.equal(at("today night"), "2026-09-21 21:00");
  assert.equal(at("evening"), "2026-09-21 18:00"); // bare Hinglish day part ("shaam")
  assert.equal(at("night"), "2026-09-21 21:00");
  assert.equal(at("friday evening"), null); // another date word present: not today
});

test("audit 4: 'and a half' compounds", () => {
  assert.equal(due("in an hour and a half"), "2026-09-21T11:31:00.000Z");
  assert.equal(due("in 2 hours and a half"), "2026-09-21T12:31:00.000Z");
  assert.equal(due("in an hour and half"), "2026-09-21T11:31:00.000Z");
  assert.equal(due("in half an hour"), "2026-09-21T10:31:00.000Z"); // unchanged: already a pair
  assert.equal(p("in an hour and a half")?.matched, "in an hour and a half");
});

test("just before midnight and past day parts", () => {
  const late = new Date("2026-09-21T18:25:00Z"); // 23:55 IST
  const at = (t: string) => {
    const r = p(t, late);
    return r ? `${localDateOf(new Date(r.dueAt), TZ)} ${localTimeOf(new Date(r.dueAt), TZ)}` : null;
  };
  assert.equal(at("in 10 minutes"), "2026-09-22 00:05");
  assert.equal(at("midnight"), "2026-09-22 00:00");
  assert.equal(at("tonight"), null); // 20:00 already passed: the caller asks
  assert.equal(at("this evening"), null);
  assert.equal(at("this morning"), "2026-09-22 09:00");
  assert.equal(at("tomorrow morning"), "2026-09-22 09:00");
  const after = new Date("2026-09-21T18:31:00Z"); // 00:01 IST on the 22nd
  assert.equal(parseRelativeWhen("tonight", TZ, after)?.dueAt, "2026-09-22T14:30:00.000Z");
  assert.equal(parseRelativeWhen("tomorrow night", TZ, after)?.dueAt, "2026-09-23T15:30:00.000Z");
});

test("every result is strictly in the future", () => {
  for (const t of ["in 1 second", "in a minute", "noon", "midnight", "tonight", "this morning", "2h", "in 30 sec"]) {
    for (const iso of ["2026-09-21T00:00:00Z", "2026-09-21T06:29:59Z", "2026-09-21T18:29:59Z", "2026-09-21T18:30:00Z", "2026-12-31T18:29:30Z"]) {
      const now = new Date(iso);
      const r = p(t, now);
      if (r) assert.ok(new Date(r.dueAt).getTime() > now.getTime(), `${t} @ ${iso}`);
    }
  }
});
