import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeFetch, type FakeRoute } from "../testing/fakes.ts";
import { GithubError } from "./github.ts";
import { fetchInvolvement, MAX_FETCHES, type InvolvementSnapshot } from "./involvement.ts";

const NOW = "2026-09-21T00:00:00Z";
const node = (repo: string, n: number, title = `t${n}`, updatedAt = `2026-09-${String(10 + (n % 10)).padStart(2, "0")}T00:00:00Z`, kind = "issues") => ({
  number: n, title, url: `https://github.com/${repo}/${kind}/${n}`, updatedAt, state: "OPEN", repository: { nameWithOwner: repo },
});
const search = (nodes: unknown[], issueCount = nodes.length) => ({ issueCount, nodes });
const data = (over: Record<string, unknown> = {}) => ({
  viewer: { login: "me", repositoriesContributedTo: { nodes: [
    { nameWithOwner: "a/old", isPrivate: false, pushedAt: "2026-09-01T00:00:00Z" },
    { nameWithOwner: "b/new", isPrivate: false, pushedAt: "2026-09-15T00:00:00Z" },
  ] } },
  assigned: search([node("o/r", 1)]),
  myPRs: search([node("o/r", 2, "pr", undefined, "pull")]),
  reviews: search([node("o/r", 3, "rv", undefined, "pull")]),
  mentions: search([node("o/r", 3, "rv", undefined, "pull"), node("o/r", 4, "m")]),
  rateLimit: { cost: 1, remaining: 4999, resetAt: "2026-09-21T01:00:00Z" },
  ...over,
});
const gqlOk = (d: unknown): FakeRoute => ({ match: "/graphql", json: { data: d } });
const base = { token: "t", maxPerBucket: 8, now: NOW };

const restRoutes = (): FakeRoute[] => [
  { match: "/issues?filter=assigned", json: [{ number: 1, title: "a", html_url: "x", updated_at: "2026-09-10T00:00:00Z", state: "open", repository: { full_name: "o/r" } }] },
  { match: /q=author%3A/, json: { total_count: 1, items: [{ number: 2, title: "p", html_url: "x", updated_at: "2026-09-10T00:00:00Z", state: "open", repository_url: "https://api.github.com/repos/o/r", pull_request: {} }] } },
  { match: /q=review-requested%3A/, json: { total_count: 0, items: [] } },
  { match: /q=mentions%3A/, json: { total_count: 0, items: [] } },
  { match: "/user/repos", json: [{ full_name: "o/r", pushed_at: "2026-09-10T00:00:00Z" }] },
];

test("all buckets, recentRepos sorted; a duplicate shows once in its highest-priority bucket", async () => {
  const f = fakeFetch([gqlOk(data())]);
  const s = await fetchInvolvement({ ...base, login: "me", fetch: f });
  assert.equal(s.reviewRequests.length, 1);
  assert.deepEqual(s.mentions.map((i) => i.number), [4]);
  assert.equal(s.assignedIssues[0]!.url, "https://github.com/o/r/issues/1");
  assert.equal(s.myOpenPrs[0]!.url, "https://github.com/o/r/pull/2");
  assert.deepEqual(s.recentRepos.map((r) => r.fullName), ["b/new", "a/old"]);
  assert.equal(s.recentRepos[0]!.reason, "contributed");
  assert.deepEqual(s.partial, []);
  assert.equal(s.fetchedAt, NOW);
});

test("caps at maxPerBucket while totals stay real, sorted newest first", async () => {
  const nodes = Array.from({ length: 25 }, (_, i) => node("o/r", i + 1));
  const f = fakeFetch([gqlOk(data({ assigned: search(nodes, 60) }))]);
  const s = await fetchInvolvement({ ...base, login: "me", maxPerBucket: 5, fetch: f });
  assert.equal(s.assignedIssues.length, 5);
  assert.equal(s.totals.assignedIssues, 60);
  const d = s.assignedIssues.map((i) => i.updatedAt);
  assert.deepEqual(d, [...d].sort().reverse());
});

