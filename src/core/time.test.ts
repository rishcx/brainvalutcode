import assert from "node:assert/strict";
import { test } from "node:test";
import { FixedClock } from "./clock.ts";
import {
  addDaysToLocalDate,
  daysBetweenLocalDates,
  dueAtFromLocalDate,
  dueAtFromLocalDateTime,
  instantFromLocal,
  isQuietHours,
  localDate,
  localDateOf,
  localDayOfWeek,
  localTimeOf,
  nextLocalTimeAfter,
  parseLooseDate,
  parseLooseWhen,
  parseOffset,
  shiftOutOfQuietHours,
  tzOffsetMs,
} from "./time.ts";

const IST = "Asia/Kolkata";
const NY = "America/New_York";
const quiet = { start: "22:00", end: "08:00" };

test("local date/time cross the UTC day boundary in the configured zone", () => {
  // 18:45Z on the 19th is already 00:15 on the 20th in Asia/Kolkata.
  const at = new Date("2026-09-19T18:45:00Z");
  assert.equal(localDateOf(at, IST), "2026-09-20");
  assert.equal(localTimeOf(at, IST), "00:15");
  assert.equal(localDateOf(at, "UTC"), "2026-09-19");
  assert.equal(localDate(new FixedClock("2026-09-19T18:45:00Z", IST)), "2026-09-20");
});

test("tzOffsetMs follows DST, not a fixed guess", () => {
  assert.equal(tzOffsetMs(new Date("2026-01-01T12:00:00Z"), IST), 5.5 * 3600_000);
  assert.equal(tzOffsetMs(new Date("2026-01-15T12:00:00Z"), NY), -5 * 3600_000); // EST
  assert.equal(tzOffsetMs(new Date("2026-07-15T12:00:00Z"), NY), -4 * 3600_000); // EDT
});

test("instantFromLocal round-trips across a DST spring-forward", () => {
  // 2026-03-08: America/New_York jumps 02:00 -> 03:00.
  const before = instantFromLocal({ year: 2026, month: 3, day: 8, hour: 1, minute: 30, second: 0 }, NY);
  assert.equal(before.toISOString(), "2026-03-08T06:30:00.000Z");
  const after = instantFromLocal({ year: 2026, month: 3, day: 8, hour: 3, minute: 30, second: 0 }, NY);
  assert.equal(after.toISOString(), "2026-03-08T07:30:00.000Z");
  // A local time inside the gap does not exist; it must still resolve deterministically.
  const gap = instantFromLocal({ year: 2026, month: 3, day: 8, hour: 2, minute: 30, second: 0 }, NY);
  assert.equal(gap.toISOString(), "2026-03-08T07:30:00.000Z");
  // And it round-trips for every hour of a normal day.
  for (let h = 0; h < 24; h++) {
    const t = instantFromLocal({ year: 2026, month: 6, day: 15, hour: h, minute: 0, second: 0 }, NY);
    assert.equal(localTimeOf(t, NY), `${String(h).padStart(2, "0")}:00`);
  }
});

test("dueAtFromLocalDate pins date-only sources to the configured local hour", () => {
  assert.equal(dueAtFromLocalDate("2026-10-01", IST, 9), "2026-10-01T03:30:00.000Z");
  assert.equal(localTimeOf(new Date(dueAtFromLocalDate("2026-10-01", IST, 9)), IST), "09:00");
  assert.equal(localTimeOf(new Date(dueAtFromLocalDate("2026-07-01", NY, 9)), NY), "09:00");
});

test("calendar-day arithmetic spans month and year ends", () => {
  assert.equal(addDaysToLocalDate("2026-02-27", 2), "2026-03-01");
  assert.equal(addDaysToLocalDate("2026-01-01", -1), "2025-12-31");
  assert.equal(daysBetweenLocalDates("2026-09-20", "2026-09-27"), 7);
  assert.equal(daysBetweenLocalDates("2026-09-20", "2026-09-19"), -1);
  assert.equal(daysBetweenLocalDates("2026-09-20", "2026-09-20"), 0);
});

