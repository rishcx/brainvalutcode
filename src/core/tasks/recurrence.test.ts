import assert from "node:assert/strict";
import { test } from "node:test";
import { FixedClock } from "../clock.ts";
import { localDate } from "../time.ts";
import { parseRecurrence, recurrenceMatches } from "./recurrence.ts";

test("parseRecurrence canonical table", () => {
  const t: Array<[string, string | null]> = [
    ["daily", "daily"], ["Every Day", "daily"], ["weekdays", "weekdays"], ["every weekday", "weekdays"],
    ["every monday", "weekly:MO"], ["every mon", "weekly:MO"], ["weekly on monday", "weekly:MO"],
    ["every mon, wed and fri", "weekly:MO,WE,FR"], ["every fri, mon, mon", "weekly:MO,FR"],
    ["every friday", "weekly:FR"], ["every sun", "weekly:SU"],
    ["every mon, tue, wed, thu and fri", "weekly:MO,TU,WE,TH,FR"],
    ["every mon tue wed thu fri sat sun", "daily"],
    ["weekly:WE,MO", "weekly:MO,WE"], ["weekly:XX", null],
    ["weekly", null], ["every blursday", null], ["every other monday", null], ["", null], ["every", null],
  ];
  for (const [i, o] of t) assert.equal(parseRecurrence(i), o, i);
});

test("weekly:MO,WE matches Mon and Wed, not Tue (PLAN 14)", () => {
  assert.ok(recurrenceMatches("weekly:MO,WE", "2026-09-21"));
  assert.ok(recurrenceMatches("weekly:MO,WE", "2026-09-23"));
  assert.ok(!recurrenceMatches("weekly:MO,WE", "2026-09-22"));
});

test("weekdays, daily, month/year/leap edges", () => {
  assert.ok(recurrenceMatches("weekdays", "2026-09-25")); // Fri
  assert.ok(!recurrenceMatches("weekdays", "2026-09-26")); // Sat
  assert.ok(!recurrenceMatches("weekdays", "2026-09-27")); // Sun
  assert.ok(recurrenceMatches("daily", "2026-02-28"));
  assert.ok(recurrenceMatches("weekly:MO", "2026-06-29")); // month end Monday
  assert.ok(recurrenceMatches("weekly:TH", "2026-12-31"));
  assert.ok(recurrenceMatches("weekly:FR", "2027-01-01")); // year rollover
  assert.ok(recurrenceMatches("weekly:TU", "2028-02-29")); // leap day
  assert.ok(recurrenceMatches("weekly:WE", "2028-03-01"));
  assert.ok(!recurrenceMatches("weekly:WE", "2027-03-01")); // Mon in non-leap year
  assert.ok(!recurrenceMatches("garbage", "2026-09-21"));
});

test("the same instant is a different local date per tz", () => {
  const at = "2026-09-20T19:00:00Z";
  assert.equal(localDate(new FixedClock(at, "Asia/Kolkata")), "2026-09-21");
  assert.equal(localDate(new FixedClock(at, "America/New_York")), "2026-09-20");
  assert.ok(recurrenceMatches("weekly:MO", localDate(new FixedClock(at, "Asia/Kolkata"))));
  assert.ok(!recurrenceMatches("weekly:MO", localDate(new FixedClock(at, "America/New_York"))));
});
