// Deadline -> reminder rows -> one batched message per channel. Idempotent end to end.
import { formatReminderBatch, listingOrder, persistListing } from "../channels/format.ts";
import { parseOffset, shiftOutOfQuietHours } from "../time.ts";
import type { AgentContext, Deadline, QuietHours, ReminderRule } from "../types.ts";
import { categorise, loadRules, offsetsFor, ruleFor } from "./rules.ts";

export interface PlannedFire {
  kind: string;
  span: number;
  fireAt: Date;
}

/** Pure. A quiet-hours shift never moves a fire past the due instant: a ping in quiet hours beats one after the event. */
export function planFires(due: Date, offsets: string[], tz: string, q: QuietHours): PlannedFire[] {
  return offsets.map((kind) => {
    const span = parseOffset(kind);
    const raw = new Date(due.getTime() - span);
    const shifted = shiftOutOfQuietHours(raw, tz, q);
    return { kind, span, fireAt: shifted.getTime() > due.getTime() ? raw : shifted };
  });
}

export interface MaterialiseOpts {
  /** Replaces the category's offsets for this call. */
  offsets?: string[];
  /** Fire at due-minus-offset exactly, never shifting out of quiet hours. */
  ignoreQuietHours?: boolean;
}

/**
 * Offsets for an explicit "remind me" request: the due time itself, plus the category rule's early offsets
 * that are still in the future. The default category gets exactly one reminder, at the due time.
 */
export function explicitOpts(d: Deadline, rules: ReminderRule[], nowMs: number): MaterialiseOpts {
  const category = categorise(d, rules);
  const rule = category === "default" ? undefined : ruleFor(category, rules);
  const due = new Date(d.dueAt).getTime();
  const early = (rule?.offsets ?? []).filter((o) => {
    const span = parseOffset(o);
    return span > 0 && due - span > nowMs;
  });
  return { offsets: [...new Set([...early, "0"])], ignoreQuietHours: true };
}

/** An explicit chat reminder is a deadline written by chat with confidence 1 (a confirmed proposal keeps 0.9). */
const isExplicitChat = (d: Deadline): boolean => d.source === "chat" && d.confidence === 1;

export async function materialise(
  ctx: AgentContext,
  d: Deadline,
  rules?: ReminderRule[],
  opts?: MaterialiseOpts,
): Promise<number> {
  if (d.status !== "open") {
    await ctx.store.deleteUnsentReminders(d.id);
    return 0;
  }
  const rs = rules ?? (await loadRules(ctx));
  const category = categorise(d, rs);
  const { quietHours } = ctx.config.reminders;
  const now = ctx.clock.now().getTime();
  const o = opts ?? (isExplicitChat(d) ? explicitOpts(d, rs, now) : undefined);
  const offsets = o?.offsets ?? offsetsFor(category, rs, ctx.config);
  const due = new Date(d.dueAt);
  const planned = o?.ignoreQuietHours
    ? offsets.map((kind): PlannedFire => {
        const span = parseOffset(kind);
        return { kind, span, fireAt: new Date(due.getTime() - span) };
      })
    : planFires(due, offsets, ctx.clock.tz, quietHours);
  const kinds = new Set(planned.map((p) => p.kind));
  let existing = await ctx.store.listReminders(d.id);
  // category changed: drop the old plan. A pending snooze row is never "stale" on its own (it is never one of
  // `kinds`) and must survive an unrelated re-materialise, so it is excluded from the trigger.
  const stale = existing.some((r) => r.sentAt === null && !r.kind.startsWith("snooze:") && !kinds.has(r.kind));
  if (stale) {
    await ctx.store.deleteUnsentReminders(d.id);
    existing = existing.filter((r) => r.sentAt !== null);
  }
  const byKind = new Map(existing.map((r) => [r.kind, r]));
  let written = 0;
  for (const p of planned) {
    // Late discovery: do not replay a week of missed reminders. T-0 always fires once.
    if (p.span > 0 && p.fireAt.getTime() < now - p.span) continue;
    written++;
    const iso = p.fireAt.toISOString();
    const cur = byKind.get(p.kind);
    if (cur && cur.fireAt === iso) continue; // unchanged: no store write (PLAN_V3 A.11a)
    await ctx.store.upsertReminder({ deadlineId: d.id, kind: p.kind, fireAt: iso });
  }
  return written;
}