test("parseOffset understands the configured reminder labels", () => {
  assert.equal(parseOffset("7d"), 604_800_000);
  assert.equal(parseOffset("24h"), 86_400_000);
  assert.equal(parseOffset("90m"), 5_400_000);
  assert.equal(parseOffset("0"), 0);
  assert.throws(() => parseOffset("soon"));
});

test("quiet hours wrap midnight and shift forward to the morning boundary", () => {
  const q = (iso: string) => isQuietHours(new Date(iso), IST, quiet);
  assert.equal(q("2026-09-20T16:35:00Z"), true); // 22:05 IST
  assert.equal(q("2026-09-20T20:30:00Z"), true); // 02:00 IST
  assert.equal(q("2026-09-20T02:31:00Z"), false); // 08:01 IST
  assert.equal(q("2026-09-20T16:29:00Z"), false); // 21:59 IST

  const evening = shiftOutOfQuietHours(new Date("2026-09-20T16:35:00Z"), IST, quiet);
  assert.equal(localDateOf(evening, IST), "2026-09-21");
  assert.equal(localTimeOf(evening, IST), "08:00");

  const smallHours = shiftOutOfQuietHours(new Date("2026-09-20T20:30:00Z"), IST, quiet); // 02:00 on the 21st
  assert.equal(localDateOf(smallHours, IST), "2026-09-21");
  assert.equal(localTimeOf(smallHours, IST), "08:00");

  const awake = new Date("2026-09-20T06:00:00Z");
  assert.equal(shiftOutOfQuietHours(awake, IST, quiet).getTime(), awake.getTime());
});

test("every offset of a 09:00 due date still fires before the deadline, and no two collide", () => {
  // The reason dueHourLocal is 9 and not end-of-day: at 23:59 the T-0 reminder falls inside
  // quiet hours and would shift to 08:00 the NEXT morning — after the deadline it announces.
  const due = new Date(dueAtFromLocalDate("2026-10-01", IST, 9));
  const fires = new Map<string, number>();
  for (const label of ["7d", "2d", "24h", "3h", "0"]) {
    const raw = new Date(due.getTime() - parseOffset(label));
    const fire = shiftOutOfQuietHours(raw, IST, quiet);
    assert.ok(fire.getTime() <= due.getTime(), `${label} fires after its deadline`);
    fires.set(label, fire.getTime());
  }
  // T-3h is 06:00 IST, inside quiet hours: it shifts to 08:00 — still an hour before due.
  assert.equal(localTimeOf(new Date(fires.get("3h")!), IST), "08:00");
  assert.equal(new Set(fires.values()).size, fires.size, "two offsets collapsed onto one instant");

  // End-of-day would break that invariant; this is the test that pins the decision.
  const eod = new Date(dueAtFromLocalDate("2026-10-01", IST, 23));
  assert.ok(shiftOutOfQuietHours(eod, IST, quiet).getTime() > eod.getTime());
});

test("parseLooseDate accepts ISO and spelled months, rejects ambiguous numerics", () => {
  assert.equal(parseLooseDate("Renewal due 2026-10-01 — act now"), "2026-10-01");
  assert.equal(parseLooseDate("Payment due 1 Oct 2026"), "2026-10-01");
  assert.equal(parseLooseDate("Payment due 01 October 2026"), "2026-10-01");
  assert.equal(parseLooseDate("Due Oct 1, 2026"), "2026-10-01");
  assert.equal(parseLooseDate("due 01/10/2026"), null);
  assert.equal(parseLooseDate("2026-02-30 is not a day"), null);
  assert.equal(parseLooseDate("no date here"), null);
});

