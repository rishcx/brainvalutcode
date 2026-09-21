// Slot-filling dialogue state (PLAN_V3 B.2): one D1 row per (channel, peer), CAS on version, 10-minute expiry.
// Also the one deterministic time resolver shared by the dialog fast path and the reminder tools.
import { parseRelativeWhen } from "../reminders/relative.ts";
import { addDaysToLocalDate, dueAtFromLocalDateTime, localDateOf, MINUTE, parseLooseWhen } from "../time.ts";
import type { AgentContext, DialogState } from "../types.ts";
import { lastListKey } from "../channels/format.ts";
import type { Target, ToolResult } from "./contract.ts";
import { norm } from "./provenance.ts";

export const MAX_SOURCES = 3;
export const MAX_SOURCE_CHARS = 300;

export async function loadDialog(ctx: AgentContext, who: Target): Promise<DialogState | null> {
  try {
    const d = await ctx.store.getDialog(who.channel, who.peer);
    if (!d) return null;
    return Date.parse(d.expiresAt) > ctx.clock.now().getTime() ? d : null;
  } catch {
    return null;
  }
}

export type DialogDraft = Pick<DialogState, "intent" | "slots" | "missing" | "asked" | "sources" | "lastAction" | "questions">;

/** CAS write; on conflict reloads once and retries against the fresh version. false = gave up (caller continues). */
export async function saveDialog(ctx: AgentContext, who: Target, prev: DialogState | null, next: DialogDraft): Promise<boolean> {
  const now = ctx.clock.now();
  const row = {
    ...next,
    sources: next.sources.slice(-MAX_SOURCES).map((s) => s.slice(0, MAX_SOURCE_CHARS)),
    channel: who.channel,
    peer: who.peer,
    updatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ctx.config.chat.dialogTtlMin * MINUTE).toISOString(),
  };
  try {
    if (await ctx.store.putDialog(row, prev?.version ?? null)) return true;
    const fresh = await ctx.store.getDialog(who.channel, who.peer);
    return await ctx.store.putDialog(row, fresh?.version ?? null);
  } catch {
    return false;
  }
}

export async function clearDialog(ctx: AgentContext, who: Target): Promise<void> {
  try {
    await ctx.store.clearDialog(who.channel, who.peer);
  } catch {
    /* an orphan row expires on its own */
  }
}

/** Hinglish and shorthand time words -> phrases the deterministic parsers understand. */
export function normWhen(text: string): string {
  let t = ` ${text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ")} `;
  const subs: [RegExp, string][] = [
    [/\b(?:tmrw|tmr|tmrow|tomorow|tommorow|tommorrow|2moro|tomo)\b/g, "tomorrow"],
    [/\b2day\b/g, "today"],
    [/\bparso\b/g, "day after tomorrow"],
    [/\bkal\b/g, "tomorrow"],
    [/\baaj\b/g, "today"],
    [/\bsubah\b/g, "morning"],
    [/\b(?:shaam|sham)\b/g, "evening"],
    [/\braat\b/g, "night"],
    [/\bdopahar\b/g, "afternoon"],
    [/\bghant[ae]\b/g, "hours"],
    [/(\d+\s*(?:m|min|mins|minutes?|h|hrs?|hours?))\s+(?:baad|me|mein)\b/g, "in $1"],
    [/(\d{1,2}(?::\d{2})?)\s*baje\b/g, "at $1"],
    [/\bko\b/g, " "],
  ];
  for (const [re, to] of subs) t = t.replace(re, to);
  t = t.replace(/\s+/g, " ").trim();
  return /^\d{1,2}(?::[0-5]\d)?$/.test(t) ? `at ${t}` : t;
}

const DAY_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 };

export interface ResolvedWhen {
  dueAt: string;
  timed: boolean;
}