/**
 * Source-job write path (PLAN_V3 B.10 "GitHub/manual/Gmail upserts call `materialise` for changed rows only"):
 * upsert each deadline, then materialise the ones that are new or whose schedule-relevant fields changed, so a
 * freshly polled deadline gets its reminder rows now instead of waiting for the next reconcile. The effective
 * status mirrors the store's upsert rule (a done/dismissed row stays closed). Returns rows materialised.
 */
export async function upsertAndMaterialise(ctx: AgentContext, ds: Deadline[]): Promise<number> {
  if (ds.length === 0) return 0;
  const before = new Map((await ctx.store.listDeadlines()).map((d) => [d.id, d]));
  let rules: ReminderRule[] | undefined;
  let n = 0;
  for (const d of ds) {
    await ctx.store.upsertDeadline(d);
    const old = before.get(d.id);
    const closed = old?.status === "done" || old?.status === "dismissed";
    const effective: Deadline = closed && old ? { ...d, status: old.status } : d;
    const changed =
      !old ||
      old.dueAt !== effective.dueAt ||
      old.status !== effective.status ||
      (old.category ?? "default") !== (effective.category ?? "default") ||
      old.title !== effective.title;
    if (!changed) continue;
    rules ??= await loadRules(ctx);
    n += await materialise(ctx, effective, rules);
  }
  return n;
}

export async function materialiseAll(ctx: AgentContext): Promise<number> {
  let n = 0;
  const rules = await loadRules(ctx);
  // Open/proposed only: closed deadlines have nothing to schedule, and visiting them cost one write each, which
  // pushed the reconcile job past the 50-subrequest limit at ~46 stored deadlines.
  const live = await ctx.store.listDeadlines({ status: ["open", "proposed"] });
  for (const d of live) n += await materialise(ctx, d, rules);
  // Unsent rows of deadlines that were closed meanwhile: found with ONE query, deleted only when they exist.
  const liveIds = new Set(live.map((d) => d.id));
  const orphans = new Set((await ctx.store.dueReminders("9999-12-31T00:00:00.000Z")).map((r) => r.deadlineId).filter((id) => !liveIds.has(id)));
  for (const id of orphans) await ctx.store.deleteUnsentReminders(id);
  return n;
}

export async function sweep(ctx: AgentContext): Promise<{ sent: number; channels: string[] }> {
  const channels = ctx.channels ?? [];
  if (channels.length === 0) return { sent: 0, channels: [] };
  const nowIso = ctx.clock.now().toISOString();
  const due = await ctx.store.dueReminders(nowIso);
  if (due.length === 0) return { sent: 0, channels: [] };

  const live = new Map<string, Deadline>();
  const consume: number[] = []; // rows to mark sent once announced (or orphaned)
  for (const r of due) {
    const d = live.get(r.deadlineId) ?? (await ctx.store.getDeadline(r.deadlineId));
    if (d === null) consume.push(r.id);
    else if (d.status === "open") {
      live.set(d.id, d);
      consume.push(r.id);
    }
    // closed deadlines: row left alone; materialiseAll deletes it
  }
  if (live.size === 0) {
    if (consume.length) await ctx.store.markRemindersSent(consume, nowIso);
    return { sent: 0, channels: [] };
  }

  const ds = listingOrder([...live.values()]);
  const text = formatReminderBatch(ds, ctx);
  await persistListing(ctx, ds);
  const results = await Promise.allSettled(channels.map((c) => c.send(text)));
  const ok = channels.filter((_, i) => results[i]!.status === "fulfilled").map((c) => c.id);
  if (ok.length === 0) {
    const why = results.map((r) => (r.status === "rejected" ? String(r.reason instanceof Error ? r.reason.message : r.reason) : "")).join("; ");
    throw new Error(`reminder send failed on every channel: ${why}`);
  }
  await ctx.store.markRemindersSent(consume, nowIso);
  return { sent: ds.length, channels: ok };
}
