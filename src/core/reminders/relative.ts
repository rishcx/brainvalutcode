// Relative times for chat: "in 2 minutes", "after half an hour", "tomorrow evening", "tonight", "noon".
// Absolute dates and clock times ("at 5pm", "tomorrow 6pm") stay with time.ts#parseLooseWhen.
import { addDaysToLocalDate, dueAtFromLocalDateTime, localDateOf, nextLocalTimeAfter, DAY, HOUR, MINUTE } from "../time.ts";

export interface RelativeWhen {
  dueAt: string; // ISO UTC
  matched: string; // the exact text that produced it, for title stripping
  relative: true;
}

const MAX_N = 100_000;
const MAX_SPAN_MS = 366 * DAY;

const FULL_UNIT = "seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|wks?";
const WORD_NUM = "half\\s+an?|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty";
const WORDS: Record<string, number> = {
  an: 1, a: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30,
};
// One "<number><unit>" pair. Single-letter units (5m, 2h) must touch their digits.
const PAIR = `(?:(?:\\d+(?:\\.\\d+)?)\\s*(?:${FULL_UNIT})|(?:\\d+(?:\\.\\d+)?)[smhdw]|(?:${WORD_NUM})\\s+(?:${FULL_UNIT}))`;
// "and a half" after the last pair ("in an hour and a half" = 90 min). Must sit INSIDE the captured group.
const HALF_TAIL = `(?:\\s*,?\\s*(?:and\\s+)?(?:an?\\s+)?half)?`;
const COMPOUND = `${PAIR}(?:\\s*,?\\s*(?:and\\s+)?${PAIR})*${HALF_TAIL}`;
const HALF_TAIL_RE = /(?:^|\s)(?:and\s+)?(?:an?\s+)?half\s*$/i;
const PAIR_G = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${FULL_UNIT}|[smhdw])(?![a-z])|\\b(${WORD_NUM})\\s+(${FULL_UNIT})(?![a-z])`, "gi");

const PREFIXED = new RegExp(`(?<![\\w.-])(?:in|after|within)\\s+(${COMPOUND})(?![\\w.])(?!\\s*ago\\b)`, "i");
const SUFFIXED = new RegExp(`(?<![\\w.-])(${COMPOUND})\\s+(?:later|from\\s+now)\\b`, "i");
// Bare "2h", "30 min": only the short units, and never "for 2 hours" / "2 hours ago".
const BARE = new RegExp(
  `(?<![\\w.:/-])(?<!\\bfor\\s+)(?:(?:\\d+(?:\\.\\d+)?)\\s*(?:seconds?|secs?|minutes?|mins?|hours?|hrs?)|(?:\\d+(?:\\.\\d+)?)[smh])(?![\\w.])(?!\\s*ago\\b)`,
  "i",
);

const UNIT_MS: Array<[RegExp, number]> = [
  [/^(?:s|secs?|seconds?)$/i, 1000],
  [/^(?:m|mins?|minutes?)$/i, MINUTE],
  [/^(?:h|hrs?|hours?)$/i, HOUR],
  [/^(?:d|days?)$/i, DAY],
  [/^(?:w|wks?|weeks?)$/i, 7 * DAY],
];
const unitMs = (u: string): number => UNIT_MS.find(([re]) => re.test(u))?.[1] ?? 0;

/** Sum of every pair in a matched duration; null when a pair is nonsense. */
function durationMs(text: string): { ms: number; days: boolean } | null {
  let ms = 0;
  let days = false;
  let seen = 0;
  let lastPer = 0;
  for (const m of text.matchAll(PAIR_G)) {
    let n: number;
    let unit: string;
    if (m[1] !== undefined) {
      n = Number(m[1]);
      unit = m[2]!;
      if (unit.length === 1 && /\s/.test(m[0])) return null;
    } else {
      const w = m[3]!.toLowerCase().replace(/\s+/g, " ");
      n = w.startsWith("half") ? 0.5 : (WORDS[w] ?? 0);
      unit = m[4]!;
    }
    const per = unitMs(unit);
    if (!(n > 0) || n > MAX_N || per === 0) return null;
    if (per >= DAY) days = true;
    ms += n * per;
    lastPer = per;
    seen++;
  }
  // A trailing "and a half" adds half of the last unit ("an hour and a half"); "half an hour" already parsed as a pair.
  if (seen > 0 && lastPer > 0 && HALF_TAIL_RE.test(text)) ms += lastPer / 2;
  return seen > 0 && Number.isFinite(ms) ? { ms, days } : null;
}

const DATE_WORD =
  /\b(?:tomorrow|today|day after|monday|tuesday|wednesday|thursday|friday|saturday|sunday|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b|\d{4}-\d{2}-\d{2}/i;
const CLOCK_HINT = /\b\d{1,2}(?::[0-5]\d)?\s*(?:am|pm)\b|\b(?:[01]?\d|2[0-3]):[0-5]\d\b|\bat\s+\d{1,2}\b/i;

const ceilMinute = (ms: number): number => Math.ceil(ms / MINUTE) * MINUTE;

function localAt(date: string, hhmm: string, tz: string): Date {
  return new Date(dueAtFromLocalDateTime(date, hhmm, tz, 0));
}

const DAY_PART_HOUR: Record<string, string> = { morning: "09:00", afternoon: "15:00", evening: "18:00", night: "21:00" };
const PARTS = "morning|afternoon|evening|night";
const DAY_AFTER_PART = new RegExp(`\\bday\\s+after\\s+tomorrow\\s+(${PARTS})\\b`, "i");
const TOMORROW_PART = new RegExp(`(?<!\\bday\\s+after\\s+)\\btomorrow\\s+(${PARTS})\\b`, "i");
const TODAY_PART = new RegExp(`\\b(?:this|today)\\s+(${PARTS})\\b`, "i");
// A bare day part is a time only on its own: "in the morning" / "good morning" / "every evening" stay unparsed.
const BARE_PART = new RegExp(`(?<!\\b(?:the|good|every|each|a|an)\\s)\\b(${PARTS})\\b`, "i");

/**
 * Returns the due instant for a relative phrase in `text`, or null. Durations are rounded UP to the next whole
 * minute (never early, never in the past, at least one minute out) and refused beyond 366 days.
 */
export function parseRelativeWhen(text: string, tz: string, now: Date): RelativeWhen | null {
  try {
    if (typeof text !== "string" || text.length === 0 || text.length > 2000 || Number.isNaN(now.getTime())) return null;
    const hasClock = CLOCK_HINT.test(text);

    /* ---- durations */
    const dur = PREFIXED.exec(text) ?? SUFFIXED.exec(text) ?? BARE.exec(text);
    if (dur) {
      const d = durationMs(dur[1] ?? dur[0]);
      if (!d || d.ms > MAX_SPAN_MS) return null;
      if (d.days && hasClock) return null; // "in 2 days at 5pm": not a duration, parseLooseWhen cannot do it either
      const due = ceilMinute(now.getTime() + Math.max(d.ms, MINUTE));
      return { dueAt: new Date(due).toISOString(), matched: dur[0], relative: true };
    }

    /* ---- day parts. An explicit clock time ("tonight at 9") belongs to parseLooseWhen. */
    if (hasClock) return null;
    const today = localDateOf(now, tz);
    const nowMs = now.getTime();
    const future = (d: Date, matched: string): RelativeWhen | null =>
      d.getTime() > nowMs ? { dueAt: d.toISOString(), matched, relative: true } : null;

    // "day after tomorrow morning" (also "parso subah", normalised upstream) must win over the "tomorrow <part>" tail.
    const dat = DAY_AFTER_PART.exec(text);
    if (dat) return future(localAt(addDaysToLocalDate(today, 2), DAY_PART_HOUR[dat[1]!.toLowerCase()]!, tz), dat[0]);

    const tom = TOMORROW_PART.exec(text);
    if (tom) return future(localAt(addDaysToLocalDate(today, 1), DAY_PART_HOUR[tom[1]!.toLowerCase()]!, tz), tom[0]);

    const tonight = /\btonight\b/i.exec(text);
    if (tonight) return future(localAt(today, "20:00", tz), tonight[0]);

    // "this evening", "today evening" ("aaj shaam"), and a bare day part ("shaam ko") when no other date word is present.
    const part = TODAY_PART.exec(text) ?? (DATE_WORD.test(text) ? null : BARE_PART.exec(text));
    if (part) {
      const which = part[1]!.toLowerCase();
      const at = localAt(today, DAY_PART_HOUR[which]!, tz);
      if (which === "morning" && at.getTime() <= nowMs) return future(localAt(addDaysToLocalDate(today, 1), "09:00", tz), part[0]);
      return future(at, part[0]);
    }

    const nm = /(?:\b(?:at|by|around)\s+)?\b(noon|midnight)\b/i.exec(text);
    if (nm && !DATE_WORD.test(text)) {
      return { dueAt: nextLocalTimeAfter(now, tz, nm[1]!.toLowerCase() === "noon" ? "12:00" : "00:00").toISOString(), matched: nm[0], relative: true };
    }
    return null;
  } catch {
    return null;
  }
}
