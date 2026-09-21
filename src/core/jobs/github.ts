// ARCHITECT-OWNED: builder packages import from here and never edit this file.
import { renderDeadlineIndex, renderDeadlineJson } from "../render/deadlines.ts";
import { upsertAndMaterialise } from "../reminders/engine.ts";
import { renderRepoNote, repoNotePath } from "../render/repoNote.ts";
import { fetchGithub } from "../sources/github.ts";
import { dueAtFromLocalDate, localDate } from "../time.ts";
import type { AgentContext, Deadline, GithubSnapshot, JobSpec, VaultFile } from "../types.ts";

export const MILESTONE_PREFIX = "gh:milestone:";

/** Every deadline id a repo's milestones can produce. Also the markStale scope for that repo. */
export const milestonePrefix = (fullName: string): string => `${MILESTONE_PREFIX}${fullName}:`;

/**
 * GitHub's due_on is a date pinned to an arbitrary UTC hour; only the date part is meaningful.
 * Route it through the same canonical rule as manual notes and Gmail subjects.
 */
export function milestoneDeadlines(gh: GithubSnapshot, ctx: AgentContext): Deadline[] {
  const hour = ctx.config.reminders.dueHourLocal;
  return gh.repos.flatMap((r) =>
    r.milestones
      .filter((m) => m.dueOn)
      .map((m) => ({
        id: `${milestonePrefix(r.fullName)}${m.number}`,
        source: "github" as const,
        sourceRef: m.url,
        title: `${r.fullName} · ${m.title}`,
        dueAt: dueAtFromLocalDate(m.dueOn!.slice(0, 10), ctx.clock.tz, hour),
        status: "open" as const,
        confidence: 1,
        notePath: repoNotePath(r.fullName),
      })),
  );
}

/** The two rendered views of the deadline table. Re-rendered by every job that changes it. */
export async function deadlineFiles(ctx: AgentContext): Promise<VaultFile[]> {
  const ds = await ctx.store.listDeadlines();
  return [
    { path: "Deadlines/index.md", content: renderDeadlineIndex(ds, ctx.clock) },
    { path: "Deadlines/deadlines.json", content: renderDeadlineJson(ds) },
  ];
}

export const githubSnapshot = async (ctx: AgentContext): Promise<GithubSnapshot> =>
  fetchGithub({ token: await ctx.githubToken(), ...ctx.config.github, exclude: vaultRepo(ctx), fetch: ctx.fetch });

/** The vault repo (VAULT_REPO on the Worker) is where the agent writes; tracking it would loop. */
const vaultRepo = (ctx: AgentContext): string[] => {
  const v = ctx.env("VAULT_REPO");
  return v ? [v] : [];
};

export const pollGithub: JobSpec = {
  name: "poll:github",
  schedule: { everyMinutes: 60 },
  async run(ctx) {
    const gh = await githubSnapshot(ctx);
    const ds = milestoneDeadlines(gh, ctx);
    await upsertAndMaterialise(ctx, ds);
    // Retire milestones this poll no longer sees — but only within repos it actually read,
    // so a repo missing from this snapshot (404 on a configured name) cannot silently stale
    // its own deadlines. A 403/429 aborts the whole poll before this point, by design.
    let staled = 0;
    for (const r of gh.repos) {
      const prefix = milestonePrefix(r.fullName);
      staled += await ctx.store.markStale(
        prefix,
        ds.filter((d) => d.id.startsWith(prefix)).map((d) => d.id),
      );
    }
    const files: VaultFile[] = [
      ...gh.repos.map((r) => ({ path: repoNotePath(r.fullName), content: renderRepoNote(r) })),
      {
        path: "GitHub/summary.md",
        content:
          "---\ntype: github-summary\n---\n\n# GitHub\n\n" +
          gh.repos
            .map(
              (r) =>
                `- [[${repoNotePath(r.fullName).replace(/\.md$/, "")}|${r.fullName}]] — ${r.openPrs} PRs, ${r.openIssues} issues`,
            )
            .join("\n") +
          "\n",
      },
      ...(await deadlineFiles(ctx)),
    ];
    const changed = await ctx.vault.writeFiles(`poll:github ${localDate(ctx.clock)}`, files);
    const n = (f: (r: GithubSnapshot["repos"][number]) => number) => gh.repos.reduce((a, r) => a + f(r), 0);
    return (
      `repos=${gh.repos.length} issues=${n((r) => r.openIssues)} prs=${n((r) => r.openPrs)} ` +
      `milestones=${n((r) => r.milestones.length)} staled=${staled} skipped=${gh.skipped.length} changed=${changed.length}`
    );
  },
};
