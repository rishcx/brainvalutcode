// Reminder tools. Subjects and times come only from the user's words (provenance); the reply is code-rendered.
import { lastListKey, listingOrder, oneLine, persistListing } from "../../channels/format.ts";
import { createReminder } from "../../reminders/create.ts";
import { explicitOpts, materialise } from "../../reminders/engine.ts";
import { loadRules } from "../../reminders/rules.ts";
import { closeReminder, lastDelivered, snoozeReminder } from "../../reminders/snooze.ts";
import { parseListRefs } from "../../tasks/service.ts";
import { dueAtFromLocalDateTime, localDateOf, localTimeOf } from "../../time.ts";
import type { AgentContext, Deadline } from "../../types.ts";
import type { Ref, ToolResult } from "../contract.ts";
import { askWhich, normWhen, question, resolveWhen, type ResolvedWhen } from "../dialog.ts";
import { hasTimeToken, matchSpan, norm } from "../provenance.ts";
import { numberedList, reminderMoved, reminderSet, whenLabel } from "../render.ts";
import type { ToolEnv } from "./index.ts";

const GENERIC = /^(?:(?:a|an|the|my|one|some)\s+)?(?:reminder|reminders|remainder|timer|alarm|default|something|anything|it|this|that|thing)$/;

/** Strips "remind me to", "to", "about"... and a trailing time phrase the user embedded in the subject. */
const LEAD = /^(?:(?:please|pls)\s+)?(?:remind\s+me\s+)?(?:me\s+)?(?:to|about|that|for|of)\s+/i;

export function tidyWhat(what: string, whenText: string | null): string {
  let t = what.replace(/\s+/g, " ").trim().replace(LEAD, "");
  if (whenText) {
    // The time may lead the subject ("at 6 call mom"), so strip it wherever it sits and re-run the lead cleanup.
    const i = t.toLowerCase().indexOf(whenText.toLowerCase());
    if (i >= 0) {
      const cut = `${t.slice(0, i)} ${t.slice(i + whenText.length)}`.replace(/\s+/g, " ").trim();
      if (cut) t = cut.replace(LEAD, "");
    }
  }
  return t.replace(/[\s,.;:!?-]+$/, "").slice(0, 200);
}

interface Timing {
  when: ResolvedWhen | null;
  whenText: string | null;
  past: boolean;
  /** "next friday 5": a bare 1-12 hour right after a date word, which no parser read as a clock time. */
  ambiguous: string | null;
  flags: string[];
}

// time.ts is frozen, so the ambiguity lives here: <date word> <bare 1-2 digits>, with no "at"/am/pm/colon anywhere.
const BARE_HOUR =
  /\b(today|tomorrow|day\s+after\s+tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{4}-\d{2}-\d{2})\s+(\d{1,2})\b(?![:.\d])/i;

/** "Did you mean friday 5 am or friday 5 pm?" for an hour the parsers silently defaulted away, else null. */
export function ambiguousHour(whenText: string): string | null {
  const m = BARE_HOUR.exec(normWhen(whenText));
  if (!m) return null;
  const h = Number(m[2]);
  return h >= 1 && h <= 12 ? `Did you mean ${m[1]!.toLowerCase()} ${h} am or ${m[1]!.toLowerCase()} ${h} pm?` : null;
}

/** Parser is authoritative; the model's at_local only when the user's words hold a time token (PLAN_V3 B.3). */
export function resolveTiming(ctx: AgentContext, args: Record<string, unknown>, env: ToolEnv): Timing {
  const tz = ctx.clock.tz;
  const flags: string[] = [];
  let whenText: string | null = null;
  let when: ResolvedWhen | null = null;
  if (typeof args.when_text === "string" && args.when_text) {
    whenText = matchSpan(args.when_text, env.sources);
    if (whenText === null) flags.push("provenance_miss:when");
    else when = resolveWhen(whenText, tz, env.now, ctx.config.reminders.dueHourLocal);
  }
  const al = typeof args.at_local === "string" ? /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/.exec(args.at_local) : null;
  if (al && hasTimeToken(env.sources)) {
    try {
      const model = dueAtFromLocalDateTime(al[1]!, al[2]!, tz, 0);
      if (!when) when = { dueAt: model, timed: true };
      else if (Math.abs(Date.parse(model) - Date.parse(when.dueAt)) > 60_000) flags.push("time_disagree");
    } catch {
      flags.push("bad_at_local");
    }
  }
  // A date-only resolution whose text still holds a bare hour: ask instead of silently using dueHourLocal.
  const ambiguous = when && !when.timed && whenText ? ambiguousHour(whenText) : null;
  if (ambiguous) flags.push("ambiguous_hour");
  const past = when !== null && Date.parse(when.dueAt) < env.now.getTime();
  return { when: ambiguous || past ? null : when, whenText, past, ambiguous, flags };
}

