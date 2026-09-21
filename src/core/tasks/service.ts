import type { Target } from "../agent/contract.ts";
import { lastListKey } from "../channels/format.ts";
import { localDate } from "../time.ts";
import type { AgentContext, ListRef, Task } from "../types.ts";
import { parseRecurrence, recurrenceMatches } from "./recurrence.ts";
import { listToday, orderOpen, taskLabels, type TodayView } from "./render.ts";
import { normaliseTitle, sanitiseTitle, slugify } from "./text.ts";
import { notePathFor, syncTaskNotes } from "./vaultSync.ts";

export { listToday, type TodayView };

export type AddTaskResult =
  | { ok: true; task: Task; created: boolean; template?: Task; instantiated: boolean }
  | { ok: false; reason: "empty" | "limit" | "bad-recurrence" };

interface WriteOpts {
  writeNotes?: boolean;
}

/** The store is the truth: a failed vault write never fails a command. */
async function trySync(ctx: AgentContext, opts?: WriteOpts): Promise<void> {
  if (opts?.writeNotes === false) return;
  try {
    await syncTaskNotes(ctx);
  } catch {
    /* best effort; the next rollover or command rewrites the notes */
  }
}

async function freeId(ctx: AgentContext, base: string): Promise<string | null> {
  for (let i = 1; i <= 20; i++) {
    const id = i === 1 ? base : `${base}-${i}`;
    if (!(await ctx.store.getTask(id))) return id;
  }
  return null;
}

/**
 * Creates today's instance of a template when (a) it recurs today, (b) that instance id is unused (never
 * overwrite a done/dropped one) and (c) no other instance of this template is still open (no pile-up).
 */
export async function instantiateTemplate(ctx: AgentContext, template: Task, date: string): Promise<Task | null> {
  if (template.status !== "template" || !template.recurrence) return null;
  if (!recurrenceMatches(template.recurrence, date)) return null;
  const id = `t:rec:${template.id}:${date}`;
  if (await ctx.store.getTask(id)) return null;
  const prefix = `t:rec:${template.id}:`;
  const open = await ctx.store.listTasks({ status: ["open"] });
  if (open.some((t) => t.id.startsWith(prefix))) return null;
  const task: Task = {
    id,
    title: template.title,
    status: "open",
    dueDate: date,
    createdDate: date,
    firstDate: date,
    rollCount: 0,
    doneAt: null,
    recurrence: null,
    source: "recurrence",
    notePath: notePathFor(date),
  };
  await ctx.store.upsertTask(task);
  return task;
}

export async function addTask(
  ctx: AgentContext,
  input: { title: string; recurrence?: string | null; source?: "chat" | "vault" },
  opts?: WriteOpts,
): Promise<AddTaskResult> {
  const title = sanitiseTitle(input.title);
  if (!title) return { ok: false, reason: "empty" };
  let recurrence: string | null = null;
  if (input.recurrence !== undefined && input.recurrence !== null) {
    recurrence = parseRecurrence(input.recurrence);
    if (recurrence === null) return { ok: false, reason: "bad-recurrence" };
  }
  const today = localDate(ctx.clock);
  const key = normaliseTitle(title);
  const source = input.source ?? "chat";

  if (recurrence === null) {
    const open = await ctx.store.listTasks({ dueOnOrBefore: today, status: ["open"] });
    const dupe = open.sort(orderOpen).find((t) => normaliseTitle(t.title) === key);
    if (dupe) return { ok: true, task: dupe, created: false, instantiated: false };
    if (open.length >= ctx.config.tasks.maxPerDay) return { ok: false, reason: "limit" };
    const id = await freeId(ctx, `t:${slugify(title)}:${today}`);
    if (!id) return { ok: false, reason: "limit" };
    const task: Task = {
      id, title, status: "open", dueDate: today, createdDate: today, firstDate: today,
      rollCount: 0, doneAt: null, recurrence: null, source, notePath: notePathFor(today),
    };
    await ctx.store.upsertTask(task);
    await trySync(ctx, opts);
    return { ok: true, task, created: true, instantiated: false };
  }

  const templates = await ctx.store.listTasks({ status: ["template"] });
  let template = templates.find((t) => t.recurrence === recurrence && normaliseTitle(t.title) === key);
  let created = false;
  if (!template) {
    const open = await ctx.store.listTasks({ dueOnOrBefore: today, status: ["open"] });
    if (open.length >= ctx.config.tasks.maxPerDay) return { ok: false, reason: "limit" };
    const id = await freeId(ctx, `t:tpl:${slugify(title)}:${today}`);
    if (!id) return { ok: false, reason: "limit" };
    template = {
      id, title, status: "template", dueDate: today, createdDate: today, firstDate: today,
      rollCount: 0, doneAt: null, recurrence, source, notePath: notePathFor(today),
    };
    await ctx.store.upsertTask(template);
    created = true;
  }
  const instance = await instantiateTemplate(ctx, template, today);
  let task: Task = instance ?? template;
  if (!instance) {
    // Reuse of a template whose instance is already open (possibly carried): point at that one.
    const prefix = `t:rec:${template.id}:`;
    const openInst = (await ctx.store.listTasks({ status: ["open"] })).find((t) => t.id.startsWith(prefix));
    if (openInst) task = openInst;
  }
  await trySync(ctx, opts);
  return { ok: true, task, created, template, instantiated: instance !== null };
}

