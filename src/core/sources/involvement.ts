// GitHub involvement snapshot: what is waiting on the owner, across ANY repo. One GraphQL POST in the steady
// state; REST only if GraphQL itself fails. Every title here is untrusted text: it is carried as data and only
// sanitised where it is rendered (render/involvement.ts).
import type { Fetcher, Store } from "../types.ts";
import { GithubError } from "./github.ts";

export type Bucket = "assignedIssues" | "myOpenPrs" | "reviewRequests" | "mentions";
export interface InvolvementItem {
  repo: string;
  number: number;
  title: string;
  url: string;
  updatedAt: string;
  state: string;
}
export interface InvolvementSnapshot {
  login: string;
  assignedIssues: InvolvementItem[];
  myOpenPrs: InvolvementItem[];
  reviewRequests: InvolvementItem[];
  mentions: InvolvementItem[];
  recentRepos: { fullName: string; lastActivityAt: string; reason: string }[];
  totals: Record<Bucket, number>; // real counts before capping
  fetchedAt: string; // kv only, never rendered
  partial: string[]; // failed buckets, sorted
}
export interface InvolvementOpts {
  token: string;
  login?: string;
  maxPerBucket: number;
  exclude?: string[]; // vault repo (its own commits would loop)
  previous?: InvolvementSnapshot | null;
  now: string;
  fetch: Fetcher;
}

export const INVOLVEMENT_KV = "gh:involvement";
export const LOGIN_KV = "gh:login";
export const MAX_FETCHES = 8; // counting fetch wrapper; the 9th call throws

export const BUCKETS: readonly Bucket[] = ["reviewRequests", "assignedIssues", "myOpenPrs", "mentions"]; // dedupe priority
const API = "https://api.github.com";
const LOGIN_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const RECENT_CAP = 20;

export const isValidLogin = (s: string): boolean => LOGIN_RE.test(s);

// The query is PLAN_V2 §F.3 verbatim except: the declared-but-unused `$me` variable is dropped (GraphQL rejects
// unused variables as a validation error, which would send every run to the REST fallback).
const QUERY = `query($assigned: String!, $mine: String!, $reviews: String!, $mentions: String!) {
  viewer {
    login
    repositoriesContributedTo(
      first: 20
      includeUserRepositories: true
      contributionTypes: [COMMIT, ISSUE, PULL_REQUEST, PULL_REQUEST_REVIEW]
      orderBy: { field: PUSHED_AT, direction: DESC }
    ) { nodes { nameWithOwner isPrivate pushedAt } }
  }
  assigned: search(query: $assigned, type: ISSUE, first: 25) {
    issueCount
    nodes { ... on Issue { number title url updatedAt state repository { nameWithOwner } } }
  }
  myPRs: search(query: $mine, type: ISSUE, first: 25) {
    issueCount
    nodes { ... on PullRequest { number title url updatedAt state isDraft repository { nameWithOwner } } }
  }
  reviews: search(query: $reviews, type: ISSUE, first: 25) {
    issueCount
    nodes { ... on PullRequest { number title url updatedAt state repository { nameWithOwner } } }
  }
  mentions: search(query: $mentions, type: ISSUE, first: 25) {
    issueCount
    nodes {
      ... on Issue        { number title url updatedAt state repository { nameWithOwner } }
      ... on PullRequest  { number title url updatedAt state repository { nameWithOwner } }
    }
  }
  rateLimit { cost remaining resetAt }
}`;

/** Not a GithubError: this request failed in a way that lets the fallback / partial path try again elsewhere. */
class Soft extends Error {}
class BudgetError extends Error {}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

function counting(f: Fetcher): Fetcher {
  let n = 0;
  return (url, init) => {
    if (++n > MAX_FETCHES) throw new BudgetError(`involvement fetch budget exceeded (${MAX_FETCHES})`);
    return f(url, init);
  };
}

const headers = (token: string, post: boolean): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "brain-agent",
  ...(post ? { "Content-Type": "application/json" } : {}),
});

const rateLimited = (what: string, res: Response): GithubError => {
  const reset = Number(res.headers.get("x-ratelimit-reset") ?? 0);
  const when = reset ? new Date(reset * 1000).toISOString() : "unknown";
  return new GithubError(res.status, `GitHub rate limit exhausted for ${what}; resets ${when}`);
};

