// Snooze/done/cancel helpers (PLAN_V3 B.5). Quiet hours never apply to a snooze: the user picked the time.
import type { Target } from "../agent/contract.ts";
import { HOUR } from "../time.ts";
import type { AgentContext, Deadline } from "../types.ts";

const DUR_RE = /^(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours)?$/i;

/** "10m" | "10 min" | "1h" | "90" (bare number = minutes) -> whole minutes, clamped to 1..1440; else null. */
export function parseSnoozeDuration(s: string): number | null {
  const m = DUR_RE.exec(s.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = (m[2] ?? "m").toLowerCase();
  const minutes = unit.startsWith("h") ? n * 60 : n;
  return minutes >= 1 && minutes <= 1440 ? Math.round(minutes) : null;
}

const lastReminderKey = (who: Target): string => `last:reminder:${who.channel}:${who.peer}`;

/** Deadline ids from the most recent delivery to `who`, only when it landed within `withinMs` (default 3h). */
export async function lastDelivered(ctx: AgentContext, who: Target, withinMs = 3 * HOUR): Promise<string[]> {
  const raw = await ctx.store.kvGet(lastReminderKey(who));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { ids?: unknown; at?: unknown };
    if (!Array.isArray(parsed.ids) || typeof parsed.at !== "string") return [];
    const at = Date.parse(parsed.at);
    if (!Number.isFinite(at) || ctx.clock.now().getTime() - at > withinMs) return [];
    return parsed.ids.filter((x): x is string => typeof x === "string" && x.length > 0);
  } catch {
    return [];
  }
}

function ceilToMinute(ms: number): number {
  return Math.ceil(ms / 60_000) * 60_000;
}

/** Reopens the deadline (it may have auto-closed) and schedules a new `snooze:<unix s>` row, quiet hours ignored. */
export async function snoozeReminder(
  ctx: AgentContext,
  deadlineId: string,
  minutes: number,
): Promise<{ ok: true; title: string; fireAt: string } | { ok: false; reason: "not-found" | "bad-duration" }> {
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440) return { ok: false, reason: "bad-duration" };
  const d = await ctx.store.getDeadline(deadlineId);
  if (!d) return { ok: false, reason: "not-found" };

  const now = ctx.clock.now().getTime();
  const fireAt = new Date(ceilToMinute(now + minutes * 60_000)).toISOString();
  if (d.status !== "open") await ctx.store.setDeadlineStatus(deadlineId, "open");
  await ctx.store.upsertReminder({ deadlineId, kind: `snooze:${Math.floor(now / 1000)}`, fireAt });
  return { ok: true, title: d.title, fireAt };
}

/** `done` -> status "done"; `cancel` -> status "dismissed". Either way, unsent rows are dropped. */
export async function closeReminder(ctx: AgentContext, deadlineId: string, status: "done" | "dismissed"): Promise<Deadline | null> {
  const d = await ctx.store.getDeadline(deadlineId);
  if (!d) return null;
  await ctx.store.setDeadlineStatus(deadlineId, status);
  await ctx.store.deleteUnsentReminders(deadlineId);
  return { ...d, status };
}
