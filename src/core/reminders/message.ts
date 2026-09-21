// Reminder message text (PLAN_V3 B.5): plain text, no markdown, always WHAT + WHEN + HOW TO ACT.
import { oneLine } from "../channels/format.ts";
import { daysBetweenLocalDates, localDateOf, localTimeOf } from "../time.ts";
import type { AgentContext, Deadline, Reminder } from "../types.ts";

const REPLY_LINE = "Reply: done, snooze 10m, or snooze 1h";
const BATCH_REPLY_LINE = "Reply 'done <n>' or 'snooze <n> <dur>'.";
const MAX_ITEM_CHARS = 400;
const GITHUB_URL_RE = /^https:\/\/github\.com\/([^/]+\/[^/]+)\//;

const isZeroKind = (kind: string): boolean => kind === "0" || kind.startsWith("snooze:");

/** "Reminder" / "default" (the bare category id, A.1) / "" all mean no real subject was ever captured. */
function displayTitle(raw: string): string {
  const t = oneLine(raw);
  if (t === "" || t === "Reminder" || t === "default") return "Reminder (no subject given)";
  return t.length <= 120 ? t : `${t.slice(0, 119)}…`;
}

function dayLabel(at: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short" }).format(at);
}

/** "Tue 22 Sep, 06:00" when the deadline carries a real clock time, else just "Tue 22 Sep". */
function dueClause(at: Date, tz: string, timed: boolean): string {
  const day = dayLabel(at, tz);
  return timed ? `${day}, ${localTimeOf(at, tz)}` : day;
}

const UNIT: Record<string, string> = { d: "day", h: "hour", m: "minute" };

/** "24h" -> "In 24 hours"; "0"/"snooze:*" never reach here (isZeroKind handles them first). */
function offsetPhrase(kind: string): string {
  const m = /^(\d+)(m|h|d)$/.exec(kind);
  if (!m) return "Reminder";
  const n = Number(m[1]);
  const unit = UNIT[m[2]!]!;
  return `In ${n} ${unit}${n === 1 ? "" : "s"}`;
}

/** Past this lateness an early-offset label ("In 24 hours") would be false, so the heading is recomputed. */
const LATE_GRACE_MS = 15 * 60_000;

const plural = (n: number, unit: string): string => `In ${n} ${unit}${n === 1 ? "" : "s"}`;

/**
 * Heading for an early-offset row. On time (or a retry within the grace) it is the offset label. Fired LATE (a
 * deadline discovered after its heads-up moment, e.g. a GitHub milestone first polled on its due day, or delivery
 * held up), the label is recomputed from the real time left, so the owner is never told "In 24 hours" about
 * something due now. Date-only deadlines (timed=false) are phrased by day: their clock time is a filler.
 */
function earlyHeading(d: Deadline, r: Reminder, ctx: AgentContext): string {
  const now = ctx.clock.now();
  if (now.getTime() - new Date(r.fireAt).getTime() <= LATE_GRACE_MS) return offsetPhrase(r.kind);
  const tz = ctx.clock.tz;
  const due = new Date(d.dueAt);
  if (d.timed !== true) {
    const days = daysBetweenLocalDates(localDateOf(now, tz), localDateOf(due, tz));
    if (days <= 0) return "Due today";
    if (days === 1) return "Due tomorrow";
    return plural(days, "day");
  }
  const left = due.getTime() - now.getTime();
  if (left <= 60_000) return "Due now";
  if (left < 3_600_000) return plural(Math.ceil(left / 60_000), "minute");
  if (left < 48 * 3_600_000) return plural(Math.round(left / 3_600_000), "hour");
  return plural(Math.round(left / 86_400_000), "day");
}

/** owner/repo only, never the full URL. */
function repoRef(sourceRef: string): string | null {
  const m = GITHUB_URL_RE.exec(sourceRef);
  return m ? m[1]! : null;
}

export function reminderText(d: Deadline, r: Reminder, ctx: AgentContext): string {
  const tz = ctx.clock.tz;
  const title = displayTitle(d.title);

  if (isZeroKind(r.kind)) {
    if (d.source === "chat") {
      const fireLocal = localTimeOf(new Date(r.fireAt), tz);
      let setAt = "";
      if (r.kind === "0") {
        const createdAt = new Date(r.createdAt);
        const t = localTimeOf(createdAt, tz);
        const sameDay = localDateOf(createdAt, tz) === localDateOf(ctx.clock.now(), tz);
        setAt = ` You set it at ${t}${sameDay ? "" : ` on ${dayLabel(createdAt, tz)}`}.`;
      }
      return [`⏰ Reminder: ${title}`, `Due now (${fireLocal}).${setAt}`, REPLY_LINE].join("\n").slice(0, MAX_ITEM_CHARS);
    }
    const repo = repoRef(d.sourceRef);
    return `⏰ Due now: ${title}${repo ? ` (${repo})` : ""}`.slice(0, MAX_ITEM_CHARS);
  }

  const when = dueClause(new Date(d.dueAt), tz, d.timed === true);
  return [`⏰ ${earlyHeading(d, r, ctx)}: ${title} (${when})`, REPLY_LINE].join("\n").slice(0, MAX_ITEM_CHARS);
}

export function reminderBatchText(items: { d: Deadline; r: Reminder }[], ctx: AgentContext): string {
  const tz = ctx.clock.tz;
  const lines = [`⏰ ${items.length} reminders`];
  items.forEach((it, i) => {
    const title = displayTitle(it.d.title);
    const due = localTimeOf(new Date(it.r.fireAt), tz);
    lines.push(`• ${i + 1}. ${title} (due ${due})`);
  });
  lines.push(BATCH_REPLY_LINE);
  return lines.join("\n");
}
