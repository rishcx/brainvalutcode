// Code-rendered reply templates (PLAN_V3 B.6). The model never phrases an outcome; these do.
import { oneLine } from "../channels/format.ts";
import { addDaysToLocalDate, localDateOf, localTimeOf } from "../time.ts";
import type { ReplyLanguage } from "./lang.ts";

export const MAX_REPLY = 1500;
export const MAX_LIST = 8;

/** "today 15:15" | "tomorrow 09:00" | "Wed 23 Sep 17:00". */
export function whenLabel(dueAt: string, now: Date, tz: string): string {
  const at = new Date(dueAt);
  const today = localDateOf(now, tz);
  const date = localDateOf(at, tz);
  const time = localTimeOf(at, tz);
  if (date === today) return `today ${time}`;
  if (date === addDaysToLocalDate(today, 1)) return `tomorrow ${time}`;
  const day = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short" }).format(at);
  return `${day.replace(/,/g, "")} ${time}`;
}

/** "in 10 min" only under an hour (the clock time says the rest), else "". */
export function inLabel(dueAt: string, now: Date): string {
  const mins = Math.round((new Date(dueAt).getTime() - now.getTime()) / 60_000);
  return mins >= 1 && mins < 60 ? `in ${mins} min` : "";
}

const at = (dueAt: string, now: Date, tz: string): string => {
  const rel = inLabel(dueAt, now);
  return `${whenLabel(dueAt, now, tz)}${rel ? ` (${rel})` : ""}`;
};

export const reminderSet = (what: string, dueAt: string, now: Date, tz: string): string => `Reminder set: ${oneLine(what)}, ${at(dueAt, now, tz)}.`;
export const reminderMoved = (what: string, dueAt: string, now: Date, tz: string): string => `Moved: ${oneLine(what)}, ${at(dueAt, now, tz)}.`;

/** Header + "• 1. item" lines (numbers match the persisted list), max 8 then "... and n more". */
export function numberedList(header: string, items: string[], max = MAX_LIST): string {
  const shown = items.slice(0, max).map((t, i) => `• ${i + 1}. ${oneLine(t)}`);
  const more = items.length > max ? [`... and ${items.length - max} more`] : [];
  return [header, ...shown, ...more].join("\n");
}

/** A task plus its 1-based position in the list persisted for this chat (0 when it is not on today's list). */
export interface Numbered {
  n: number;
  title: string;
}

const bullet = (x: Numbered): string => `• ${x.n > 0 ? `${x.n}. ` : ""}${oneLine(x.title)}`;

export function tasksAdded(added: Numbered[], existing: Numbered[], skipped: string[], note: string[] = []): string {
  const lines: string[] = [];
  // Numbered, because the numbers are what "done 1" resolves against (audit 8).
  if (added.length) lines.push(`Added ${added.length === 1 ? "1 task" : `${added.length} tasks`}:`, ...added.map(bullet));
  if (existing.length) lines.push("Already on your list:", ...existing.map(bullet));
  for (const s of skipped) lines.push(`I skipped "${oneLine(s)}" because it isn't in your message.`);
  lines.push(...note);
  return lines.join("\n");
}

export const HELP_TEXT = [
  "I can set reminders, manage tasks and answer from your notes and GitHub. For example:",
  "• Reminders: remind me at 6pm to call mom",
  "• Tasks: add task pay rent and laundry; what are today's tasks",
  "• Deadlines and GitHub: what's due this week, any PRs to review",
  "• Your notes: note that the wifi is hunter2; what did I write about the GPU bug",
  "Quick commands: what's next, my reminders, tasks, status, done 2, snooze 10m, trace",
].join("\n");

/** Deterministic greeting/ack replies (audit 15): time-of-day aware, in the reply language, no LLM call. */
export function greetReply(kind: "greet" | "thanks" | "ack", now: Date, tz: string, lang: ReplyLanguage): string {
  const h = Number(localTimeOf(now, tz).slice(0, 2));
  const part = h < 12 ? 0 : h < 17 ? 1 : h < 21 ? 2 : 3;
  if (lang === "English") {
    if (kind === "thanks") return "Anytime! Anything else?";
    if (kind === "ack") return "Got it.";
    return `${["Good morning", "Good afternoon", "Good evening", "Hi"][part]}! What can I do for you?`;
  }
  if (kind === "thanks") return "Koi baat nahi! Aur kuch?";
  if (kind === "ack") return "Theek hai.";
  return `${["Good morning", "Good afternoon", "Good evening", "Namaste"][part]}! Bataiye, kya karna hai?`;
}

export const UNSUPPORTED ="I can't do that yet. I can set reminders, manage tasks, and answer from your notes and GitHub.";
export const DIDNT_GET = "Sorry, I didn't get that. You can say: remind me at 6pm to call mom, add task pay rent, or what are today's tasks.";
export const GREETING = "Hi! What can I do for you?";
