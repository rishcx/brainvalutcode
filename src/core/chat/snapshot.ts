// The chat snapshot: D1/kv only, zero fetches, zero vault reads.
import { listToday, renderTasksSection } from "../tasks/index.ts";
import { safeText } from "../render/involvement.ts";
import { readInvolvementSnapshot, type InvolvementItem, type InvolvementSnapshot } from "../sources/involvement.ts";
import { DAY, localDate, localDateOf, localTimeOf } from "../time.ts";
import type { AgentContext, Deadline } from "../types.ts";
import { cleanText, cut } from "./text.ts";

// "confirmed" deadlines are status "open" (proposed ones await confirmation and are excluded).
export interface Snapshot {
  today: string;
  nowLocal: string;
  tz: string;
  overdue: Deadline[];
  dueSoon: Deadline[];
  tasksSection: string;
  gh: InvolvementSnapshot | null;
}

const SOON_DAYS = 14;
const SOON_CAP = 10;
const PER_BUCKET = 8;
export const TIP = "Tip: when relevant, also mention related open PRs, other recently active repos and nearby deadlines.";

export function baseSnapshot(ctx: AgentContext): Snapshot {
  const now = ctx.clock.now();
  const tz = ctx.clock.tz;
  return { today: localDate(ctx.clock), nowLocal: `${localDate(ctx.clock)} ${localTimeOf(now, tz)}`, tz, overdue: [], dueSoon: [], tasksSection: "", gh: null };
}

export async function buildSnapshot(ctx: AgentContext): Promise<Snapshot> {
  const s = baseSnapshot(ctx);
  const now = ctx.clock.now().getTime();
  try {
    const all = await ctx.store.listDeadlines({ status: ["open"] });
    s.overdue = all.filter((d) => Date.parse(d.dueAt) < now);
    s.dueSoon = all.filter((d) => Date.parse(d.dueAt) >= now && Date.parse(d.dueAt) <= now + SOON_DAYS * DAY).slice(0, SOON_CAP);
  } catch {
    /* section omitted */
  }
  try {
    s.tasksSection = renderTasksSection(await listToday(ctx), 10);
  } catch {
    /* section omitted */
  }
  try {
    s.gh = await readInvolvementSnapshot(ctx.store);
  } catch {
    /* section omitted */
  }
  return s;
}

export function hasFacts(s: Snapshot): boolean {
  const g = s.gh;
  return (
    s.overdue.length + s.dueSoon.length > 0 ||
    s.tasksSection.trim() !== "" ||
    (g !== null && g.assignedIssues.length + g.myOpenPrs.length + g.reviewRequests.length + g.mentions.length + g.recentRepos.length > 0)
  );
}

const line = (i: InvolvementItem): string => `- ${safeText(i.repo, 60)} #${i.number} ${safeText(i.title, 100)}`;

function bucket(label: string, items: InvolvementItem[]): string {
  if (items.length === 0) return "";
  const rows = items.slice(0, PER_BUCKET).map(line);
  if (items.length > PER_BUCKET) rows.push(`- … and ${items.length - PER_BUCKET} more`);
  return `${label}:\n${rows.join("\n")}`;
}

function deadlineLine(s: Snapshot, d: Deadline, overdue: boolean): string {
  const at = new Date(d.dueAt);
  const when = `${localDateOf(at, s.tz)} ${localTimeOf(at, s.tz)}`;
  return `- ${overdue ? "OVERDUE: " : ""}${safeText(d.title, 100)} (${overdue ? "was due" : "due"} ${when})`;
}

/**
 * Deterministic and priority-ordered: deadlines, tasks, GitHub. Under pressure the lowest sections go first
 * (recent repos, mentions, tasks, main GitHub buckets, deadlines). `tip` is model guidance, not part of a user-facing reply.
 */
export function renderFacts(s: Snapshot, maxChars: number, tip: boolean): string {
  const g = s.gh;
  const dl = [...s.overdue.map((d) => deadlineLine(s, d, true)), ...s.dueSoon.map((d) => deadlineLine(s, d, false))];
  const main = g
    ? [bucket("Review requests", g.reviewRequests), bucket("Assigned issues", g.assignedIssues), bucket("Open PRs", g.myOpenPrs)].filter(Boolean).join("\n")
    : "";
  const parts: { text: string; rank: number }[] = [
    { text: tip ? `${TIP}\nNow: ${s.nowLocal} (${s.tz})` : `Now: ${s.nowLocal} (${s.tz})`, rank: 99 },
    { text: dl.length ? `Deadlines:\n${dl.join("\n")}` : "", rank: 5 },
    { text: s.tasksSection.trim() ? `Tasks:\n${cleanText(s.tasksSection)}` : "", rank: 3 },
    { text: main ? `GitHub${g?.login ? ` (${safeText(g.login, 40)})` : ""}:\n${main}` : "", rank: 4 },
    { text: g ? bucket("Mentions", g.mentions) : "", rank: 2 },
    {
      text: g && g.recentRepos.length ? `Recently active repos: ${g.recentRepos.slice(0, PER_BUCKET).map((r) => safeText(r.fullName, 60)).join(", ")}` : "",
      rank: 1,
    },
  ];
  let live = parts.filter((p) => p.text !== "");
  const join = (): string => live.map((p) => p.text).join("\n\n");
  while (join().length > maxChars && live.some((p) => p.rank < 99)) {
    const lowest = Math.min(...live.filter((p) => p.rank < 99).map((p) => p.rank));
    live = live.filter((p) => p.rank !== lowest);
  }
  return cut(join(), maxChars);
}

export const renderSnapshot = (s: Snapshot, maxChars: number): string => renderFacts(s, maxChars, true);
