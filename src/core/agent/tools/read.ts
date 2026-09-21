// Read tools: fetched AFTER planning (the PLAN prompt never sees this data). `data` is plain-text facts for
// COMPOSE (untrusted: fenced there); `render` is the honest code fallback.
import { listingOrder, oneLine, persistListing } from "../../channels/format.ts";
import { cleanText, cut } from "../../chat/text.ts";
import { retrieve } from "../../qa/retrieve.ts";
import { safeText } from "../../render/involvement.ts";
import { INVOLVEMENT_KV, parseSnapshotLoose, readInvolvementSnapshot, type InvolvementItem, type InvolvementSnapshot } from "../../sources/involvement.ts";
import { listToday } from "../../tasks/index.ts";
import { addDaysToLocalDate, DAY, localDateOf } from "../../time.ts";
import type { AgentContext, Deadline } from "../../types.ts";
import type { ToolResult } from "../contract.ts";
import { numberedList, whenLabel } from "../render.ts";
import type { ToolEnv } from "./index.ts";

const EMPTY_DEADLINES: Record<string, string> = {
  today: "Nothing is due today.",
  tomorrow: "Nothing is due tomorrow.",
  week: "Nothing is due this week.",
  overdue: "Nothing is overdue.",
  upcoming: "No upcoming deadlines.",
};
const HEAD: Record<string, string> = { today: "Due today", tomorrow: "Due tomorrow", week: "Due this week", overdue: "Overdue", upcoming: "Coming up" };

export async function listDeadlines(ctx: AgentContext, args: Record<string, unknown>, env: ToolEnv): Promise<ToolResult> {
  const range = typeof args.range === "string" && args.range in HEAD ? args.range : "upcoming";
  const now = env.now.getTime();
  const tz = ctx.clock.tz;
  const today = localDateOf(env.now, tz);
  const open = listingOrder(await ctx.store.listDeadlines({ status: ["open"] }));
  const due = (d: Deadline): number => Date.parse(d.dueAt);
  const ds =
    range === "today" || range === "tomorrow"
      ? open.filter((d) => localDateOf(new Date(d.dueAt), tz) === (range === "today" ? today : addDaysToLocalDate(today, 1)))
      : range === "week"
        ? open.filter((d) => due(d) <= now + 7 * DAY)
        : range === "overdue"
          ? open.filter((d) => due(d) < now)
          : open.filter((d) => due(d) >= now);
  await persistListing(ctx, ds, env.who);
  if (ds.length === 0) return { ok: true, render: EMPTY_DEADLINES[range]! };
  const items = ds.map((d) => `${oneLine(safeText(d.title, 120))} - ${due(d) < now ? "overdue, was " : ""}${whenLabel(d.dueAt, env.now, tz)}`);
  return { ok: true, render: numberedList(`${HEAD[range]} (${ds.length}):`, items), data: `${HEAD[range]}:\n${items.join("\n")}` };
}

const BUCKETS: [string, keyof Pick<InvolvementSnapshot, "assignedIssues" | "myOpenPrs" | "reviewRequests" | "mentions">, string][] = [
  ["assigned", "assignedIssues", "Assigned issues"],
  ["prs", "myOpenPrs", "Your open PRs"],
  ["reviews", "reviewRequests", "Reviews requested"],
  ["mentions", "mentions", "Mentions"],
];

const ghLine = (i: InvolvementItem): string => `${safeText(i.repo, 60)} #${i.number} ${safeText(i.title, 100)}`;
// Facts for COMPOSE carry the full title, state, last-updated date and link, so "tell me more about the first one" has substance.
const ghFact = (i: InvolvementItem): string =>
  `${safeText(i.repo, 60)} #${i.number}: ${safeText(i.title, 240)} | state ${safeText(i.state, 20)} | updated ${i.updatedAt.slice(0, 10)} | ${i.url}`;

