// Reminder delivery v2 (PLAN_V3 B.5/B.10): claim-then-send, per-origin routing, batch numbering, auto-close.
// Replaces `sweep` in the minute job; `sweep` itself stays exported and unchanged for legacy tests.
import type { Target } from "../agent/contract.ts";
import { persistListing } from "../channels/format.ts";
import { beginTrace, finishTrace, preview } from "../trace/record.ts";
import { localDateOf } from "../time.ts";
import type { AgentContext, Channel, ChannelId, Config, Deadline, Reminder } from "../types.ts";
import { reminderBatchText, reminderText } from "./message.ts";

const CLAIM_STALE_MS = 5 * 60_000;
const MAX_ATTEMPTS = 3;
const BATCH_THRESHOLD = 3;

type Item = { d: Deadline; r: Reminder };

function allowlistFor(cfg: Config, ch: ChannelId): string[] {
  return (ch === "telegram" ? cfg.channels.telegram.allowedChatIds : cfg.channels.whatsapp.allowedWaIds).map(String);
}

/**
 * origin (its channel enabled and its peer allowlisted) -> defaultChannel's first allowlisted peer ->
 * the first enabled channel with an allowlisted peer -> null when none can receive anything.
 */
export function targetFor(d: Deadline, cfg: Config, enabled: ChannelId[]): Target | null {
  const origin = d.originChannel;
  const peer = d.originPeer;
  if (origin && peer && enabled.includes(origin) && allowlistFor(cfg, origin).includes(peer)) {
    return { channel: origin, peer };
  }
  const def = cfg.channels.defaultChannel;
  if (enabled.includes(def)) {
    const p = allowlistFor(cfg, def)[0];
    if (p) return { channel: def, peer: p };
  }
  for (const ch of enabled) {
    const p = allowlistFor(cfg, ch)[0];
    if (p) return { channel: ch, peer: p };
  }
  return null;
}

async function loadDeadlines(ctx: AgentContext, due: Reminder[]): Promise<Map<string, Deadline | null>> {
  const ids = [...new Set(due.map((r) => r.deadlineId))];
  const entries = await Promise.all(ids.map(async (id): Promise<[string, Deadline | null]> => [id, await ctx.store.getDeadline(id)]));
  return new Map(entries);
}

/** An explicit chat reminder closes itself once its T-0 (or a snooze) row has been delivered (PLAN_V3 A.11i). */
const autoCloses = (d: Deadline, r: Reminder): boolean =>
  d.source === "chat" && d.confidence === 1 && (r.kind === "0" || r.kind.startsWith("snooze:"));

async function afterSuccess(ctx: AgentContext, target: Target, items: Item[], claim: string, text: string, nowIso: string): Promise<void> {
  for (const it of items) await ctx.store.finishReminder(it.r.id, claim, { sentAt: nowIso });
  for (const it of items) {
    if (autoCloses(it.d, it.r)) await ctx.store.setDeadlineStatus(it.d.id, "done");
  }
  await persistListing(ctx, items.map((it) => it.d), target);
  await ctx.store.kvSet(
    `last:reminder:${target.channel}:${target.peer}`,
    JSON.stringify({ ids: items.map((it) => it.d.id), at: nowIso }),
    nowIso,
  );
  await ctx.store.appendTurn({
    channel: target.channel,
    peer: target.peer,
    localDate: localDateOf(new Date(nowIso), ctx.clock.tz),
    role: "assistant",
    text,
    at: nowIso,
  });
}

async function releaseFailed(ctx: AgentContext, claim: string, items: Item[], msg: string): Promise<boolean> {
  let gaveUp = false;
  for (const it of items) {
    const attempts = (it.r.attempts ?? 0) + 1;
    if (attempts >= MAX_ATTEMPTS) {
      gaveUp = true;
      await ctx.store.finishReminder(it.r.id, claim, { sentAt: ctx.clock.now().toISOString() });
    } else {
      await ctx.store.finishReminder(it.r.id, claim, { error: msg });
    }
  }
  return gaveUp;
}