export async function completeTask(ctx: AgentContext, id: string, opts?: WriteOpts): Promise<Task | null> {
  const row = await ctx.store.getTask(id);
  if (!row) return null;
  if (row.status !== "open") return row;
  const today = localDate(ctx.clock);
  const done: Task = { ...row, status: "done", dueDate: today, doneAt: ctx.clock.now().toISOString(), notePath: notePathFor(today) };
  await ctx.store.upsertTask(done); // moves it onto today so it lists under "Done today"
  await trySync(ctx, opts);
  return done;
}

export async function dropTask(ctx: AgentContext, id: string, opts?: WriteOpts): Promise<Task | null> {
  const row = await ctx.store.getTask(id);
  if (!row) return null;
  if (row.status !== "open") return row;
  await ctx.store.setTaskStatus(id, "dropped", null);
  await trySync(ctx, opts);
  return { ...row, status: "dropped", doneAt: null };
}

export async function completeByName(
  ctx: AgentContext,
  query: string,
): Promise<{ kind: "done"; task: Task } | { kind: "none" } | { kind: "ambiguous"; candidates: Task[] }> {
  const q = normaliseTitle(query);
  if (!q) return { kind: "none" };
  const open = (await ctx.store.listTasks({ status: ["open"] })).sort(orderOpen);
  const hits = open.filter((t) => normaliseTitle(t.title).includes(q));
  if (hits.length === 0) return { kind: "none" };
  if (hits.length > 1) return { kind: "ambiguous", candidates: hits.slice(0, 5) };
  const task = (await completeTask(ctx, hits[0]!.id)) ?? hits[0]!;
  return { kind: "done", task };
}

/* ------------------------------------------------------------ list refs */

/** Legacy string[] => deadlines. Any junk (bad JSON, non-array, a bad element) => [] so numbering never shifts. */
export function parseListRefs(raw: string | null): ListRef[] {
  if (!raw) return [];
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(v)) return [];
  const out: ListRef[] = [];
  for (const e of v) {
    if (typeof e === "string" && e) out.push({ k: "d", id: e });
    else if (typeof e === "object" && e !== null) {
      const { k, id } = e as { k?: unknown; id?: unknown };
      if ((k === "d" || k === "t") && typeof id === "string" && id) out.push({ k, id });
      else return [];
    } else return [];
  }
  return out;
}

export async function persistTaskListing(ctx: AgentContext, view: TodayView, who?: Target): Promise<void> {
  const refs: ListRef[] = [...view.open, ...view.done].map((t) => ({ k: "t", id: t.id }));
  await ctx.store.kvSet(lastListKey(who), JSON.stringify(refs), ctx.clock.now().toISOString());
}

/** With `who`, falls back to the legacy shared key when the per-(channel,peer) one has never been written. */
export async function resolveListRef(ctx: AgentContext, n: number, who?: Target): Promise<ListRef | null> {
  if (!Number.isInteger(n) || n < 1) return null;
  const raw = who ? ((await ctx.store.kvGet(lastListKey(who))) ?? (await ctx.store.kvGet(lastListKey()))) : await ctx.store.kvGet(lastListKey());
  return parseListRefs(raw)[n - 1] ?? null;
}

/* -------------------------------------------------------------- replies */

