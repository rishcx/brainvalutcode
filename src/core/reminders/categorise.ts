// Pure chat helpers: #tag extraction and "remind me / I have a flight tomorrow 6pm" proposals.
import { cleanTitle } from "../deadlines/extract.ts";
import { dueAtFromLocalDateTime, localDateOf, parseLooseWhen } from "../time.ts";
import type { CategoryId, ReminderRule } from "../types.ts";
import { categorise, ruleFor } from "./rules.ts";

export function extractHashtag(text: string, rules: ReminderRule[]): { text: string; category: CategoryId | null } {
  const re = /(^|\s)#([A-Za-z][\w-]*)/g;
  for (const m of text.matchAll(re)) {
    const id = m[2]!.toLowerCase();
    if (ruleFor(id, rules)) {
      const at = m.index! + m[1]!.length;
      const out = (text.slice(0, at) + text.slice(at + 1 + m[2]!.length)).replace(/\s+/g, " ").trim();
      return { text: out, category: id };
    }
  }
  return { text, category: null };
}

export interface PendingWhen {
  title: string;
  date: string;
  category: CategoryId;
  explicit: boolean;
}

export type RemindProposal =
  | {
      ok: true;
      title: string;
      dueAt: string;
      category: CategoryId;
      timed: boolean;
      relative: boolean;
      date: string;
      time: string | null;
    }
  | { ok: false; reason: "needs-time"; pending: PendingWhen; ask: string }
  | { ok: false; reason: "no-date" };

const MONTH = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const YEARLESS_DMY = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH})\\b\\.?(?!\\s*,?\\s*\\d{4}\\b)`, "i");
const YEARLESS_MDY = new RegExp(`\\b(${MONTH})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?!\\s*,?\\s*\\d{4}\\b)(?!:)`, "i");

/** parseLooseWhen wants a year; chat says "4 Oct". Insert the next occurrence's year. */
function withYear(text: string, tz: string, now: Date): string {
  const today = localDateOf(now, tz);
  const year = Number(today.slice(0, 4));
  const monthIdx = (w: string): number => MONTH_NAMES.findIndex((n) => n.toLowerCase() === w.slice(0, 3).toLowerCase());
  const fix = (day: number, mon: string): number => {
    const mi = monthIdx(mon);
    const cand = `${year}-${String(mi + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    return cand < today ? year + 1 : year;
  };
  let m = YEARLESS_DMY.exec(text);
  if (m) return `${text.slice(0, m.index)}${m[1]} ${m[2]} ${fix(Number(m[1]), m[2]!)}${text.slice(m.index + m[0].length)}`;
  m = YEARLESS_MDY.exec(text);
  if (m) return `${text.slice(0, m.index)}${m[1]} ${m[2]}, ${fix(Number(m[2]), m[1]!)}${text.slice(m.index + m[0].length)}`;
  return text;
}

const WHEN_PATTERNS: string[] = [
  "day after tomorrow",
  "tomorrow",
  "tonight",
  "today",
  "(?:next\\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)",
  "\\d{4}-\\d{2}-\\d{2}",
  `\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTH})\\.?,?(?:\\s+\\d{4})?`,
  `(?:${MONTH})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?`,
  "\\d{1,2}(?::[0-5]\\d)?\\s*(?:am|pm)",
  "(?:[01]?\\d|2[0-3]):[0-5]\\d",
  "at\\s+\\d{1,2}",
  "noon",
  "midnight",
  "(?:in the\\s+)?(?:morning|evening|afternoon)",
];
const WHEN_RE = new RegExp(`(?:\\b(?:on|at|by|for|due)\\s+)?\\b(?:${WHEN_PATTERNS.join("|")})\\b`, "gi");
const LEAD_RE = /^\s*(?:remind me to|i have (?:a|an)|i've got (?:a|an)|i have|i've got)\s+/i;

function deriveTitle(text: string): string {
  let t = text.replace(LEAD_RE, "").replace(WHEN_RE, " ");
  t = t.replace(/\s+/g, " ").trim();
  for (;;) {
    const n = t.replace(/\s+(?:on|at|by|for|due)$/i, "").replace(/^(?:on|at|by|for|due)\s+/i, "");
    if (n === t) break;
    t = n;
  }
  return cleanTitle(t.replace(/^[\s,.\-–:]+|[\s,.\-–:]+$/g, ""));
}

const fmtDate = (date: string): string => `${Number(date.slice(8, 10))} ${MONTH_NAMES[Number(date.slice(5, 7)) - 1]}`;

export function proposeReminder(
  text: string,
  rules: ReminderRule[],
  tz: string,
  now: Date,
  dueHourLocal: number,
): RemindProposal {
  const tag = extractHashtag(text, rules);
  const when = parseLooseWhen(withYear(tag.text, tz, now), tz, now);
  if (!when) return { ok: false, reason: "no-date" };
  let title = deriveTitle(tag.text);
  const category = categorise({ title, sourceRef: "", source: "chat", category: tag.category ?? undefined }, rules);
  if (!title) title = category;
  if (ruleFor(category, rules)?.needsTime && when.time === null) {
    const label = title.charAt(0).toUpperCase() + title.slice(1);
    return {
      ok: false,
      reason: "needs-time",
      pending: { title, date: when.date, category, explicit: tag.category !== null },
      ask: `${label} on ${fmtDate(when.date)} — what time? (e.g. '6pm')`,
    };
  }
  return {
    ok: true,
    title,
    dueAt: dueAtFromLocalDateTime(when.date, when.time, tz, dueHourLocal),
    category,
    timed: when.time !== null,
    relative: when.relative,
    date: when.date,
    time: when.time,
  };
}

/** Bare-time reply to a needs-time proposal; null when no time is found. Uses ONLY .time. */
export function completePending(
  p: PendingWhen,
  reply: string,
  _rules: ReminderRule[],
  tz: string,
  now: Date,
  _dueHourLocal: number,
): Extract<RemindProposal, { ok: true }> | null {
  const when = parseLooseWhen(reply, tz, now);
  if (!when || when.time === null) return null;
  return {
    ok: true,
    title: p.title,
    dueAt: dueAtFromLocalDateTime(p.date, when.time, tz, 0),
    category: p.category,
    timed: true,
    relative: false,
    date: p.date,
    time: when.time,
  };
}