export async function createReminderTool(ctx: AgentContext, args: Record<string, unknown>, env: ToolEnv): Promise<ToolResult> {
  const t = resolveTiming(ctx, args, env);
  const flags = [...t.flags];
  let what: string | null = null;
  if (typeof args.what === "string" && args.what) {
    const span = matchSpan(args.what, env.sources);
    if (span === null) flags.push("provenance_miss:what");
    else {
      const tidy = tidyWhat(span, t.whenText);
      if (tidy && !GENERIC.test(norm(tidy))) what = tidy;
    }
  }
  const missing = [...(what ? [] : ["what"]), ...(t.when ? [] : ["when"])];
  if (missing.length) {
    const slots = { what, when_text: t.when ? t.whenText : null };
    const q = question(missing[0]!, slots);
    const ask = missing[0] !== "when" ? q : t.ambiguous ? t.ambiguous : t.past ? `That time has passed. ${q}` : q;
    return { ok: false, missing, flags, render: ask, data: { slots } };
  }
  const id = `chat:${env.msg.id}:${env.index ?? 0}`;
  const r = await createReminder(ctx, {
    title: what!, dueAt: t.when!.dueAt, timed: t.when!.timed, category: "default", explicit: true, relative: true,
    id, sourceRef: env.msg.id, origin: env.who,
  });
  return { ok: true, flags, entityId: r.id, title: what!, render: reminderSet(what!, r.dueAt, env.now, ctx.clock.tz) };
}

type Resolved = { kind: "one"; d: Deadline } | { kind: "result"; result: ToolResult };

const REF_NOISE = /\b(?:the|my|a|reminder|reminders|remainder|alarm|for|to|about)\b/g;

/** Ref -> one open chat reminder, or a result (not found / which one / missing). */
async function resolveReminder(ctx: AgentContext, ref: Ref | null, env: ToolEnv, slots: Record<string, unknown>): Promise<Resolved> {
  const found = async (id: string | undefined): Promise<Resolved | null> => {
    const d = id ? await ctx.store.getDeadline(id) : null;
    return d ? { kind: "one", d } : null;
  };
  if (!ref || ref.last) {
    const la = env.dialog?.lastAction;
    const hit = (la && /reminder/.test(la.tool) ? await found(la.id) : null) ?? (await found((await lastDelivered(ctx, env.who))[0]));
    if (hit) return hit;
    return { kind: "result", result: { ok: false, missing: ["ref"], render: "What reminder do you mean? Say its name, or send 'status' for a numbered list.", data: { slots } } };
  }
  if (ref.index !== undefined) {
    const lr = parseListRefs(await ctx.store.kvGet(lastListKey(env.who)))[ref.index - 1];
    const hit = lr?.k === "d" ? await found(lr.id) : null;
    return hit ?? { kind: "result", result: { ok: false, render: `There is no reminder ${ref.index} in your last list. Send 'status' for a fresh one.` } };
  }
  const span = matchSpan(ref.text ?? "", env.sources);
  if (span === null) {
    return { kind: "result", result: { ok: false, missing: ["ref"], flags: ["provenance_miss:ref"], render: "What reminder do you mean? Say its name, or send 'status' for a numbered list.", data: { slots } } };
  }
  const key = norm(span).replace(REF_NOISE, " ").replace(/\s+/g, " ").trim() || norm(span);
  const open = await ctx.store.listDeadlines({ status: ["open"] });
  const hits = listingOrder(open.filter((d) => d.source === "chat" && norm(d.title).includes(key)));
  if (hits.length === 1) return { kind: "one", d: hits[0]! };
  if (hits.length === 0) return { kind: "result", result: { ok: false, render: `I couldn't find a reminder matching "${oneLine(span).slice(0, 60)}".` } };
  const cands = hits.map((d) => ({ k: "d" as const, id: d.id, title: `${oneLine(d.title)} (${whenLabel(d.dueAt, env.now, ctx.clock.tz)})` }));
  return { kind: "result", result: await askWhich(ctx, env.who, cands, slots) };
}

const refOf = (args: Record<string, unknown>): Ref | null => (args.ref && typeof args.ref === "object" ? (args.ref as Ref) : null);