/** Fatal statuses throw GithubError; anything else non-OK is Soft. Never retries. */
async function send(f: Fetcher, token: string, path: string, init?: { body: string }): Promise<Response> {
  let res: Response;
  try {
    res = await f(API + path, {
      method: init ? "POST" : "GET",
      headers: headers(token, !!init),
      ...(init ? { body: init.body } : {}),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    if (e instanceof BudgetError) throw e;
    throw new Soft(`network error for ${path}`);
  }
  if (res.ok) return res;
  if (res.status === 401) throw new GithubError(401, `GitHub 401 for ${path}: token rejected or expired`);
  if ((res.status === 403 || res.status === 429) && (res.headers.get("x-ratelimit-remaining") === "0" || res.headers.has("retry-after"))) {
    throw rateLimited(path, res);
  }
  throw new Soft(`GitHub ${res.status} for ${path}`);
}

async function jsonOf(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    throw new Soft("bad JSON");
  }
}

const gql = (f: Fetcher, token: string, query: string, variables: Record<string, string>) =>
  send(f, token, "/graphql", { body: JSON.stringify({ query, variables }) });

/** Rate limits can also arrive as HTTP 200 + errors[type=RATE_LIMITED]. */
function assertNotRateLimited(body: Record<string, unknown>): void {
  const errs = Array.isArray(body.errors) ? body.errors : [];
  if (!errs.some((e) => isObj(e) && (e.type === "RATE_LIMITED" || e.code === "RATE_LIMITED"))) return;
  const rl = isObj(body.data) && isObj(body.data.rateLimit) ? str(body.data.rateLimit.resetAt) : null;
  throw new GithubError(429, `GitHub GraphQL rate limit exhausted; resets ${rl ?? "unknown"}`);
}

async function resolveLogin(f: Fetcher, token: string): Promise<string> {
  let login: string | null = null;
  try {
    const body = await jsonOf(await gql(f, token, "query{viewer{login}}", {}));
    if (isObj(body)) {
      assertNotRateLimited(body);
      if (isObj(body.data) && isObj(body.data.viewer)) login = str(body.data.viewer.login);
    }
  } catch (e) {
    if (!(e instanceof Soft)) throw e;
  }
  if (!login) {
    try {
      const u = await jsonOf(await send(f, token, "/user"));
      login = isObj(u) ? str(u.login) : null;
    } catch (e) {
      if (!(e instanceof Soft)) throw e;
    }
  }
  if (!login || !LOGIN_RE.test(login)) throw new Error("could not resolve a valid GitHub login");
  return login;
}

/* ---------------------------------------------------------------- normalise */

type Raw = { repo: unknown; number: unknown; title: unknown; url: unknown; updatedAt: unknown; state: unknown };

function toItem(r: Raw, bucket: Bucket): InvolvementItem | null {
  const repo = str(r.repo);
  if (!repo || !REPO_RE.test(repo) || typeof r.number !== "number" || !Number.isInteger(r.number) || r.number < 1) return null;
  const title = str(r.title);
  const updatedAt = str(r.updatedAt);
  if (title === null || updatedAt === null) return null;
  // The API's own url is never trusted: rebuild it from repo + number. mentions may be either kind.
  const pull =
    bucket === "myOpenPrs" || bucket === "reviewRequests" || (bucket === "mentions" && /\/pull\/\d+\/?$/.test(str(r.url) ?? ""));
  return {
    repo,
    number: r.number,
    title,
    url: `https://github.com/${repo}/${pull ? "pull" : "issues"}/${r.number}`,
    updatedAt,
    state: str(r.state) ?? "",
  };
}

interface Part {
  items: InvolvementItem[];
  total: number;
}

function gqlPart(v: unknown, bucket: Bucket): Part | null {
  if (!isObj(v) || !Array.isArray(v.nodes)) return null;
  const items: InvolvementItem[] = [];
  for (const n of v.nodes) {
    if (!isObj(n) || n.number === undefined) continue; // empty union node
    const repo = isObj(n.repository) ? n.repository.nameWithOwner : undefined;
    const it = toItem({ number: n.number, title: n.title, url: n.url, updatedAt: n.updatedAt, state: n.state, repo }, bucket);
    if (it) items.push(it);
  }
  return { items, total: typeof v.issueCount === "number" ? v.issueCount : items.length };
}

type Repos = { fullName: string; lastActivityAt: string }[];

function gqlRepos(viewer: unknown): Repos | null {
  if (!isObj(viewer) || !isObj(viewer.repositoriesContributedTo) || !Array.isArray(viewer.repositoriesContributedTo.nodes)) return null;
  const out: Repos = [];
  for (const n of viewer.repositoriesContributedTo.nodes) {
    if (isObj(n) && str(n.nameWithOwner) && str(n.pushedAt)) out.push({ fullName: n.nameWithOwner as string, lastActivityAt: n.pushedAt as string });
  }
  return out;
}

const q = (s: string): string => encodeURIComponent(s);

async function restPart(f: Fetcher, token: string, path: string, bucket: Bucket): Promise<Part> {
  const body = await jsonOf(await send(f, token, path));
  const list = Array.isArray(body) ? body : isObj(body) && Array.isArray(body.items) ? body.items : null;
  if (!list) throw new Soft("bad shape");
  const items: InvolvementItem[] = [];
  for (const n of list) {
    if (!isObj(n)) continue;
    if (bucket === "assignedIssues" && n.pull_request) continue; // /issues also lists assigned PRs
    const repo = isObj(n.repository) ? n.repository.full_name : str(n.repository_url)?.replace(`${API}/repos/`, "");
    const it = toItem({ repo, number: n.number, title: n.title, url: n.html_url, updatedAt: n.updated_at, state: n.state }, bucket);
    if (it) items.push(it);
  }
  const total = isObj(body) && typeof body.total_count === "number" ? body.total_count : items.length;
  return { items, total };
}

/* ------------------------------------------------------------------ public */

export async function fetchInvolvement(o: InvolvementOpts): Promise<InvolvementSnapshot> {
  if (o.login !== undefined && !LOGIN_RE.test(o.login)) throw new Error("invalid GitHub login");
  const f = counting(o.fetch);
  const login = o.login ?? (await resolveLogin(f, o.token));

  const search: Record<Bucket, string> = {
    assignedIssues: `assignee:${login} is:issue is:open archived:false`,
    myOpenPrs: `author:${login} is:pr is:open archived:false`,
    reviewRequests: `review-requested:${login} is:pr is:open archived:false`,
    mentions: `mentions:${login} is:open archived:false`,
  };

  const parts: Partial<Record<Bucket, Part>> = {};
  let repos: Repos | null = null;

  let data: Record<string, unknown> | null = null;
  try {
    const body = await jsonOf(
      await gql(f, o.token, QUERY, {
        assigned: search.assignedIssues,
        mine: search.myOpenPrs,
        reviews: search.reviewRequests,
        mentions: search.mentions,
      }),
    );
    if (isObj(body)) {
      assertNotRateLimited(body);
      if (isObj(body.data)) data = body.data;
    }
  } catch (e) {
    if (!(e instanceof Soft)) throw e;
  }

  if (data) {
    const alias: Record<Bucket, string> = { assignedIssues: "assigned", myOpenPrs: "myPRs", reviewRequests: "reviews", mentions: "mentions" };
    for (const b of BUCKETS) {
      const p = gqlPart(data[alias[b]], b);
      if (p) parts[b] = p;
    }
    repos = gqlRepos(data.viewer);
  } else {
    const calls: [Bucket | "repos", string][] = [
      ["assignedIssues", "/issues?filter=assigned&state=open&per_page=50"],
      ["myOpenPrs", `/search/issues?advanced_search=true&per_page=25&q=${q(search.myOpenPrs)}`],
      ["reviewRequests", `/search/issues?advanced_search=true&per_page=25&q=${q(search.reviewRequests)}`],
      ["mentions", `/search/issues?advanced_search=true&per_page=25&q=${q(search.mentions)}`],
      ["repos", "/user/repos?affiliation=owner,collaborator,organization_member&sort=pushed&direction=desc&per_page=30"],
    ];
    const settled = await Promise.allSettled(
      calls.map(async ([k, path]) => {
        if (k !== "repos") return restPart(f, o.token, path, k);
        const body = await jsonOf(await send(f, o.token, path));
        if (!Array.isArray(body)) throw new Soft("bad shape");
        return body
          .filter((r) => isObj(r) && str(r.full_name) && str(r.pushed_at))
          .map((r) => ({ fullName: r.full_name as string, lastActivityAt: r.pushed_at as string }));
      }),
    );
    for (const s of settled) if (s.status === "rejected" && !(s.reason instanceof Soft)) throw s.reason; // fatal beats partial
    settled.forEach((s, i) => {
      if (s.status !== "fulfilled") return;
      const k = calls[i]![0];
      if (k === "repos") repos = s.value as Repos;
      else parts[k] = s.value as Part;
    });
  }

  if (BUCKETS.every((b) => !parts[b]) && !repos) throw new Error("all GitHub involvement queries failed");

  const partial: string[] = [];
  const prev = o.previous ?? null;
  const excluded = new Set((o.exclude ?? []).map((x) => x.toLowerCase()));
  const seen = new Set<string>();
  const out = { assignedIssues: [], myOpenPrs: [], reviewRequests: [], mentions: [] } as Record<Bucket, InvolvementItem[]>;
  const totals = { assignedIssues: 0, myOpenPrs: 0, reviewRequests: 0, mentions: 0 } as Record<Bucket, number>;

  for (const b of BUCKETS) {
    const p = parts[b];
    let items: InvolvementItem[];
    let total: number;
    if (p) {
      items = p.items;
      total = p.total;
    } else {
      partial.push(b); // last good data is reused, never wiped
      items = prev?.[b] ?? [];
      total = prev?.totals?.[b] ?? items.length;
    }
    const kept: InvolvementItem[] = [];
    for (const it of items) {
      if (!REPO_RE.test(it.repo) || excluded.has(it.repo.toLowerCase())) continue;
      const key = `${it.repo}#${it.number}`.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      kept.push(it);
    }
    kept.sort(
      (a, c) => (a.updatedAt === c.updatedAt ? 0 : a.updatedAt < c.updatedAt ? 1 : -1) || (a.repo < c.repo ? -1 : a.repo > c.repo ? 1 : 0) || a.number - c.number,
    );
    out[b] = kept.slice(0, o.maxPerBucket);
    totals[b] = Math.max(total, kept.length);
  }

  let recent: Repos;
  if (repos) recent = repos;
  else {
    partial.push("recentRepos");
    recent = prev?.recentRepos ?? [];
  }
  const seenRepo = new Set<string>();
  const recentRepos = recent
    .filter((r) => REPO_RE.test(r.fullName) && !excluded.has(r.fullName.toLowerCase()) && !seenRepo.has(r.fullName.toLowerCase()) && seenRepo.add(r.fullName.toLowerCase()))
    .sort((a, c) => (a.lastActivityAt === c.lastActivityAt ? 0 : a.lastActivityAt < c.lastActivityAt ? 1 : -1) || (a.fullName < c.fullName ? -1 : 1))
    .slice(0, Math.min(RECENT_CAP, Math.max(1, o.maxPerBucket)))
    .map((r) => ({ fullName: r.fullName, lastActivityAt: r.lastActivityAt, reason: "contributed" }));

  return { login, ...out, recentRepos, totals, fetchedAt: o.now, partial: partial.sort() };
}

const isItem = (v: unknown): v is InvolvementItem =>
  isObj(v) &&
  typeof v.repo === "string" &&
  typeof v.number === "number" &&
  typeof v.title === "string" &&
  typeof v.url === "string" &&
  typeof v.updatedAt === "string" &&
  typeof v.state === "string";

/**
 * Schema drift in the kv value must cost the user the drifted FIELD, not the whole snapshot (audit 18): a missing
 * or malformed bucket, total, partial list or repo list is repaired to an empty/derived value and named in
 * `repaired` so the caller can flag it in the trace. Only "not a JSON object" is still fatal.
 */
export function parseSnapshotLoose(raw: string | null): { snap: InvolvementSnapshot; repaired: string[] } | null {
  if (!raw) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(v)) return null;
  const repaired: string[] = [];
  const keep = <T>(name: string, ok: boolean, fallback: T, value: T): T => {
    if (ok) return value;
    repaired.push(name);
    return fallback;
  };
  const rawTotals = isObj(v.totals) ? v.totals : keep("totals", false, {} as Record<string, unknown>, {});
  const out = { assignedIssues: [], myOpenPrs: [], reviewRequests: [], mentions: [] } as Record<Bucket, InvolvementItem[]>;
  const totals = { assignedIssues: 0, myOpenPrs: 0, reviewRequests: 0, mentions: 0 } as Record<Bucket, number>;
  for (const b of BUCKETS) {
    const list = Array.isArray(v[b]) ? (v[b] as unknown[]) : keep(b, false, [] as unknown[], []);
    const items = list.filter(isItem);
    if (items.length !== list.length) repaired.push(`${b}.items`);
    out[b] = items;
    totals[b] = typeof rawTotals[b] === "number" ? (rawTotals[b] as number) : keep(`totals.${b}`, false, items.length, items.length);
  }
  const recent = Array.isArray(v.recentRepos) ? v.recentRepos : keep("recentRepos", false, [] as unknown[], []);
  const recentRepos = recent.filter(
    (r): r is { fullName: string; lastActivityAt: string; reason: string } =>
      isObj(r) && typeof r.fullName === "string" && typeof r.lastActivityAt === "string" && typeof r.reason === "string",
  );
  if (recentRepos.length !== recent.length) repaired.push("recentRepos.items");
  const partialRaw = Array.isArray(v.partial) ? v.partial : keep("partial", false, [] as unknown[], []);
  const snap: InvolvementSnapshot = {
    login: keep("login", typeof v.login === "string", "", v.login as string),
    ...out,
    recentRepos,
    totals,
    fetchedAt: keep("fetchedAt", typeof v.fetchedAt === "string", "", v.fetchedAt as string),
    partial: partialRaw.filter((p): p is string => typeof p === "string"),
  };
  return { snap, repaired: [...new Set(repaired)] };
}

/** null only when the kv value is not a JSON object: a corrupt value degrades to "no previous", never crashes. */
export function parseSnapshot(raw: string | null): InvolvementSnapshot | null {
  return parseSnapshotLoose(raw)?.snap ?? null;
}

export async function readInvolvementSnapshot(store: Pick<Store, "kvGet">): Promise<InvolvementSnapshot | null> {
  return parseSnapshot(await store.kvGet(INVOLVEMENT_KV));
}