test("nextLocalTimeAfter lands on the next local occurrence, never the current instant", () => {
  const a = nextLocalTimeAfter(new Date("2026-09-20T01:00:00Z"), IST, "08:00"); // 06:30 IST
  assert.equal(a.toISOString(), "2026-09-20T02:30:00.000Z");
  const b = nextLocalTimeAfter(new Date("2026-09-20T02:30:00Z"), IST, "08:00"); // exactly 08:00 IST
  assert.equal(b.toISOString(), "2026-09-21T02:30:00.000Z");
});

// 2026-09-21 is a Monday; 09:00 UTC = 14:30 IST.
const NOW = new Date("2026-09-21T09:00:00Z");

test("parseLooseWhen resolves day words and times against the configured zone", () => {
  assert.deepEqual(parseLooseWhen("tomorrow 6pm", IST, NOW), { date: "2026-09-22", time: "18:00", relative: true });
  assert.deepEqual(parseLooseWhen("2026-10-04", IST, NOW), { date: "2026-10-04", time: null, relative: false });
  assert.deepEqual(parseLooseWhen("4 Oct 2026 18:30", IST, NOW), { date: "2026-10-04", time: "18:30", relative: false });
  assert.deepEqual(parseLooseWhen("day after tomorrow at noon", IST, NOW), { date: "2026-09-23", time: "12:00", relative: true });
  assert.deepEqual(parseLooseWhen("tomorrow 6:30 pm", IST, NOW), { date: "2026-09-22", time: "18:30", relative: true });
  assert.equal(parseLooseWhen("call mom", IST, NOW), null);
});

test("parseLooseWhen still refuses ambiguous numeric dates", () => {
  assert.equal(parseLooseWhen("01/10/2026", IST, NOW), null);
});

test("parseLooseWhen: next/bare weekday is strictly in the future", () => {
  const next = parseLooseWhen("next monday", IST, NOW)!;
  assert.equal(localDayOfWeek(next.date), 1);
  // NOW is a Monday: a bare "monday" means the following Monday, not today.
  assert.equal(localDayOfWeek("2026-09-21"), 1);
  assert.equal(parseLooseWhen("monday", IST, NOW)!.date, "2026-09-28");
  assert.equal(parseLooseWhen("friday", IST, NOW)!.date, "2026-09-25");
  assert.equal(localDayOfWeek("2026-09-27"), 0);
});

test("parseLooseWhen: tonight defaults to 20:00; a time alone rolls to tomorrow once past", () => {
  assert.deepEqual(parseLooseWhen("tonight", IST, NOW), { date: "2026-09-21", time: "20:00", relative: true });
  assert.equal(parseLooseWhen("tonight at 9", IST, NOW)!.time, "21:00");
  // 14:30 local now: 6pm is still ahead (today), 9am is not (tomorrow).
  assert.equal(parseLooseWhen("6pm", IST, NOW)!.date, "2026-09-21");
  assert.equal(parseLooseWhen("9am", IST, NOW)!.date, "2026-09-22");
  // Ambiguous "at 6": next future instant of 06:00 / 18:00 -> 18:00 today.
  assert.deepEqual(parseLooseWhen("at 6", IST, NOW), { date: "2026-09-21", time: "18:00", relative: true });
  assert.equal(parseLooseWhen("tomorrow at 6", IST, NOW)!.time, "06:00");
});

test("dueAtFromLocalDateTime(null time) equals the canonical dueAtFromLocalDate", () => {
  const cases: [string, string][] = [
    ["2026-09-21", IST],
    ["2026-03-08", "America/New_York"], // DST spring-forward day
    ["2026-11-01", "America/New_York"], // DST fall-back day
    ["2026-10-25", "Europe/London"],
    ["2026-12-31", "Pacific/Auckland"],
    ["2026-02-28", "UTC"],
  ];
  for (const [d, tz] of cases) {
    for (const h of [0, 9, 23]) assert.equal(dueAtFromLocalDateTime(d, null, tz, h), dueAtFromLocalDate(d, tz, h));
  }
  assert.equal(dueAtFromLocalDateTime("2026-09-21", "18:30", IST, 9), "2026-09-21T13:00:00.000Z");
});