async function deliverUnit(
  ctx: AgentContext,
  target: Target,
  ch: Channel,
  items: Item[],
  claim: string,
  touched: Set<string>,
): Promise<{ sent: number; failed: number }> {
  const text = items.length === 1 ? reminderText(items[0]!.d, items[0]!.r, ctx) : reminderBatchText(items, ctx);
  const trace = beginTrace(ctx, target, "reminder", null);
  trace.route = "reminder";
  trace.intent = [...new Set(items.map((it) => it.r.kind))].join(",");
  trace.replyChars = text.length;

  try {
    if (ch.sendTo) await ch.sendTo(target.peer, text);
    else await ch.send(text);
    const nowIso = ctx.clock.now().toISOString();
    await afterSuccess(ctx, target, items, claim, text, nowIso);
    trace.replyPreview = preview(text);
    touched.add(target.channel);
    await finishTrace(ctx, trace, "ok");
    return { sent: items.length, failed: 0 };
  } catch (e1) {
    const msg1 = e1 instanceof Error ? e1.message : String(e1);

    if (target.channel === "whatsapp") {
      const def = ctx.config.channels.defaultChannel;
      if (def !== "whatsapp") {
        const defCh = (ctx.channels ?? []).find((c) => c.id === def);
        const defPeer = allowlistFor(ctx.config, def)[0];
        if (defCh && defPeer) {
          try {
            const fbTarget: Target = { channel: def, peer: defPeer };
            if (defCh.sendTo) await defCh.sendTo(defPeer, text);
            else await defCh.send(text);
            const nowIso = ctx.clock.now().toISOString();
            await afterSuccess(ctx, fbTarget, items, claim, text, nowIso);
            trace.replyPreview = preview(text);
            touched.add(def);
            await finishTrace(ctx, trace, `fallback:${def}`);
            return { sent: items.length, failed: 0 };
          } catch {
            /* fall through to the ordinary failure path below, using the ORIGINAL (whatsapp) error */
          }
        }
      }
    }

    const gaveUp = await releaseFailed(ctx, claim, items, msg1);
    if (gaveUp) {
      // Last resort: tell the owner on the default channel that a reminder could not be delivered, and what it was.
      const def = ctx.config.channels.defaultChannel;
      const defCh = (ctx.channels ?? []).find((c) => c.id === def);
      const defPeer = allowlistFor(ctx.config, def)[0];
      const note = `I could not deliver ${items.length === 1 ? "a reminder" : `${items.length} reminders`} on ${target.channel}: ${items.map((it) => it.d.title).join("; ").slice(0, 300)}`;
      if (defCh && defPeer && def !== target.channel) await (defCh.sendTo ? defCh.sendTo(defPeer, note) : defCh.send(note)).catch(() => undefined);
      console.error("reminder gave up:", target.channel, msg1);
    }
    trace.error = msg1;
    touched.add(target.channel);
    await finishTrace(ctx, trace, gaveUp ? "error:gave-up" : `error:${msg1}`, msg1);
    return { sent: 0, failed: items.length };
  }
}

export async function deliverDue(ctx: AgentContext): Promise<{ sent: number; failed: number; targets: string[] }> {
  const channels = ctx.channels ?? [];
  if (channels.length === 0) return { sent: 0, failed: 0, targets: [] };
  const nowIso = ctx.clock.now().toISOString();
  const due = await ctx.store.dueReminders(nowIso);
  if (due.length === 0) return { sent: 0, failed: 0, targets: [] };

  const deadlines = await loadDeadlines(ctx, due);
  const enabledIds = channels.map((c) => c.id);
  const discard: number[] = [];
  const groups = new Map<string, { target: Target; items: Item[] }>();

  for (const r of due) {
    const d = deadlines.get(r.deadlineId) ?? null;
    if (!d || d.status !== "open") {
      discard.push(r.id); // orphan/closed: consume the row, nothing to announce
      continue;
    }
    const target = targetFor(d, ctx.config, enabledIds);
    if (!target) continue; // no reachable channel right now: leave the row for the next tick
    const key = `${target.channel}:${target.peer}`;
    const g = groups.get(key) ?? { target, items: [] };
    g.items.push({ d, r });
    groups.set(key, g);
  }
  if (discard.length) await ctx.store.markRemindersSent(discard, nowIso);
  if (groups.size === 0) return { sent: 0, failed: 0, targets: [] };

  let sent = 0;
  let failed = 0;
  const touched = new Set<string>();
  for (const { target, items } of groups.values()) {
    const claim = crypto.randomUUID();
    const now = ctx.clock.now().toISOString();
    const staleBefore = new Date(ctx.clock.now().getTime() - CLAIM_STALE_MS).toISOString();
    const won = await ctx.store.claimReminders(items.map((it) => it.r.id), claim, now, staleBefore);
    if (won.length === 0) continue; // another invocation already owns these rows
    const wonSet = new Set(won);
    const wonItems = items.filter((it) => wonSet.has(it.r.id));
    const ch = channels.find((c) => c.id === target.channel);
    if (!ch) continue; // unreachable: target only ever names an id present in `channels`

    const units: Item[][] = wonItems.length <= BATCH_THRESHOLD ? wonItems.map((it) => [it]) : [wonItems];
    for (const unit of units) {
      const r = await deliverUnit(ctx, target, ch, unit, claim, touched);
      sent += r.sent;
      failed += r.failed;
    }
  }
  return { sent, failed, targets: [...touched] };
}
