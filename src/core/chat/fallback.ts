import { localDateOf, localTimeOf } from "../time.ts";
import { safeText } from "../render/involvement.ts";
import { hasFacts, type Snapshot } from "./snapshot.ts";
import { redactSecrets } from "./text.ts";

export const NO_FACTS_DOWN = "I'm having trouble reaching my language model right now, and I have nothing on file yet.";
const DOWN_INTRO = "I'm having trouble reaching my language model right now. Here is what I can tell you:";
const HINTS = "You can also use: tasks, status, rules, add task <title>, remind me in 10 minutes to ...";

function factLines(s: Snapshot): string[] {
  const lines: string[] = [];
  const tasks = s.tasksSection
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^(?:[-*•]|\d+[.)])\s/.test(l) && !/^\W*done/i.test(l))
    .map((l) => safeText(l.replace(/^(?:[-*•]|\d+[.)])\s+(?:\[[ x]\]\s*)?/i, "").replace(/\s+_\(.*\)_$/, ""), 60))
    .filter(Boolean);
  if (tasks.length) lines.push(`• Today's tasks: ${tasks.slice(0, 3).join("; ")}${tasks.length > 3 ? ` (+${tasks.length - 3} more)` : ""}`);
  if (s.overdue.length) lines.push(`• Overdue: ${s.overdue.slice(0, 2).map((d) => safeText(d.title, 60)).join("; ")}`);
  for (const d of s.dueSoon.slice(0, 2)) {
    const at = new Date(d.dueAt);
    lines.push(`• Next deadline: ${safeText(d.title, 60)} (${localDateOf(at, s.tz)} ${localTimeOf(at, s.tz)})`);
  }
  if (s.gh && s.gh.totals.assignedIssues > 0) lines.push(`• Assigned issues: ${s.gh.totals.assignedIssues}`);
  return lines.slice(0, 6);
}

/** Never an error string, heading or raw dump: a friendly intro, at most 6 fact lines and one hint line. */
export function deterministicReply(s: Snapshot, opts: { llmDown: boolean }): string {
  if (!hasFacts(s)) return opts.llmDown ? NO_FACTS_DOWN : `I have nothing on file yet.\n${HINTS}`;
  const lines = factLines(s);
  const intro = opts.llmDown ? DOWN_INTRO : "Here is what I can tell you:";
  return redactSecrets([intro, ...lines, HINTS].join("\n"));
}