const suffix = (t: Task, date: string): string => {
  const l = taskLabels(t, date);
  return l.length ? ` (${l.join(", ")})` : "";
};
const name = (t: Task): string => sanitiseTitle(t.title);
const shown = (q: string): string => sanitiseTitle(q).slice(0, 60);

export async function replyTasks(ctx: AgentContext, who?: Target): Promise<string> {
  const view = await listToday(ctx);
  await persistTaskListing(ctx, view, who);
  if (view.open.length + view.done.length === 0) {
    return `No tasks for ${view.date}. Send 'add task <title>' to add one.`;
  }
  const lines = [`Tasks for ${view.date}:`];
  view.open.forEach((t, i) => lines.push(`${i + 1}. ${name(t)}${suffix(t, view.date)}`));
  if (view.open.length === 0) lines.push("Nothing open.");
  if (view.done.length) {
    lines.push("", "Done today:");
    view.done.forEach((t, i) => lines.push(`${view.open.length + i + 1}. ${name(t)}`));
  }
  return lines.join("\n");
}

export async function replyAddTask(
  ctx: AgentContext,
  c: { title: string; recurrence: string | null },
  who?: Target,
): Promise<string> {
  const r = await addTask(ctx, { title: c.title, recurrence: c.recurrence });
  if (!r.ok) {
    if (r.reason === "empty") return "Give the task a title: add task <title>";
    if (r.reason === "limit") return `Task limit reached (${ctx.config.tasks.maxPerDay} open). Finish or drop some first.`;
    return "I could not read that repeat rule. Try 'every day', 'every weekday' or 'every monday'.";
  }
  const view = await listToday(ctx);
  await persistTaskListing(ctx, view, who);
  if (r.task.status === "template") {
    return `${r.created ? "Added recurring" : "Already recurring"}: ${name(r.task)} (${r.task.recurrence}). Nothing due today.`;
  }
  const idx = [...view.open, ...view.done].findIndex((t) => t.id === r.task.id) + 1;
  const item = idx > 0 ? ` as item ${idx}` : "";
  if (!r.created && !r.template) return `Already on your list: ${name(r.task)}${idx > 0 ? ` (item ${idx})` : ""}.`;
  const rec = r.template ? ` (repeats: ${r.template.recurrence})` : "";
  return `Added: ${name(r.task)}${item}${rec}.`;
}

export async function replyDoneNamed(ctx: AgentContext, title: string): Promise<string> {
  const r = await completeByName(ctx, title);
  if (r.kind === "done") return `Marked done: ${name(r.task)}`;
  if (r.kind === "none") return `No open task matching "${shown(title)}".`;
  const list = r.candidates.map((t, i) => `${i + 1}. ${name(t)}`).join("\n");
  return `Several tasks match "${shown(title)}". Say more of the title:\n${list}`;
}

export async function replyDrop(ctx: AgentContext, index: number, who?: Target): Promise<string> {
  const ref = await resolveListRef(ctx, index, who);
  if (!ref) return `No item ${index} in the last list. Send 'tasks' or 'status'.`;
  if (ref.k === "d") return `Item ${index} is a deadline. Use 'done ${index}'.`;
  const before = await ctx.store.getTask(ref.id);
  if (!before) return `No item ${index} in the last list. Send 'tasks' or 'status'.`;
  if (before.status !== "open") return `Not an open task: ${name(before)}`;
  await dropTask(ctx, ref.id);
  return `Dropped: ${name(before)}`;
}

export async function resolveDoneIndex(
  ctx: AgentContext,
  index: number,
  who?: Target,
): Promise<{ kind: "reply"; text: string } | { kind: "deadline"; id: string }> {
  const none = { kind: "reply", text: `No item ${index} in the last list. Send 'tasks' or 'status'.` } as const;
  const ref = await resolveListRef(ctx, index, who);
  if (!ref) return none;
  if (ref.k === "d") return { kind: "deadline", id: ref.id };
  const before = await ctx.store.getTask(ref.id);
  if (!before) return none;
  if (before.status === "done") return { kind: "reply", text: `Already done: ${name(before)}` };
  if (before.status !== "open") return { kind: "reply", text: `Already ${before.status}: ${name(before)}` };
  const t = await completeTask(ctx, ref.id);
  return { kind: "reply", text: `Marked done: ${name(t ?? before)}` };
}
