import type { Item, Milestone, RepoSnapshot } from "../types.ts";
import { clean, frontmatter, link } from "./markdown.ts";

export const repoNotePath = (fullName: string): string => `GitHub/repos/${fullName.replace("/", "__")}.md`;

const items = (list: Item[]): string =>
  list.length ? list.map((i) => `- ${link(`#${i.number} ${i.title}`, i.url)} — @${i.author}`).join("\n") : "_none_";

const milestones = (list: Milestone[]): string =>
  list.length
    ? list
        .map((m) => `- ${link(m.title, m.url)} — due ${m.dueOn ? m.dueOn.slice(0, 10) : "no date"}, ${m.openIssues} open`)
        .join("\n")
    : "_none_";

/** No wall-clock values: unchanged upstream data must render byte-identical (clean git history). */
export function renderRepoNote(r: RepoSnapshot): string {
  return (
    frontmatter({
      type: "repo",
      repo: r.fullName,
      updated: r.pushedAt,
      open_issues: r.openIssues,
      open_prs: r.openPrs,
      my_open_prs: r.myOpenPrs,
      default_branch: r.defaultBranch,
      private: r.private,
    }) +
    `\n# ${clean(r.fullName)}\n\n## Pull requests\n${items(r.prs)}\n\n## Issues\n${items(r.issues)}\n\n## Milestones\n${milestones(r.milestones)}\n`
  );
}
