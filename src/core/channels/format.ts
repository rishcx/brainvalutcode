// Message formatting shared by every channel. Web-standard only.
import type { Target } from "../agent/contract.ts";
import { addDaysToLocalDate, localDateOf, localTimeOf } from "../time.ts";
import type { AgentContext, Deadline } from "../types.ts";

const isHigh = (c: number): boolean => c >= 0xd800 && c <= 0xdbff;

/** Cut point <= limit that never lands between the halves of a surrogate pair. */
function safeCut(s: string, limit: number): number {
  if (s.length <= limit) return s.length;
  return isHigh(s.charCodeAt(limit - 1)) ? limit - 1 : limit;
}

/** Splits on paragraph, then line, then hard-cuts. Never returns an empty chunk. */
export function chunk(text: string, limit = 4096): string[] {
  const max = Math.max(2, Math.floor(limit));
  const out: string[] = [];
  const push = (s: string): void => {
    if (s.trim()) out.push(s);
  };
  const pack = (s: string, seps: string[]): void => {
    if (s.length <= max) return push(s);
    const sep = seps[0];
    if (sep === undefined) {
      let rest = s;
      while (rest.length > max) {
        const at = safeCut(rest, max);
        push(rest.slice(0, at));
        rest = rest.slice(at);
      }
      return push(rest);
    }
    let cur = "";
    for (const part of s.split(sep)) {
      if (part.length > max) {
        push(cur);
        cur = "";
        pack(part, seps.slice(1));
      } else if (cur === "") {
        cur = part;
      } else if (cur.length + sep.length + part.length <= max) {
        cur += sep + part;
      } else {
        push(cur);
        cur = part;
      }
    }
    push(cur);
  };
  pack(text, ["\n\n", "\n"]);
  return out;
}

export const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

/** The numbering `done <n>` / `confirm <n>` refer to: soonest first. */
export function listingOrder(ds: Deadline[]): Deadline[] {
  return [...ds].sort((a, b) => a.dueAt.localeCompare(b.dueAt) || a.id.localeCompare(b.id));
}

/**
 * v3: numbering is per (channel, peer) so one recipient's `done <n>` never resolves against another
 * channel's list (PLAN_V3 A.7). Legacy callers (no `who`) keep the single shared key.
 */
export function lastListKey(who?: Target): string {
  return who ? `last:list:${who.channel}:${who.peer}` : "last:list";
}

/** Persists the numbering so it survives to the next inbound message. */
export async function persistListing(ctx: AgentContext, ds: Deadline[], who?: Target): Promise<void> {
  await ctx.store.kvSet(lastListKey(who), JSON.stringify(ds.map((d) => ({ k: "d", id: d.id }))), ctx.clock.now().toISOString());
}

const ON_TIME_MS = 90_000;

/** "18:00", "tomorrow 18:00", "Mon 5 Oct 18:00"; date only when the deadline has no real clock time. */
function dueLabel(d: Deadline, nowMs: number, tz: string): string {
  const at = new Date(d.dueAt);
  if (Math.abs(at.getTime() - nowMs) <= ON_TIME_MS) return ""; // the reminder IS the due moment: nothing to add
  const today = localDateOf(new Date(nowMs), tz);
  const date = localDateOf(at, tz);
  const day =
    date === today
      ? "today"
      : date === addDaysToLocalDate(today, 1)
        ? "tomorrow"
        : new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short" }).format(at);
  if (d.timed !== true) return day;
  return date === today ? localTimeOf(at, tz) : `${day} ${localTimeOf(at, tz)}`;
}

/**
 * Plain text, no markdown (Telegram and WhatsApp render it as typed). One item: "⏰ <title>". Several: a short
 * bulleted list, numbered so `done <n>` works. The caller persists the numbering with persistListing(ctx, listingOrder(ds)).
 */
export function formatReminderBatch(ds: Deadline[], ctx: AgentContext): string {
  const ordered = listingOrder(ds);
  const nowMs = ctx.clock.now().getTime();
  const tz = ctx.clock.tz;
  const line = (d: Deadline): string => {
    const when = dueLabel(d, nowMs, tz);
    return `${oneLine(d.title)}${when ? ` (due ${when})` : ""}`;
  };
  if (ordered.length === 1) return `⏰ ${line(ordered[0]!)}`;
  return [
    `⏰ ${ordered.length} reminders`,
    ...ordered.map((d, i) => `• ${i + 1}. ${line(d)}`),
    "",
    "Reply 'done <n>' when one is finished.",
  ].join("\n");
}

export async function formatStatus(ctx: AgentContext, who?: Target): Promise<string> {
  const tz = ctx.clock.tz;
  const open = listingOrder(await ctx.store.listDeadlines({ status: ["open"] }));
  const proposed = listingOrder(await ctx.store.listDeadlines({ status: ["proposed"] }));
  const all = [...open, ...proposed];
  await persistListing(ctx, all, who);
  const row = (d: Deadline, i: number): string => `${i}. ${localDateOf(new Date(d.dueAt), tz)} - ${oneLine(d.title)}`;
  const lines = [`Open deadlines (${open.length})`];
  lines.push(...(open.length ? open.map((d, i) => row(d, i + 1)) : ["none"]));
  if (proposed.length) {
    lines.push("", "Awaiting confirmation (reply 'confirm <n>'):");
    lines.push(...proposed.map((d, i) => row(d, open.length + i + 1)));
  }
  const openIds = new Set(open.map((d) => d.id));
  const next = (await ctx.store.dueReminders("9999-12-31T00:00:00.000Z")).find((r) => openIds.has(r.deadlineId));
  lines.push("", `Next reminder: ${next ? `${localDateOf(new Date(next.fireAt), tz)} (${next.kind})` : "none scheduled"}`);
  const jobs = await ctx.store.listJobs();
  const last = jobs.filter((j) => j.lastRunAt).sort((a, b) => b.lastRunAt!.localeCompare(a.lastRunAt!))[0];
  lines.push(`Last job: ${last ? `${last.name} ${last.lastStatus ?? "?"} at ${last.lastRunAt}` : "none yet"}`);
  return lines.join("\n");
}