/** Deterministic, authoritative: relative first, then absolute; date-only -> dueHourLocal. null = not a time. */
export function resolveWhen(text: string, tz: string, now: Date, dueHourLocal: number): ResolvedWhen | null {
  if (typeof text !== "string" || !text.trim()) return null;
  const t = normWhen(text);
  const rel = parseRelativeWhen(t, tz, now);
  if (rel) return { dueAt: rel.dueAt, timed: true };
  // "in 2 days at 5pm": neither parser does a day count with a clock time.
  const days = /\b(?:in|after)\s+(\d{1,3}|an?|one|two|three|four|five|six|seven)\s+days?\b/.exec(t);
  if (days) {
    const n = /^\d/.test(days[1]!) ? Number(days[1]) : (DAY_WORDS[days[1]!] ?? 0);
    const clock = parseLooseWhen(t.replace(days[0], " "), tz, now);
    if (n < 1 || n > 366) return null;
    try {
      const date = addDaysToLocalDate(localDateOf(now, tz), n);
      return { dueAt: dueAtFromLocalDateTime(date, clock?.time ?? null, tz, dueHourLocal), timed: (clock?.time ?? null) !== null };
    } catch {
      return null;
    }
  }
  // "yesterday at 5": no parser knows the past; resolve it on the previous day so the caller says it has passed.
  const past = /\byesterday\b/.test(t);
  const lw = parseLooseWhen(past ? t.replace(/\byesterday\b/, "today") : t, tz, now);
  if (!lw) return null;
  try {
    const date = past ? addDaysToLocalDate(localDateOf(now, tz), -1) : lw.date;
    return { dueAt: dueAtFromLocalDateTime(date, lw.time, tz, dueHourLocal), timed: lw.time !== null };
  } catch {
    return null;
  }
}

const FILLER = new Set(["ok", "okay", "at", "on", "by", "please", "pls", "then", "make", "it", "hmm", "yes", "sure"]);
const TIME_TOKEN =
  /^(?:\d{1,4}|\d{1,4}(?:am|pm|m|h|min|mins|hr|hrs)|am|pm|in|after|within|from|now|later|seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|half|an|a|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|today|tomorrow|tonight|noon|midnight|this|next|morning|afternoon|evening|night|day|monday|tuesday|wednesday|thursday|friday|saturday|sunday|kal|parso|aaj|subah|shaam|sham|raat|baje|baad|ko|tmrw|tmr|me|mein|ghante|ghanta)$/;

/**
 * The whole message is a time phrase (fillers ok|at|on|by|please|then allowed): "in 10 minutes", "6pm", "at 6",
 * "tomorrow 9am", "kal subah 9 baje". Anything else ("call mom at 6") -> null, which sends it to PLAN.
 */
export function pureTimeAnswer(text: string, tz: string, now: Date, dueHourLocal = 9): { dueAt: string; timed: boolean; whenText: string } | null {
  if (typeof text !== "string" || text.length > 60) return null;
  const words = norm(text.replace(/(\d):(\d)/g, "$1$2")).split(" ").filter((w) => w && !FILLER.has(w));
  if (words.length === 0 || !words.every((w) => TIME_TOKEN.test(w))) return null;
  const r = resolveWhen(text, tz, now, dueHourLocal);
  return r ? { ...r, whenText: text.trim() } : null;
}

/**
 * More than one item matched: persist them as this channel's numbered list (so "2" or "done 2" resolves) and ask.
 * The result's missing=["which"] makes the handler keep the dialog open.
 */
export async function askWhich(
  ctx: AgentContext,
  who: Target,
  candidates: { k: "d" | "t"; id: string; title: string }[],
  slots: Record<string, unknown>,
): Promise<ToolResult> {
  const top = candidates.slice(0, 5);
  await ctx.store.kvSet(lastListKey(who), JSON.stringify(top.map(({ k, id }) => ({ k, id }))), ctx.clock.now().toISOString());
  const s = { ...slots, candidates: top.map((c) => ({ title: c.title })) };
  return { ok: false, missing: ["which"], render: question("which", s), data: { slots: s } };
}

export function question(slot: string, slots: Record<string, unknown>): string {
  const what = typeof slots.what === "string" && slots.what ? slots.what : null;
  switch (slot) {
    case "what":
      return "What should I remind you about?";
    case "when":
      return `When should I remind you${what ? ` to ${what}` : ""}? For example: in 10 minutes, at 6pm, tomorrow 9am.`;
    case "items":
      return "Which tasks should I add?";
    case "text":
      return "What should I write down?";
    case "minutes":
      return "For how long? For example: 10 minutes or 1 hour.";
    case "which": {
      const c = Array.isArray(slots.candidates) ? (slots.candidates as { title?: unknown }[]) : [];
      const list = c.map((x, i) => `${i + 1}. ${String(x.title ?? "")}`).join("  ");
      return list ? `Which one? ${list}` : "Which one do you mean? Send its number from your last list.";
    }
    default:
      return "Which one do you mean? Send its number from your last list, or its name.";
  }
}
