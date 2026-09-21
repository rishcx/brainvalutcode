import type { Clock, Deadline } from "../types.ts";
import { daysBetweenLocalDates, localDate, localDateOf } from "../time.ts";
import { clean, frontmatter } from "./markdown.ts";

export function renderDeadlineJson(ds: Deadline[]): string {
  return JSON.stringify([...ds].sort((a, b) => a.id.localeCompare(b.id)), null, 2) + "\n";
}

/**
 * Buckets by local calendar day, not by elapsed milliseconds: two runs on the same day
 * must render byte-identical, and "due today" must mean today in Asia/Kolkata.
 */
export function renderDeadlineIndex(ds: Deadline[], clock: Clock): string {
  const today = localDate(clock);
  const days = (d: Deadline) => daysBetweenLocalDates(today, localDateOf(new Date(d.dueAt), clock.tz));
  const open = ds.filter((d) => d.status === "open").sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  const proposed = ds.filter((d) => d.status === "proposed").sort((a, b) => a.dueAt.localeCompare(b.dueAt));

  const row = (d: Deadline) => `- ${localDateOf(new Date(d.dueAt), clock.tz)} — ${clean(d.title)} _(${d.source})_`;
  const sec = (title: string, list: Deadline[]) => `## ${title}\n${list.length ? list.map(row).join("\n") : "_none_"}\n`;
  const group = (title: string, pick: (n: number) => boolean) => sec(title, open.filter((d) => pick(days(d))));

  return (
    frontmatter({ type: "deadline-index", open: open.length, proposed: proposed.length, date: today }) +
    `\n# Deadlines\n\n` +
    [
      group("Overdue", (n) => n < 0),
      group("Next 7 days", (n) => n >= 0 && n < 7),
      group("Later", (n) => n >= 7),
      sec("Proposed (unconfirmed)", proposed),
    ].join("\n")
  );
}
