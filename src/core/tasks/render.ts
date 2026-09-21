// Deterministic rendering: no wall-clock values, so unchanged data renders byte-identically.
import { daysBetweenLocalDates, localDate } from "../time.ts";
import type { AgentContext, Task } from "../types.ts";
import { mdEscape, sanitiseTitle } from "./text.ts";

export interface TodayView {
  date: string;
  open: Task[];
  done: Task[];
}

/** The one ordering used everywhere: firstDate asc, id asc. */
export const orderOpen = (a: Task, b: Task): number =>
  a.firstDate < b.firstDate ? -1 : a.firstDate > b.firstDate ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/** Overdue open tasks show even if the cron missed; templates are never listed. */
export async function listToday(ctx: AgentContext): Promise<TodayView> {
  const date = localDate(ctx.clock);
  const open = await ctx.store.listTasks({ dueOnOrBefore: date, status: ["open"] });
  const done = await ctx.store.listTasks({ dueDate: date, status: ["done"] });
  return { date, open: open.sort(orderOpen), done: done.sort(orderOpen) };
}

/** "recurring", "carried 3 days" for a task as seen on `date`. */
export function taskLabels(t: Task, date: string): string[] {
  const out: string[] = [];
  if (t.source === "recurrence") out.push("recurring");
  const n = daysBetweenLocalDates(t.firstDate, date);
  if (n > 0) out.push(`carried ${n} day${n === 1 ? "" : "s"}`);
  return out;
}

const line = (t: Task) => mdEscape(sanitiseTitle(t.title));

export function renderTasksNote(view: TodayView): string {
  const out = ["---", "type: tasks", `date: ${view.date}`, `open: ${view.open.length}`, "---", "", `# Tasks ${view.date}`, ""];
  for (const t of view.open) {
    const l = taskLabels(t, view.date);
    out.push(`- [ ] ${line(t)}${l.length ? `  _(${l.join(", ")})_` : ""}`);
  }
  if (view.done.length) {
    if (view.open.length) out.push("");
    out.push("## Done today");
    for (const t of view.done) out.push(`- [x] ${line(t)}`);
  }
  return out.join("\n").replace(/\n+$/, "") + "\n";
}

/** Sorted by id. The caller decides which rows belong (open + template + recent done/dropped). */
export function renderTasksJson(tasks: Task[]): string {
  const sorted = [...tasks].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return JSON.stringify({ version: 1, tasks: sorted }, null, 2) + "\n";
}

/** "" when nothing is open. No trailing newline. */
export function renderTasksSection(view: TodayView, maxLines = 15): string {
  if (view.open.length === 0) return "";
  const out = ["## Today"];
  for (const t of view.open.slice(0, maxLines)) {
    const l = taskLabels(t, view.date);
    out.push(`- ${line(t)}${l.length ? `  _(${l.join(", ")})_` : ""}`);
  }
  if (view.open.length > maxLines) out.push(`- … and ${view.open.length - maxLines} more`);
  return out.join("\n");
}

export async function renderTasksDigestSection(ctx: AgentContext): Promise<string> {
  return renderTasksSection(await listToday(ctx), 15);
}
