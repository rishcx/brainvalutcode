// Task tools. Titles are the user's own spans; one row per item; lists written by code.
import { lastListKey, oneLine } from "../../channels/format.ts";
import { closeReminder, lastDelivered } from "../../reminders/snooze.ts";
import { addTask, completeTask, dropTask, listToday, parseListRefs, persistTaskListing } from "../../tasks/service.ts";
import { orderOpen } from "../../tasks/render.ts";
import { sanitiseTitle } from "../../tasks/text.ts";
import { syncTaskNotes } from "../../tasks/vaultSync.ts";
import { addDaysToLocalDate, localDate } from "../../time.ts";
import type { AgentContext, Task } from "../../types.ts";
import type { Ref, ToolResult } from "../contract.ts";
import { askWhich, question } from "../dialog.ts";
import { matchSpan, norm } from "../provenance.ts";
import { numberedList, tasksAdded, type Numbered } from "../render.ts";
import type { ToolEnv } from "./index.ts";

const RECUR: Record<string, string> = { day: "every day", weekday: "every weekday" };

/**
 * The user's own words for a model-supplied item. When the model prefixed a verb ("buy milk" for "add milk to my
 * list") the leading token is dropped and the rest re-matched, instead of telling the user it was skipped (audit 16).
 */
function ownWords(raw: string, sources: string[]): string | null {
  const hit = matchSpan(raw, sources);
  if (hit !== null) return hit;
  const rest = raw.trim().replace(/^\S+\s+/, "");
  return rest && rest !== raw.trim() ? matchSpan(rest, sources) : null;
}

export async function addTasks(ctx: AgentContext, args: Record<string, unknown>, env: ToolEnv): Promise<ToolResult> {
  const items = Array.isArray(args.items) ? (args.items as { text?: unknown; every?: unknown }[]) : [];
  const added: Task[] = [];
  const existing: Task[] = [];
  const skipped: string[] = [];
  const notes: string[] = [];
  const flags: string[] = [];
  let last: Task | null = null;
  for (const it of items) {
    const raw = typeof it.text === "string" ? it.text : "";
    const span = ownWords(raw, env.sources);
    const title = span === null ? "" : sanitiseTitle(span);
    if (!title) {
      if (raw) skipped.push(raw.slice(0, 60));
      flags.push("provenance_miss:items");
      continue;
    }
    const every = typeof it.every === "string" ? (RECUR[it.every] ?? `every ${it.every}`) : null;
    const r = await addTask(ctx, { title, recurrence: every }, { writeNotes: false });
    if (!r.ok) {
      if (r.reason === "limit") notes.push(`Task limit reached (${ctx.config.tasks.maxPerDay} open), so I stopped there.`);
      if (r.reason === "limit") break;
      continue;
    }
    if (r.created || r.instantiated) {
      added.push(r.task);
      last = r.task;
    } else existing.push(r.task);
  }
  if (last) {
    try {
      await syncTaskNotes(ctx);
    } catch {
      /* the store is the truth */
    }
  }
  if (args.truncated === true) notes.push("I added the first 10.");
  if (added.length + existing.length === 0 && notes.length === 0) {
    return { ok: false, missing: ["items"], flags, render: question("items", {}), data: { slots: {} } };
  }
  // Persist today's list for this chat so the numbers shown here are the ones "done 1" / "drop 2" resolve (audit 8).
  const view = await listToday(ctx);
  await persistTaskListing(ctx, view, env.who);
  const order = [...view.open, ...view.done];
  const numbered = (t: Task): Numbered => ({ n: order.findIndex((x) => x.id === t.id) + 1, title: t.title });
  return {
    ok: true, flags, entityId: last?.id, title: last?.title,
    render: tasksAdded(added.map(numbered), existing.map(numbered), skipped, notes),
  };
}

type Pick1 = { kind: "task"; t: Task } | { kind: "deadline"; id: string } | { kind: "result"; result: ToolResult };

