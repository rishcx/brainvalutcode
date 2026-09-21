import type { Clock, Deadline, GithubSnapshot } from "../types.ts";
import { daysBetweenLocalDates, localDate, localDateOf } from "../time.ts";
import { clean, frontmatter, link } from "./markdown.ts";

/**
 * Deterministic digest: pure facts from data, no LLM. The LLM brain later rewrites the
 * same facts as prose. No wall-clock values and day-granularity buckets, so two runs on
 * the same local day produce byte-identical output.
 */
export function renderDigest(gh: GithubSnapshot, ds: Deadline[], clock: Clock, tasksSection = ""): string {
  const today = localDate(clock);
  const days = (d: Deadline) => daysBetweenLocalDates(today, localDateOf(new Date(d.dueAt), clock.tz));
  const open = ds.filter((d) => d.status === "open").sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  const overdue = open.filter((d) => days(d) < 0);
  const soon = open.filter((d) => days(d) >= 0 && days(d) < 14);
  const dl = (d: Deadline) => `- ${localDateOf(new Date(d.dueAt), clock.tz)} — ${clean(d.title)}`;
  const stale = gh.repos
    .map((r) => ({ r, days: daysBetweenLocalDates(localDateOf(new Date(r.pushedAt), clock.tz), today) }))
    .filter((x) => x.days >= 30)
    .sort((a, b) => b.days - a.days || a.r.fullName.localeCompare(b.r.fullName));
  const totals = gh.repos.reduce(
    (a, r) => ({ issues: a.issues + r.openIssues, prs: a.prs + r.openPrs, mine: a.mine + r.myOpenPrs }),
    { issues: 0, prs: 0, mine: 0 },
  );

  const sec = (title: string, lines: string[]) => `## ${title}\n${lines.length ? lines.join("\n") : "_none_"}\n`;

  return (
    frontmatter({ type: "digest", date: today, model: "deterministic", sources: ["github"] }) +
    `\n# Digest ${today}\n\n` +
    (tasksSection ? `${tasksSection}\n\n` : "") +
    `**${gh.repos.length} repos** · ${totals.issues} open issues · ${totals.prs} open PRs (${totals.mine} yours)\n\n` +
    sec("Overdue", overdue.map(dl)) +
    "\n" +
    sec("Due in the next 14 days", soon.map(dl)) +
    "\n" +
    sec(
      "Review requested from you",
      gh.reviewRequested.map((i) => `- ${clean(i.repo)} ${link(`#${i.number} ${i.title}`, i.url)}`),
    ) +
    "\n" +
    sec(
      "Quiet for 30+ days",
      stale.map((x) => `- ${clean(x.r.fullName)} — ${x.days} days`),
    )
  );
}
