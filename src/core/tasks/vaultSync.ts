import { addDaysToLocalDate, parseLocalDate } from "../time.ts";
import type { AgentContext, Task } from "../types.ts";
import { parseRecurrence } from "./recurrence.ts";
import { listToday, renderTasksJson, renderTasksNote } from "./render.ts";
import { sanitiseTitle } from "./text.ts";

export const notePathFor = (dueDate: string): string => `Tasks/${dueDate}.md`;

/**
 * Writes Tasks/index.md, Tasks/tasks.json and today's Tasks/<date>.md (past day notes are never rewritten).
 * THROWS on a vault failure: rollover relies on that to leave its gate unset. Command paths wrap it.
 */
export async function syncTaskNotes(ctx: AgentContext): Promise<string[]> {
  const view = await listToday(ctx);
  const cutoff = addDaysToLocalDate(view.date, -14);
  const all = await ctx.store.listTasks();
  const keep = all.filter((t) => t.status === "open" || t.status === "template" || t.dueDate >= cutoff);
  const note = renderTasksNote(view);
  return ctx.vault.writeFiles(`tasks: ${view.date}`, [
    { path: "Tasks/index.md", content: note },
    { path: "Tasks/tasks.json", content: renderTasksJson(keep) },
    { path: notePathFor(view.date), content: note },
  ]);
}

const ID_RE = /^t:[a-z0-9-]+(?::[a-z0-9-]+)*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const STATUSES = new Set(["open", "done", "dropped", "template"]);
const SOURCES = new Set(["chat", "vault", "recurrence"]);
const MAX_JSON = 2_000_000;
const MAX_TASKS = 5000;

function validDate(s: unknown): s is string {
  if (typeof s !== "string" || !DATE_RE.test(s)) return false;
  const p = parseLocalDate(s);
  return addDaysToLocalDate(s, 0) === s && p.month >= 1 && p.month <= 12;
}

/** Validates one untrusted row from tasks.json; null = skip. */
function validateRow(x: unknown): Task | null {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return null;
  const r = x as Record<string, unknown>;
  if (typeof r.id !== "string" || r.id.length > 200 || !ID_RE.test(r.id)) return null;
  if (typeof r.status !== "string" || !STATUSES.has(r.status)) return null;
  if (typeof r.source !== "string" || !SOURCES.has(r.source)) return null;
  if (!validDate(r.dueDate) || !validDate(r.createdDate) || !validDate(r.firstDate)) return null;
  if (typeof r.rollCount !== "number" || !Number.isInteger(r.rollCount) || r.rollCount < 0 || r.rollCount > 100_000) return null;
  let doneAt: string | null = null;
  if (r.doneAt !== null && r.doneAt !== undefined) {
    if (typeof r.doneAt !== "string" || Number.isNaN(Date.parse(r.doneAt))) return null;
    doneAt = new Date(r.doneAt).toISOString();
  }
  let recurrence: string | null = null;
  if (r.recurrence !== null && r.recurrence !== undefined) {
    if (typeof r.recurrence !== "string") return null;
    recurrence = parseRecurrence(r.recurrence);
    if (recurrence === null) return null;
  }
  if ((r.status === "template") !== (recurrence !== null)) return null;
  if (typeof r.title !== "string") return null;
  const title = sanitiseTitle(r.title);
  if (!title) return null;
  return {
    id: r.id,
    title,
    status: r.status as Task["status"],
    dueDate: r.dueDate,
    createdDate: r.createdDate,
    firstDate: r.firstDate,
    rollCount: r.rollCount,
    doneAt,
    recurrence,
    source: r.source as Task["source"],
    notePath: notePathFor(r.dueDate),
  };
}

/** Rebuilds the tasks table from Tasks/tasks.json, only when the table is empty. Returns rows restored. */
export async function restoreFromVault(ctx: AgentContext): Promise<number> {
  if ((await ctx.store.listTasks()).length > 0) return 0;
  const raw = await ctx.vault.readFile("Tasks/tasks.json");
  if (!raw || raw.length > MAX_JSON) return 0;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 0;
  }
  const list = (parsed as { tasks?: unknown } | null)?.tasks;
  if (!Array.isArray(list)) return 0;
  let n = 0;
  for (const x of list.slice(0, MAX_TASKS)) {
    const t = validateRow(x);
    if (!t) continue;
    await ctx.store.upsertTask(t);
    n++;
  }
  return n;
}