async function resolveTask(ctx: AgentContext, ref: Ref | null, env: ToolEnv, verb: string): Promise<Pick1> {
  if (ref?.index !== undefined) {
    const lr = parseListRefs(await ctx.store.kvGet(lastListKey(env.who)))[ref.index - 1];
    if (lr?.k === "d") return { kind: "deadline", id: lr.id };
    const t = lr ? await ctx.store.getTask(lr.id) : null;
    return t ? { kind: "task", t } : { kind: "result", result: { ok: false, render: `There is no item ${ref.index} in your last list. Send 'tasks' for a fresh one.` } };
  }
  if (ref?.last) {
    const la = env.dialog?.lastAction;
    const t = la?.tool === "add_tasks" ? await ctx.store.getTask(la.id) : null;
    if (t) return { kind: "task", t };
    // "done" right after a reminder fired: the model may route it here; the reminder is what the user means.
    const fired = (await lastDelivered(ctx, env.who))[0];
    if (fired) return { kind: "deadline", id: fired };
  }
  const span = ref?.text ? matchSpan(ref.text, env.sources) : null;
  if (span === null) {
    const flags = ref?.text ? ["provenance_miss:ref"] : [];
    return { kind: "result", result: { ok: false, missing: ["ref"], flags, render: `Which task should I mark ${verb}? Send its name or number.`, data: { slots: {} } } };
  }
  const key = norm(span).replace(/\b(?:the|my|task)\b/g, " ").replace(/\s+/g, " ").trim() || norm(span);
  const open = (await ctx.store.listTasks({ status: ["open"] })).sort(orderOpen);
  const exact = open.filter((t) => norm(t.title) === key);
  const hits = exact.length ? exact : open.filter((t) => norm(t.title).includes(key));
  if (hits.length === 1) return { kind: "task", t: hits[0]! };
  if (hits.length === 0) return { kind: "result", result: { ok: false, render: `No open task matching "${oneLine(span).slice(0, 60)}".` } };
  const cands = hits.map((t) => ({ k: "t" as const, id: t.id, title: oneLine(t.title) }));
  return { kind: "result", result: await askWhich(ctx, env.who, cands, {}) };
}

const refOf = (args: Record<string, unknown>): Ref | null => (args.ref && typeof args.ref === "object" ? (args.ref as Ref) : null);

export async function completeTaskTool(ctx: AgentContext, args: Record<string, unknown>, env: ToolEnv): Promise<ToolResult> {
  const r = await resolveTask(ctx, refOf(args), env, "done");
  if (r.kind === "result") return r.result;
  if (r.kind === "deadline") {
    const d = await closeReminder(ctx, r.id, "done");
    return d ? { ok: true, entityId: d.id, title: d.title, render: `Marked done: ${oneLine(d.title)}.` } : { ok: false, render: "That item no longer exists." };
  }
  if (r.t.status !== "open") return { ok: true, render: `Already ${r.t.status}: ${oneLine(r.t.title)}.` };
  const t = (await completeTask(ctx, r.t.id)) ?? r.t;
  return { ok: true, entityId: t.id, title: t.title, render: `Marked done: ${oneLine(t.title)}.` };
}

export async function dropTaskTool(ctx: AgentContext, args: Record<string, unknown>, env: ToolEnv): Promise<ToolResult> {
  const r = await resolveTask(ctx, refOf(args), env, "dropped");
  if (r.kind === "result") return r.result;
  if (r.kind === "deadline") return { ok: false, render: "That item is a deadline. Say 'cancel' with its number instead." };
  if (r.t.status !== "open") return { ok: true, render: `Already ${r.t.status}: ${oneLine(r.t.title)}.` };
  await dropTask(ctx, r.t.id);
  return { ok: true, entityId: r.t.id, title: r.t.title, render: `Dropped: ${oneLine(r.t.title)}.` };
}

export async function listTasks(ctx: AgentContext, args: Record<string, unknown>, env: ToolEnv): Promise<ToolResult> {
  const day = typeof args.day === "string" ? args.day : "today";
  const today = localDate(ctx.clock);
  const date = day === "tomorrow" ? addDaysToLocalDate(today, 1) : day === "today" ? today : day;
  let open: Task[];
  let done: Task[] = [];
  if (date === today) {
    const view = await listToday(ctx);
    await persistTaskListing(ctx, view, env.who);
    open = view.open;
    done = args.include_done === true ? view.done : [];
  } else {
    open = (await ctx.store.listTasks({ dueDate: date, status: ["open"] })).sort(orderOpen);
    await persistTaskListing(ctx, { date, open, done: [] }, env.who);
  }
  const label = date === today ? "Today" : day === "tomorrow" ? "Tomorrow" : date;
  if (open.length + done.length === 0) return { ok: true, render: `No tasks for ${label === "Today" || label === "Tomorrow" ? label.toLowerCase() : label}.` };
  const items = [...open.map((t) => oneLine(t.title)), ...done.map((t) => `${oneLine(t.title)} (done)`)];
  return { ok: true, render: numberedList(`${label} (${open.length} open):`, items), data: `${label} tasks:\n${items.join("\n")}` };
}
