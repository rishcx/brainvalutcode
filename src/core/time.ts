// All timezone maths lives here. Web-standard only (Intl), so it runs in the Worker.
// ARCHITECT-OWNED: builder packages import from here and never edit this file.
import type { Clock, QuietHours } from "./types.ts";

export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

export interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number;
  second: number;
}

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = FORMATTERS.get(tz);
  if (!f) {
    // formatToParts, not a formatted string: locale/ICU versions disagree on separators.
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    FORMATTERS.set(tz, f);
  }
  return f;
}

/** Wall-clock fields of `at` as seen in `tz`. Throws RangeError on an unknown zone. */
export function localParts(at: Date, tz: string): LocalParts {
  const got: Record<string, number> = {};
  for (const p of formatter(tz).formatToParts(at)) {
    if (p.type !== "literal") got[p.type] = Number(p.value);
  }
  // "24" is what h23 emits for midnight on some ICU builds; normalise it.
  return {
    year: got.year!,
    month: got.month!,
    day: got.day!,
    hour: got.hour! % 24,
    minute: got.minute!,
    second: got.second!,
  };
}

export const pad2 = (n: number): string => String(n).padStart(2, "0");

/** YYYY-MM-DD as seen in `tz`. */
export function localDateOf(at: Date, tz: string): string {
  const p = localParts(at, tz);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

/** HH:MM as seen in `tz`. */
export function localTimeOf(at: Date, tz: string): string {
  const p = localParts(at, tz);
  return `${pad2(p.hour)}:${pad2(p.minute)}`;
}

/** YYYY-MM-DD in the clock's timezone. */
export const localDate = (clock: Clock): string => localDateOf(clock.now(), clock.tz);

/** Offset of `tz` at instant `at`, in ms east of UTC. */
export function tzOffsetMs(at: Date, tz: string): number {
  const p = localParts(at, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/**
 * The instant at which `tz` shows these wall-clock fields. Two passes, because the offset
 * we need depends on the answer (DST). Ambiguous local times (fall-back) resolve to the
 * first occurrence; nonexistent ones (spring-forward gaps) shift forward by the gap, which
 * is what Temporal calls "compatible" disambiguation.
 */
export function instantFromLocal(p: LocalParts, tz: string): Date {
  const naive = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const first = naive - tzOffsetMs(new Date(naive), tz);
  const second = naive - tzOffsetMs(new Date(first), tz);
  const got = localParts(new Date(second), tz);
  const exact =
    got.year === p.year && got.month === p.month && got.day === p.day && got.hour === p.hour && got.minute === p.minute;
  return new Date(exact ? second : first);
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseLocalDate(date: string): { year: number; month: number; day: number } {
  const m = DATE_RE.exec(date);
  if (!m) throw new Error(`not a YYYY-MM-DD date: ${date}`);
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

/** The one canonical rule: a date-only deadline is due at `hour`:00 local. */
export function dueAtFromLocalDate(date: string, tz: string, hour: number): string {
  const d = parseLocalDate(date);
  return instantFromLocal({ ...d, hour, minute: 0, second: 0 }, tz).toISOString();
}

/** YYYY-MM-DD shifted by whole calendar days (no tz involved: pure date arithmetic). */
export function addDaysToLocalDate(date: string, days: number): string {
  const d = parseLocalDate(date);
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day) + days * DAY);
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}

/** Whole calendar days from `from` to `to` (both YYYY-MM-DD). Negative when `to` is earlier. */
export function daysBetweenLocalDates(from: string, to: string): number {
  const a = parseLocalDate(from);
  const b = parseLocalDate(to);
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / DAY);
}

const OFFSET_RE = /^(\d+)(m|h|d)?$/;

/** "7d" | "24h" | "90m" | "0" -> milliseconds before the due instant. */
export function parseOffset(label: string): number {
  const m = OFFSET_RE.exec(label.trim());
  if (!m) throw new Error(`bad reminder offset: ${label}`);
  const n = Number(m[1]);
  return n * (m[2] === "d" ? DAY : m[2] === "h" ? HOUR : m[2] === "m" ? MINUTE : 1);
}

const HHMM_RE = /^(\d{1,2}):(\d{2})$/;

function minutesOfDay(hhmm: string): number {
  const m = HHMM_RE.exec(hhmm);
  if (!m) throw new Error(`bad HH:MM: ${hhmm}`);
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) throw new Error(`bad HH:MM: ${hhmm}`);
  return h * 60 + mi;
}

/** Quiet windows wrap midnight (22:00-08:00): [start, 24:00) plus [00:00, end). */
export function isQuietHours(at: Date, tz: string, q: QuietHours): boolean {
  const start = minutesOfDay(q.start);
  const end = minutesOfDay(q.end);
  if (start === end) return false;
  const p = localParts(at, tz);
  const now = p.hour * 60 + p.minute;
  return start < end ? now >= start && now < end : now >= start || now < end;
}

/**
 * Moves an instant that lands inside quiet hours to the next local `q.end`.
 * Late-evening fires roll to the next morning; small-hours fires roll to the same morning.
 */
export function shiftOutOfQuietHours(at: Date, tz: string, q: QuietHours): Date {
  if (!isQuietHours(at, tz, q)) return at;
  const end = minutesOfDay(q.end);
  const start = minutesOfDay(q.start);
  const p = localParts(at, tz);
  const now = p.hour * 60 + p.minute;
  const nextDay = start > end && now >= start; // wrapped window, evening side
  const date = addDaysToLocalDate(`${p.year}-${pad2(p.month)}-${pad2(p.day)}`, nextDay ? 1 : 0);
  const d = parseLocalDate(date);
  return instantFromLocal({ ...d, hour: Math.floor(end / 60), minute: end % 60, second: 0 }, tz);
}

const MONTHS = [
  "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
];

const ISO_IN_TEXT = /\b(\d{4})-(\d{2})-(\d{2})\b/;
const DMY_IN_TEXT = /\b(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/;
const MDY_IN_TEXT = /\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\b/;

function valid(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

/**
 * First date in free text as YYYY-MM-DD: ISO, "1 Oct 2026" or "Oct 1, 2026".
 * Deliberately conservative — ambiguous numeric forms (01/10/2026) are NOT parsed.
 */
export function parseLooseDate(text: string): string | null {
  const iso = ISO_IN_TEXT.exec(text);
  if (iso) return valid(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const dmy = DMY_IN_TEXT.exec(text);
  if (dmy) {
    const m = MONTHS.indexOf(dmy[2]!.slice(0, 3).toLowerCase());
    if (m >= 0) return valid(Number(dmy[3]), m + 1, Number(dmy[1]));
  }
  const mdy = MDY_IN_TEXT.exec(text);
  if (mdy) {
    const m = MONTHS.indexOf(mdy[1]!.slice(0, 3).toLowerCase());
    if (m >= 0) return valid(Number(mdy[3]), m + 1, Number(mdy[2]));
  }
  return null;
}

/** Next instant at `hhmm` local strictly after `after`. Used to schedule daily jobs. */
export function nextLocalTimeAfter(after: Date, tz: string, hhmm: string): Date {
  const mins = minutesOfDay(hhmm);
  const p = localParts(after, tz);
  const today = `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
  for (const date of [today, addDaysToLocalDate(today, 1), addDaysToLocalDate(today, 2)]) {
    const d = parseLocalDate(date);
    const at = instantFromLocal({ ...d, hour: Math.floor(mins / 60), minute: mins % 60, second: 0 }, tz);
    if (at.getTime() > after.getTime()) return at;
  }
  /* c8 ignore next */
  throw new Error(`no next ${hhmm} after ${after.toISOString()} in ${tz}`);
}

/* ---------------------------------------------------------------- v2 additions */

export interface LooseWhen {
  date: string; // YYYY-MM-DD
  time: string | null; // "HH:MM" local, or null when none was given
  relative: boolean; // true when the date came from "tomorrow"/"next monday"/…
}

/** Day of week (0 = Sunday) for a YYYY-MM-DD local date. Pure calendar maths, no tz. */
export function localDayOfWeek(date: string): number {
  const d = parseLocalDate(date);
  return new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay();
}

/** time === null delegates to dueAtFromLocalDate(date, tz, hour): the canonical rule is unchanged. */
export function dueAtFromLocalDateTime(date: string, time: string | null, tz: string, hour: number): string {
  if (time === null) return dueAtFromLocalDate(date, tz, hour);
  const mins = minutesOfDay(time);
  const d = parseLocalDate(date);
  return instantFromLocal({ ...d, hour: Math.floor(mins / 60), minute: mins % 60, second: 0 }, tz).toISOString();
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTH_WORDS = "jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec";
const MERIDIEM_RE = /\b(\d{1,2})(?::([0-5]\d))?\s*(am|pm)\b/;
const CLOCK24_RE = /\b([01]?\d|2[0-3]):([0-5]\d)\b/;
const AT_HOUR_RE = new RegExp(`\\bat\\s+(\\d{1,2})\\b(?!\\s*(?:[:/.\\-]\\d|\\d|(?:${MONTH_WORDS})))`);
const EVENING_RE = /\b(tonight|evening|night|afternoon)\b/;
const MORNING_RE = /\bmorning\b/;

const hhmm = (h: number, m: number): string => `${pad2(h)}:${pad2(m)}`;

/** The instant `date` `time` local, as epoch ms. */
function localInstantMs(date: string, time: string, tz: string): number {
  const mins = minutesOfDay(time);
  const d = parseLocalDate(date);
  return instantFromLocal({ ...d, hour: Math.floor(mins / 60), minute: mins % 60, second: 0 }, tz).getTime();
}

/**
 * "tomorrow 6pm", "next monday", "4 Oct 2026 18:30", "2026-10-04", "tonight".
 * "Today" always comes from `now` in `tz`, never the host clock. Ambiguous numeric dates
 * (01/10/2026) are refused via parseLooseDate. Returns null when neither a date nor a time is found.
 */
export function parseLooseWhen(text: string, tz: string, now: Date): LooseWhen | null {
  const lower = text.toLowerCase();
  const today = localDateOf(now, tz);

  /* ---- date */
  let date: string | null = null;
  let relative = false;
  let tonight = false;

  const abs = parseLooseDate(text);
  if (abs) {
    date = abs;
  } else if (/\bday after tomorrow\b/.test(lower)) {
    date = addDaysToLocalDate(today, 2);
    relative = true;
  } else if (/\btomorrow\b/.test(lower)) {
    date = addDaysToLocalDate(today, 1);
    relative = true;
  } else if (/\btonight\b/.test(lower)) {
    date = today;
    relative = true;
    tonight = true;
  } else if (/\btoday\b/.test(lower)) {
    date = today;
    relative = true;
  } else {
    const wd = new RegExp(`\\b(?:next\\s+)?(${WEEKDAYS.join("|")})\\b`).exec(lower);
    if (wd) {
      const target = WEEKDAYS.indexOf(wd[1]!);
      // Strictly future: "monday" on a Monday is next Monday.
      const ahead = ((target - localDayOfWeek(today) + 6) % 7) + 1;
      date = addDaysToLocalDate(today, ahead);
      relative = true;
    }
  }

  /* ---- time */
  let time: string | null = null;
  let ambiguousHour: number | null = null;

  const mer = MERIDIEM_RE.exec(lower);
  const c24 = CLOCK24_RE.exec(lower);
  const atH = AT_HOUR_RE.exec(lower);
  if (mer && Number(mer[1]) >= 1 && Number(mer[1]) <= 12) {
    const h = Number(mer[1]) % 12;
    time = hhmm(mer[3] === "pm" ? h + 12 : h, Number(mer[2] ?? 0));
  } else if (c24) {
    time = hhmm(Number(c24[1]), Number(c24[2]));
  } else if (/\bnoon\b/.test(lower)) {
    time = "12:00";
  } else if (/\bmidnight\b/.test(lower)) {
    time = "00:00";
  } else if (atH) {
    const h = Number(atH[1]);
    if (h === 0 || (h >= 12 && h <= 23)) time = hhmm(h, 0);
    else if (h >= 1 && h <= 11) {
      if (EVENING_RE.test(lower)) time = hhmm(h + 12, 0);
      else if (MORNING_RE.test(lower)) time = hhmm(h, 0);
      else ambiguousHour = h;
    }
  }

  if (date === null && time === null && ambiguousHour === null) return null;

  if (ambiguousHour !== null) {
    // Unmarked "at 6": the next future instant of 06:00 / 18:00 on the day in question.
    const am = hhmm(ambiguousHour, 0);
    const pm = hhmm(ambiguousHour + 12, 0);
    const day = date ?? today;
    const future = [am, pm].find((t) => localInstantMs(day, t, tz) > now.getTime());
    if (future) time = future;
    else if (date === null) {
      date = addDaysToLocalDate(today, 1);
      relative = true;
      time = am;
    } else time = pm;
  }

  if (time === null && tonight) time = "20:00";

  if (date === null) {
    // A time with no date: today if that instant is still ahead, otherwise tomorrow.
    date = localInstantMs(today, time!, tz) > now.getTime() ? today : addDaysToLocalDate(today, 1);
    relative = true;
  }
  return { date, time, relative };
}