test("a null bucket with errors[] is partial; the rest survive and previous data is reused", async () => {
  const prev: InvolvementSnapshot = {
    ...(await fetchInvolvement({ ...base, login: "me", fetch: fakeFetch([gqlOk(data())]) })),
  };
  const f = fakeFetch([{ match: "/graphql", json: { data: data({ reviews: null }), errors: [{ message: "boom" }] } }]);
  const s = await fetchInvolvement({ ...base, login: "me", previous: prev, fetch: f });
  assert.deepEqual(s.partial, ["reviewRequests"]);
  assert.deepEqual(s.reviewRequests, prev.reviewRequests);
  assert.equal(s.totals.reviewRequests, prev.totals.reviewRequests);
  assert.equal(s.assignedIssues.length, 1);
  const none = await fetchInvolvement({ ...base, login: "me", fetch: fakeFetch([{ match: "/graphql", json: { data: data({ reviews: null }) } }]) });
  assert.deepEqual(none.reviewRequests, []);
});

test("every part failing throws", async () => {
  const f = fakeFetch([{ match: "/graphql", json: { data: { viewer: null, assigned: null, myPRs: null, reviews: null, mentions: null }, errors: [{}] } }]);
  await assert.rejects(fetchInvolvement({ ...base, login: "me", fetch: f }), /all GitHub involvement queries failed/);
});

test("GraphQL 500 falls back to exactly the five REST calls", async () => {
  const f = fakeFetch([{ match: "/graphql", status: 500, text: "x" }, ...restRoutes()]);
  const s = await fetchInvolvement({ ...base, login: "me", fetch: f });
  assert.equal(f.calls.length, 6);
  assert.equal(f.calls.filter((c) => !c.url.endsWith("/graphql")).length, 5);
  assert.equal(s.assignedIssues.length, 1);
  assert.equal(s.myOpenPrs[0]!.url, "https://github.com/o/r/pull/2");
  assert.deepEqual(s.partial, []);
});

test("rate limit throws GithubError with no further call; 401 throws", async () => {
  const f = fakeFetch([{ match: "/graphql", status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1790000000" }, text: "" }, ...restRoutes()]);
  await assert.rejects(fetchInvolvement({ ...base, login: "me", fetch: f }), (e) => e instanceof GithubError && /resets 20/.test(e.message));
  assert.equal(f.calls.length, 1);
  const g = fakeFetch([{ match: "/graphql", status: 401, text: "" }, ...restRoutes()]);
  await assert.rejects(fetchInvolvement({ ...base, login: "me", fetch: g }), (e) => e instanceof GithubError && e.status === 401);
  assert.equal(g.calls.length, 1);
  const h = fakeFetch([{ match: "/graphql", json: { data: null, errors: [{ type: "RATE_LIMITED" }] } }]);
  await assert.rejects(fetchInvolvement({ ...base, login: "me", fetch: h }), GithubError);
});

test("bad login throws before any fetch; excluded repos dropped; hostile url and repo replaced", async () => {
  const f = fakeFetch([gqlOk(data())]);
  await assert.rejects(fetchInvolvement({ ...base, login: "me\" is:pr", fetch: f }), /invalid GitHub login/);
  assert.equal(f.calls.length, 0);
  const hostile = { ...node("o/r", 9), url: "https://evil.example/x" };
  const g = fakeFetch([gqlOk(data({ assigned: search([hostile, node("Vault/Repo", 1), node("bad repo/x y", 2), node("o/r", 5)]) }))]);
  const s = await fetchInvolvement({ ...base, login: "me", exclude: ["vault/repo"], fetch: g });
  assert.deepEqual(s.assignedIssues.map((i) => i.number).sort(), [5, 9]);
  assert.equal(s.assignedIssues.find((i) => i.number === 9)!.url, "https://github.com/o/r/issues/9");
});

test("request counts: happy=1, login absent=2, 500+REST+login absent=7, all-500 within MAX_FETCHES", async () => {
  const a = fakeFetch([gqlOk(data())]);
  await fetchInvolvement({ ...base, login: "me", fetch: a });
  assert.equal(a.calls.length, 1);

  const loginRoute: FakeRoute = { match: "/graphql", times: 1, json: { data: { viewer: { login: "me" } } } };
  const b = fakeFetch([loginRoute, gqlOk(data())]);
  await fetchInvolvement({ ...base, fetch: b });
  assert.equal(b.calls.length, 2);

  const c = fakeFetch([loginRoute, { match: "/graphql", status: 500, text: "" }, ...restRoutes()]);
  await fetchInvolvement({ ...base, fetch: c });
  assert.equal(c.calls.length, 7);

  for (const login of [undefined, "me"]) {
    const d = fakeFetch([{ match: "github.com", status: 500, text: "" }]);
    await assert.rejects(fetchInvolvement({ ...base, login, fetch: d }));
    assert.ok(d.calls.length <= MAX_FETCHES, `${d.calls.length}`);
  }
  assert.equal(MAX_FETCHES, 8);
});
