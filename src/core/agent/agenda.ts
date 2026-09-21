// Code-rendered day view (audit D + C): today's tasks, what is overdue or due today, the next reminder and the
// assigned-issue count. No LLM, no markdown. Shared by the "what's next" fast path and the chat:agenda job.
import { listingOrder, oneLine } from "../channels/format.ts";
import { safeText } from "../render/involvement.ts";
import { readInvolvementSnapshot } from "../sources/involvement.ts";
import { listToday, persistTaskListing } from "../tasks/service.ts";
import { localDateOf } from "../time.ts";
import type { AgentContext, Deadline } from "../types.ts";
import type { Target } from "./contract.ts";
import { whenLabel } from "./render.ts";

const MAX_ROWS = 5;
const title = (d: Deadline): string => oneLine(safeText(d.title, 120));

/** Never throws: a section that cannot be read is left out rather than failing the whole agenda. */
export async function agendaText(ctx: AgentContext, who?: Target): Promise<string> {
  const now = ctx.clock.now();
  const tz = ctx.clock.tz;
  const today = localDateOf(now, tz);
  const head = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "long", day: "numeric", month: "short" }).format(now);
  const lines: string[] = [`Your day - ${head.replace(/,/g, "")}:`];

  const view = await listToday(ctx).catch(() => null);
  if (view && view.open.length) {
    await persistTaskListing(ctx, view, who).catch(() => undefined);
    lines.push(`Tasks (${view.open.length}):`, ...view.open.slice(0, MAX_ROWS).map((t, i) => `• ${i + 1}. ${oneLine(t.title)}`));
    if (view.open.length > MAX_ROWS) lines.push(`... and ${view.open.length - MAX_ROWS} more`);
  } else lines.push("No tasks for today.");

  const open = listingOrder(await ctx.store.listDeadlines({ status: ["open"] }).catch(() => [] as Deadline[]));
  const at = (d: Deadline): number => Date.parse(d.dueAt);
  const overdue = open.filter((d) => at(d) < now.getTime());
  const dueToday = open.filter((d) => at(d) >= now.getTime() && localDateOf(new Date(d.dueAt), tz) === today);
  if (overdue.length) lines.push(`Overdue (${overdue.length}):`, ...overdue.slice(0, MAX_ROWS).map((d) => `• ${title(d)} - was ${whenLabel(d.dueAt, now, tz)}`));
  if (dueToday.length) lines.push(`Due today (${dueToday.length}):`, ...dueToday.slice(0, MAX_ROWS).map((d) => `• ${title(d)} - ${whenLabel(d.dueAt, now, tz)}`));

  const next = open.filter((d) => at(d) >= now.getTime()).sort((a, b) => at(a) - at(b))[0];
  if (next) lines.push(`Next reminder: ${title(next)}, ${whenLabel(next.dueAt, now, tz)}.`);
  else if (!dueToday.length && !overdue.length) lines.push("Nothing is due.");

  const n = (await readInvolvementSnapshot(ctx.store).catch(() => null))?.totals?.assignedIssues ?? 0;
  if (n > 0) lines.push(`GitHub: ${n} issue${n === 1 ? "" : "s"} assigned to you.`);
  return lines.join("\n");
}
