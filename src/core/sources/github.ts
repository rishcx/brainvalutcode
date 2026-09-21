import type { Fetcher, GithubSnapshot, Item, Milestone, RepoSnapshot } from "../types.ts";

const API = "https://api.github.com";
const LIST_CAP = 10;

export interface GithubOpts {
  token: string;
  repos?: string[]; // explicit allowlist; empty = auto-pick
  maxRepos: number;
  /**
   * Repos never tracked. The vault repo MUST be here: the agent commits to it, which moves its own pushed_at,
   * which changes its note, which is another commit: a feedback loop of one commit per poll.
   */
  exclude?: string[];
  fetch: Fetcher;
}

export class GithubError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "GithubError";
  }
}

const RETRYABLE = (s: number): boolean => s === 429 || s >= 500;

async function gh(o: GithubOpts, path: string): Promise<Response> {
  const url = path.startsWith("http") ? path : API + path;
  for (let attempt = 0; ; attempt++) {
    const res = await o.fetch(url, {
      headers: {
        Authorization: `Bearer ${o.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "brain-agent",
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.ok) return res;
    // Secondary rate limits come back as 403 with the budget exhausted; both are terminal
    // for this poll, so say when it resets instead of retrying into the wall.
    const remaining = res.headers.get("x-ratelimit-remaining");
    if ((res.status === 403 || res.status === 429) && remaining === "0") {
      const reset = Number(res.headers.get("x-ratelimit-reset") ?? 0);
      const when = reset ? new Date(reset * 1000).toISOString() : "unknown";
      throw new GithubError(res.status, `GitHub rate limit exhausted for ${path}; resets ${when}`);
    }
    if (RETRYABLE(res.status) && attempt === 0) continue;
    throw new GithubError(res.status, `GitHub ${res.status} for ${path}: ${(await res.text()).slice(0, 200)}`);
  }
}

async function json<T>(o: GithubOpts, path: string): Promise<T> {
  return (await gh(o, path)).json() as Promise<T>;
}

interface RawIssue {
  number: number;
  title: string;
  html_url: string;
  updated_at: string;
  user: { login: string } | null;
  pull_request?: unknown;
}

interface RawRepo {
  full_name: string;
  private: boolean;
  default_branch: string;
  pushed_at: string;
  archived: boolean;
  fork: boolean;
  /** Issues + PRs. Absent on repos fetched by name; treated as "unknown, fetch". */
  open_issues_count?: number;
}

const toItem = (i: RawIssue): Item => ({
  number: i.number,
  title: i.title,
  url: i.html_url,
  updatedAt: i.updated_at,
  author: i.user?.login ?? "unknown",
});

async function snapshotRepo(o: GithubOpts, login: string, r: RawRepo): Promise<RepoSnapshot> {
  // Up to two subrequests per repo (a Worker on the free plan gets 50 per invocation). A repo the list already
  // says has no open issues/PRs skips the issues call; milestones are always fetched because a dated milestone
  // with nothing attached is still a deadline. per_page=100 is one page; larger counts are floored, fine for a digest.
  const [issues, ms] = await Promise.all([
    r.open_issues_count === 0
      ? Promise.resolve<RawIssue[]>([])
      : json<RawIssue[]>(o, `/repos/${r.full_name}/issues?state=open&sort=updated&per_page=100`),
    json<{ number: number; title: string; due_on: string | null; open_issues: number; html_url: string }[]>(
      o,
      `/repos/${r.full_name}/milestones?state=open&per_page=50`,
    ),
  ]);
  const prs = issues.filter((i) => i.pull_request);
  const plain = issues.filter((i) => !i.pull_request);
  const milestones: Milestone[] = ms.map((m) => ({
    number: m.number,
    title: m.title,
    dueOn: m.due_on,
    openIssues: m.open_issues,
    url: m.html_url,
  }));
  return {
    fullName: r.full_name,
    private: r.private,
    defaultBranch: r.default_branch,
    pushedAt: r.pushed_at,
    openIssues: plain.length,
    openPrs: prs.length,
    myOpenPrs: prs.filter((p) => p.user?.login === login).length,
    issues: plain.slice(0, LIST_CAP).map(toItem),
    prs: prs.slice(0, LIST_CAP).map(toItem),
    milestones,
  };
}

async function pool<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

/** Explicitly configured repos are fetched by name: they may be outside page 1 of /user/repos. */
const isExcluded = (o: GithubOpts, fullName: string): boolean =>
  (o.exclude ?? []).some((x) => x.toLowerCase() === fullName.toLowerCase());

async function wantedRepos(o: GithubOpts): Promise<{ repos: RawRepo[]; skipped: string[] }> {
  if (o.repos?.length) {
    const skipped: string[] = [];
    const got = await pool(o.repos, 5, async (name) => {
      try {
        return await json<RawRepo>(o, `/repos/${name}`);
      } catch (e) {
        if (e instanceof GithubError && e.status === 404) {
          skipped.push(name);
          return null;
        }
        throw e;
      }
    });
    return { repos: got.filter((r): r is RawRepo => r !== null), skipped };
  }
  // Auto-pick: one page sorted by push recency is more than maxRepos worth of candidates.
  const all = await json<RawRepo[]>(o, "/user/repos?affiliation=owner&sort=pushed&per_page=100");
  return { repos: all.filter((r) => !r.archived && !r.fork && !isExcluded(o, r.full_name)).slice(0, o.maxRepos), skipped: [] };
}

export async function fetchGithub(o: GithubOpts): Promise<GithubSnapshot> {
  const me = await json<{ login: string }>(o, "/user");
  const { repos: wanted, skipped } = await wantedRepos(o);

  const repos = await pool(wanted, 5, (r) => snapshotRepo(o, me.login, r));
  repos.sort((a, b) => a.fullName.localeCompare(b.fullName));

  const rr = await json<{ items: (RawIssue & { repository_url: string })[] }>(
    o,
    `/search/issues?q=${encodeURIComponent(`review-requested:${me.login} is:pr is:open`)}&per_page=20`,
  );
  const reviewRequested = rr.items.map((i) => ({
    ...toItem(i),
    repo: i.repository_url.replace(`${API}/repos/`, ""),
  }));

  return { login: me.login, repos, reviewRequested, skipped };
}