export async function rescheduleReminder(ctx: AgentContext, args: Record<string, unknown>, env: ToolEnv): Promise<ToolResult> {
  const t = resolveTiming(ctx, args, env);
  const slots = { ref: refOf(args), when_text: t.when ? t.whenText : null };
  // A reminder already resolved in an earlier turn of this dialog (code-written slot, never from the model).
  const pinned = typeof args.deadline_id === "string" && env.dialog?.slots.deadline_id === args.deadline_id ? await ctx.store.getDeadline(args.deadline_id) : null;
  const r: Resolved = pinned ? { kind: "one", d: pinned } : await resolveReminder(ctx, refOf(args), env, slots);
  if (r.kind === "result") return { ...r.result, flags: [...t.flags, ...(r.result.flags ?? [])] };
  const d = r.d;
  if (!t.when) {
    const q = question("when", { what: d.title });
    const ask = t.ambiguous ? t.ambiguous : t.past ? `That time has passed. ${q}` : q;
    return { ok: false, missing: ["when"], flags: t.flags, render: ask, data: { slots: { deadline_id: d.id, what: d.title } } };
  }
  const moved: Deadline = { ...d, dueAt: t.when.dueAt, timed: t.when.timed, status: "open" };
  await ctx.store.upsertDeadline(moved);
  if (d.status !== "open") await ctx.store.setDeadlineStatus(d.id, "open");
  await ctx.store.deleteUnsentReminders(d.id);
  const firedT0 = (await ctx.store.listReminders(d.id)).some((x) => x.kind === "0" && x.sentAt !== null);
  if (firedT0) {
    // The T-0 row already fired and keeps its sent_at on upsert: schedule the new time as a snooze-kind row.
    await ctx.store.upsertReminder({ deadlineId: d.id, kind: `snooze:${Math.floor(env.now.getTime() / 1000)}`, fireAt: t.when.dueAt });
  } else {
    const rules = await loadRules(ctx);
    await materialise(ctx, moved, rules, explicitOpts(moved, rules, env.now.getTime()));
  }
  return { ok: true, flags: t.flags, entityId: d.id, title: d.title, render: reminderMoved(d.title, t.when.dueAt, env.now, ctx.clock.tz) };
}

export async function cancelReminder(ctx: AgentContext, args: Record<string, unknown>, env: ToolEnv): Promise<ToolResult> {
  const r = await resolveReminder(ctx, refOf(args), env, { ref: null });
  if (r.kind === "result") return r.result;
  await closeReminder(ctx, r.d.id, "dismissed");
  return { ok: true, entityId: r.d.id, title: r.d.title, render: `Cancelled: ${oneLine(r.d.title)}.` };
}

export async function snoozeReminderTool(ctx: AgentContext, args: Record<string, unknown>, env: ToolEnv): Promise<ToolResult> {
  const minutes = typeof args.minutes === "number" ? args.minutes : 10;
  const r = await resolveReminder(ctx, refOf(args), env, { ref: null, minutes });
  if (r.kind === "result") return r.result;
  const s = await snoozeReminder(ctx, r.d.id, minutes);
  if (!s.ok) return { ok: false, render: "I couldn't find that reminder anymore." };
  return { ok: true, entityId: r.d.id, title: s.title, render: `Snoozed: ${oneLine(s.title)} until ${localTimeOf(new Date(s.fireAt), ctx.clock.tz)}.` };
}

export async function listReminders(ctx: AgentContext, args: Record<string, unknown>, env: ToolEnv): Promise<ToolResult> {
  const range = typeof args.range === "string" ? args.range : "upcoming";
  const now = env.now.getTime();
  const tz = ctx.clock.tz;
  const today = localDateOf(env.now, tz);
  // A fired reminder auto-closes to "done", so "upcoming" is the only range that may look at open rows alone:
  // "which reminders did I have today" must still see the ones that already went off (audit 11 / B).
  const status: Deadline["status"][] = range === "upcoming" ? ["open"] : ["open", "done", "dismissed"];
  const chat = (await ctx.store.listDeadlines({ status })).filter((d) => d.source === "chat");
  const past = (d: Deadline): boolean => Date.parse(d.dueAt) <= now;
  let ds: Deadline[];
  if (range === "today") ds = listingOrder(chat.filter((d) => localDateOf(new Date(d.dueAt), tz) === today));
  else if (range === "fired") ds = listingOrder(chat.filter((d) => past(d) && localDateOf(new Date(d.dueAt), tz) === today)).reverse();
  else if (range === "past") ds = listingOrder(chat.filter((d) => past(d) && Date.parse(d.dueAt) > now - 7 * 86_400_000)).reverse();
  else if (range === "recent") ds = listingOrder(chat.filter((d) => past(d) && Date.parse(d.dueAt) > now - 86_400_000)).reverse();
  else ds = listingOrder(chat.filter((d) => Date.parse(d.dueAt) >= now));
  await persistListing(ctx, ds, env.who);
  const EMPTY: Record<string, string> = {
    today: "No reminders for today.", recent: "No reminders in the last 24 hours.",
    fired: "I didn't remind you about anything today.", past: "No reminders in the last week.",
  };
  const HEAD: Record<string, string> = {
    today: "Reminders today", recent: "Recent reminders", fired: "I reminded you today about", past: "Recent reminders",
  };
  if (ds.length === 0) return { ok: true, render: EMPTY[range] ?? "You have no reminders set." };
  const items = ds.map((d) => `${oneLine(d.title)} - ${whenLabel(d.dueAt, env.now, tz)}${d.status !== "open" ? ` (${d.status})` : ""}`);
  const head = `${HEAD[range] ?? "Upcoming reminders"} (${ds.length}):`;
  return { ok: true, render: numberedList(head, items), data: items.join("\n") };
}