export async function githubInvolvement(ctx: AgentContext, args: Record<string, unknown>): Promise<ToolResult> {
  const bucket = typeof args.bucket === "string" ? args.bucket : "all";
  const loose = parseSnapshotLoose(await ctx.store.kvGet(INVOLVEMENT_KV));
  const snap = loose?.snap ?? null;
  // Schema drift costs the drifted field, not the answer; the trace says which fields were repaired (audit 18).
  const flags = loose?.repaired.length ? [`snapshot_repaired:${loose.repaired.slice(0, 4).join("+")}`] : undefined;
  if (!snap) return { ok: true, render: "I don't have your GitHub data yet. It refreshes on its own every few hours." };
  const chosen = BUCKETS.filter(([k]) => bucket === "all" || k === bucket);
  const lines: string[] = [];
  const facts: string[] = [];
  for (const [, key, label] of chosen) {
    const items = snap[key];
    const total = snap.totals?.[key] ?? items.length;
    if (items.length === 0 && bucket === "all") continue;
    lines.push(`${label} (${total}):`, ...(items.length ? items.slice(0, 6).map((i) => `• ${ghLine(i)}`) : ["• none"]));
    if (items.length > 6) lines.push(`... and ${items.length - 6} more`);
    facts.push(`${label} (total ${total}):`, ...items.map(ghFact));
  }
  if (facts.length === 0 || chosen.every(([, key]) => snap[key].length === 0)) {
    return { ok: true, flags, render: bucket === "all" ? "Nothing is waiting on you on GitHub." : `${chosen[0]?.[2] ?? "That list"}: none.` };
  }
  return { ok: true, flags, render: lines.join("\n"), data: facts.join("\n") };
}

const STOP = new Set("the and for are but not you all any can was what when where which who why how this that these those with from into about does did will would should could there their them then than tell more one ones give show details detail info information please".split(" "));
const words = (t: string): string[] => [...new Set(t.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3 && !STOP.has(w)))];

/**
 * "Tell me more about the rent one": the answer is often not in a note but in what the agent already tracks. So a
 * detail question searches notes AND open deadlines, today's tasks and the GitHub involvement snapshot.
 */
async function trackedFacts(ctx: AgentContext, q: string[], tz: string): Promise<string[]> {
  if (q.length === 0) return [];
  const hit = (text: string): boolean => {
    const t = text.toLowerCase();
    return q.some((w) => t.includes(w));
  };
  const out: string[] = [];
  const ds = await ctx.store.listDeadlines({ status: ["open", "proposed"] }).catch(() => [] as Deadline[]);
  for (const d of ds) {
    if (!hit(`${d.title} ${d.category}`)) continue;
    out.push(`[deadline] ${oneLine(safeText(d.title))}; due ${whenLabel(d.dueAt, ctx.clock.now(), tz)}; category ${d.category}; status ${d.status}; from ${d.source}`);
  }
  const view = await listToday(ctx).catch(() => null);
  for (const t of view?.open ?? []) {
    if (hit(t.title)) out.push(`[task] ${oneLine(safeText(t.title))}; open today${t.recurrence ? `; repeats ${t.recurrence}` : ""}${t.rollCount ? `; carried over ${t.rollCount} day(s)` : ""}`);
  }
  const snap = await readInvolvementSnapshot(ctx.store).catch(() => null);
  if (snap) {
    const buckets: [string, InvolvementItem[]][] = [["assigned issue", snap.assignedIssues], ["my open PR", snap.myOpenPrs], ["review request", snap.reviewRequests], ["mention", snap.mentions]];
    for (const [label, items] of buckets) {
      for (const it of items) {
        if (hit(`${it.repo} ${it.title} #${it.number}`)) out.push(`[${label}] ${safeText(it.repo)} #${it.number}: ${oneLine(safeText(it.title))}; updated ${it.updatedAt.slice(0, 10)}; ${it.url}`);
      }
    }
  }
  return out.slice(0, 12);
}

export async function searchNotes(ctx: AgentContext, args: Record<string, unknown>, env: ToolEnv): Promise<ToolResult> {
  const query = typeof args.query === "string" && args.query ? args.query : cut(env.msg.text, 100);
  const hits = await retrieve(ctx, query);
  const tracked = await trackedFacts(ctx, words(`${query} ${cut(env.msg.text, 200)}`), ctx.clock.tz);
  if (hits.length === 0 && tracked.length === 0) return { ok: true, render: "I couldn't find that in your notes or in what I'm tracking." };
  const noteFacts = hits.map((h) => `[${h.path}]\n${cut(cleanText(h.excerpt), 700)}`);
  const render = [
    ...(tracked.length ? ["Here is what I have:", ...tracked.slice(0, 6).map((f) => `• ${f.replace(/^\[[^\]]+\]\s*/, "")}`)] : []),
    ...(hits.length ? ["From your notes:", ...hits.slice(0, 5).map((h) => `• ${h.path}`)] : []),
  ].join("\n");
  return { ok: true, render, data: [...tracked, ...noteFacts].join("\n\n") };
}
