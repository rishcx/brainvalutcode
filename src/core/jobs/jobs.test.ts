import assert from "node:assert/strict";
import { test } from "node:test";
import { FixedClock } from "../clock.ts";
import { fakeFetch, MemoryVault, type FakeRoute } from "../testing/fakes.ts";
import { testContext } from "../../node/testing/context.ts";
import type { AgentContext, Store } from "../types.ts";
import { dispatch, nextRunAt, runDueJobs } from "./dispatch.ts";
import { pollGithub } from "./github.ts";

const repo = (full: string, pushedAt = "2026-09-19T00:00:00Z") => ({
  full_name: full, private: false, default_branch: "main", pushed_at: pushedAt, archived: false, fork: false,
});

const milestone = (n: number, dueOn: string | null) => ({
  number: n, title: `m${n}`, due_on: dueOn, open_issues: 2, html_url: `https://github.com/me/a/milestone/${n}`,
});

function routes(extra: FakeRoute[] = []): FakeRoute[] {
  return [
    { match: "/user/repos", json: [repo("me/a"), repo("me/b")] },
    { match: "/search/issues", json: { items: [] } },
    ...extra,
    { match: "/issues?state=open", json: [] },
    { match: "/milestones", json: [] },
    { match: "/user", json: { login: "me" } },
  ];
}

const ctxWith = (rs: FakeRoute[], over: Partial<AgentContext> = {}): AgentContext =>
  testContext({ fetch: fakeFetch(rs), vault: new MemoryVault(), ...over });

test("poll:github materialises milestone deadlines at the canonical local hour", async () => {
  const ctx = ctxWith(routes([{ match: "/repos/me/a/milestones", json: [milestone(3, "2026-10-01T07:00:00Z")] }]));
  const out = await dispatch("poll:github", ctx);
  assert.match(out, /repos=2/);
  const ds = await ctx.store.listDeadlines();
  assert.equal(ds.length, 1);
  assert.equal(ds[0]!.id, "gh:milestone:me/a:3");
  // due_on's arbitrary 07:00Z is discarded; 09:00 Asia/Kolkata == 03:30Z.
  assert.equal(ds[0]!.dueAt, "2026-10-01T03:30:00.000Z");
  assert.equal(ds[0]!.confidence, 1);
  const vault = ctx.vault as MemoryVault;
  assert.ok(vault.files.has("GitHub/repos/me__a.md"));
  assert.ok(vault.files.has("Deadlines/index.md"));
  assert.match(vault.files.get("Deadlines/index.md")!, /2026-10-01/);
});

test("a milestone that loses its due date or disappears is staled, not left open forever", async () => {
  const first = ctxWith(routes([{ match: "/repos/me/a/milestones", json: [milestone(3, "2026-10-01T07:00:00Z")] }]));
  await dispatch("poll:github", first);
  const store = first.store;

  // Same store, next poll: the milestone no longer has a due date.
  const second = ctxWith(routes([{ match: "/repos/me/a/milestones", json: [milestone(3, null)] }]), { store });
  assert.match(await dispatch("poll:github", second), /staled=1/);
  assert.equal((await store.getDeadline("gh:milestone:me/a:3"))!.status, "stale");
});

test("a repo that fails to load cannot stale its own deadlines", async () => {
  const ctx = ctxWith([
    { match: "/user/repos", json: [repo("me/a"), repo("me/b")] },
    { match: "/repos/me/a/milestones", json: [milestone(3, "2026-10-01T07:00:00Z")] },
    { match: "/search/issues", json: { items: [] } },
    { match: "/issues?state=open", json: [] },
    { match: "/milestones", json: [] },
    { match: "/user", json: { login: "me" } },
  ]);
  await dispatch("poll:github", ctx);
  assert.equal((await ctx.store.getDeadline("gh:milestone:me/a:3"))!.status, "open");

  // Next poll only sees me/b (me/a is gone from the listing): me/a must NOT be staled,
  // because markStale is scoped to the repos this poll actually read.
  const next = ctxWith(
    [
      { match: "/user/repos", json: [repo("me/b")] },
      { match: "/search/issues", json: { items: [] } },
      { match: "/issues?state=open", json: [] },
      { match: "/milestones", json: [] },
      { match: "/user", json: { login: "me" } },
    ],
    { store: ctx.store },
  );
  assert.match(await dispatch("poll:github", next), /staled=0/);
  assert.equal((await ctx.store.getDeadline("gh:milestone:me/a:3"))!.status, "open");
});

test("explicitly configured repos are fetched by name, not filtered out of page one", async () => {
  const fetch = fakeFetch([
    { match: /\/repos\/me\/deep$/, json: repo("me/deep") },
    { match: /\/repos\/me\/gone$/, status: 404, json: { message: "Not Found" } },
    { match: "/search/issues", json: { items: [] } },
    { match: "/issues?state=open", json: [] },
    { match: "/milestones", json: [] },
    { match: "/user", json: { login: "me" } },
  ]);
  const ctx = testContext({
    fetch,
    vault: new MemoryVault(),
    configPatch: { github: { maxRepos: 15, repos: ["me/deep", "me/gone"] } },
  });
  const out = await pollGithub.run(ctx);
  assert.match(out, /repos=1 /);
  assert.match(out, /skipped=1/);
  assert.equal(fetch.calls.some((c) => c.url.includes("/user/repos")), false);
});

test("the poll is byte-stable: an unchanged upstream writes nothing the second time", async () => {
  const rs = routes([{ match: "/repos/me/a/milestones", json: [milestone(3, "2026-10-01T07:00:00Z")] }]);
  const vault = new MemoryVault();
  const store = testContext().store;
  const mk = () => ctxWith(rs, { vault, store });
  assert.match(await dispatch("poll:github", mk()), /changed=[1-9]/);
  assert.match(await dispatch("poll:github", mk()), /changed=0/);
  assert.equal(vault.commits.length, 1);
});

test("dispatch rejects unknown jobs by name", async () => {
  await assert.rejects(dispatch("poll:mars", testContext()), /unknown job/);
});

test("nextRunAt schedules intervals in UTC and daily jobs in local time", () => {
  const at = new Date("2026-09-20T04:30:00Z");
  assert.equal(nextRunAt({ everyMinutes: 60 }, at, "Asia/Kolkata").toISOString(), "2026-09-20T05:30:00.000Z");
  // 08:00 Asia/Kolkata tomorrow, because 04:30Z is already 10:00 local today.
  assert.equal(nextRunAt({ dailyAtLocal: "08:00" }, at, "Asia/Kolkata").toISOString(), "2026-09-21T02:30:00.000Z");
});

test("runDueJobs runs what is due, records it and reschedules — a failure does not hot-loop", async () => {
  // No /user route: every GitHub job fails. The scheduler must still advance them.
  const ctx = ctxWith([{ match: "never-matches", json: {} }]);
  const first = await runDueJobs(ctx);
  assert.deepEqual(first.map((r) => r.name).sort(), ["chat:agenda", "chat:daily", "digest:daily", "index:vault", "poll:github", "poll:gmail", "poll:involvement", "reminders:reconcile", "rollover:tasks", "sweep:reminders", "sync:manual"]);
  // GitHub jobs fail; gmail (disabled) and the reminder sweep (nothing due) are legitimate no-ops.
  const status = Object.fromEntries(first.map((r) => [r.name, r.status]));
  assert.deepEqual(status, { "chat:agenda": "ok", "chat:daily": "ok", "digest:daily": "error", "index:vault": "ok", "poll:github": "error", "poll:gmail": "ok", "poll:involvement": "error", "reminders:reconcile": "ok", "rollover:tasks": "ok", "sweep:reminders": "ok", "sync:manual": "ok" });
  const poll = await ctx.store.getJob("poll:github");
  assert.equal(poll!.lastStatus, "error");
  assert.ok(poll!.nextRunAt > ctx.clock.now().toISOString());
  assert.deepEqual(await runDueJobs(ctx), []); // nothing due on the next tick

  // A later tick picks the interval job back up.
  const later = ctxWith([{ match: "never-matches", json: {} }], {
    store: ctx.store,
    clock: new FixedClock("2026-09-20T06:00:00Z", "Asia/Kolkata"),
  });
  assert.deepEqual((await runDueJobs(later)).map((r) => r.name).sort(), ["index:vault", "poll:github", "poll:gmail", "poll:involvement", "reminders:reconcile", "sweep:reminders", "sync:manual"]); // interval jobs only; the daily ones are not due again
});

test("sync:manual ingests manual notes without Gmail, honours done, and retires deleted notes", async () => {
  const vault = new MemoryVault({
    "Deadlines/manual/rent.md": "---\ntype: deadline\ndue: 2026-09-25T18:00:00+05:30\ntitle: Pay rent\n---\n",
    "Deadlines/manual/old.md": "---\ndue: 2026-09-26\nstatus: done\n---\n",
  });
  const ctx = ctxWith([], { vault });
  assert.match(await dispatch("sync:manual", ctx), /manual=2/);
  const byId = async () => Object.fromEntries((await ctx.store.listDeadlines()).map((d) => [d.id, d.status]));
  assert.deepEqual(await byId(), { "manual:Deadlines/manual/rent.md": "open", "manual:Deadlines/manual/old.md": "done" });

  vault.files.delete("Deadlines/manual/rent.md"); // human deletes the note
  assert.match(await dispatch("sync:manual", ctx), /manual=1 staled=1/);
  assert.equal((await byId())["manual:Deadlines/manual/rent.md"], "stale");
});

test("runDueJobs stops starting jobs once the tick's request budget is spent; the rest stay due", async () => {
  const ctx = ctxWith([{ match: "never-matches", json: {} }], { requestCount: () => 999 });
  const first = await runDueJobs(ctx);
  assert.equal(first.length, 1); // the first job always runs...
  const ran = first[0]!.name;
  const next = await runDueJobs(ctxWith([{ match: "never-matches", json: {} }], { store: ctx.store, requestCount: () => 999 }));
  assert.equal(next.length, 1); // ...and the others were left due, not skipped or rescheduled
  assert.notEqual(next[0]!.name, ran);
});

test("the vault repo is never tracked (writing to it would change its own note: a commit-per-poll loop)", async () => {
  const ctx = ctxWith(
    [
      { match: "/user/repos", json: [repo("me/a"), repo("me/vault")] },
      { match: "/search/issues", json: { items: [] } },
      { match: "/issues?state=open", json: [] },
      { match: "/milestones", json: [] },
      { match: "/user", json: { login: "me" } },
    ],
    { env: (n) => (n === "VAULT_REPO" ? "Me/Vault" : undefined) }, // case-insensitive, like GitHub
  );
  assert.match(await dispatch("poll:github", ctx), /repos=1/);
  const files = [...(ctx.vault as MemoryVault).files.keys()];
  assert.ok(files.includes("GitHub/repos/me__a.md"));
  assert.ok(!files.some((p) => p.includes("vault")));
});

test("a repo the list says has no open issues skips the issues call but still fetches milestones", async () => {
  const f = fakeFetch([
    { match: "/user/repos", json: [{ ...repo("me/quiet"), open_issues_count: 0 }, { ...repo("me/busy"), open_issues_count: 3 }] },
    { match: "/search/issues", json: { items: [] } },
    { match: "/issues?state=open", json: [] },
    { match: "/milestones", json: [] },
    { match: "/user", json: { login: "me" } },
  ]);
  await dispatch("poll:github", testContext({ fetch: f, vault: new MemoryVault() }));
  const urls = f.calls.map((c) => c.url);
  assert.ok(!urls.some((u) => u.includes("/repos/me/quiet/issues")));
  assert.ok(urls.some((u) => u.includes("/repos/me/busy/issues")));
  assert.ok(urls.some((u) => u.includes("/repos/me/quiet/milestones"))); // a dated milestone with nothing attached is still a deadline
});

test("nextRunAt aligns interval jobs to the minute, never to completion time (PLAN_V3 A.5)", () => {
  const every1 = { everyMinutes: 1 };
  assert.equal(nextRunAt(every1, new Date("2026-09-21T09:34:04Z"), "Asia/Kolkata").toISOString(), "2026-09-21T09:35:00.000Z");
  assert.equal(nextRunAt(every1, new Date("2026-09-21T09:35:00Z"), "Asia/Kolkata").toISOString(), "2026-09-21T09:36:00.000Z");
  assert.equal(nextRunAt(every1, new Date("2026-09-21T09:35:59.999Z"), "Asia/Kolkata").toISOString(), "2026-09-21T09:36:00.000Z");
  assert.equal(nextRunAt({ everyMinutes: 60 }, new Date("2026-09-20T04:30:00Z"), "Asia/Kolkata").toISOString(), "2026-09-20T05:30:00.000Z");
});

test("runDueJobs: a job due 09:35:00 runs on the 09:35:00.5 tick and is next due at 09:36:00", async () => {
  const store = testContext().store;
  const tick = (at: string) => ctxWith([{ match: "never-matches", json: {} }], { store, clock: new FixedClock(at, "Asia/Kolkata") });
  await runDueJobs(tick("2026-09-21T09:34:04Z")); // first tick: every job runs once
  assert.equal((await store.getJob("sweep:reminders"))!.nextRunAt, "2026-09-21T09:35:00.000Z");
  const ran = await runDueJobs(tick("2026-09-21T09:35:00.500Z"));
  assert.ok(ran.some((r) => r.name === "sweep:reminders"));
  assert.equal((await store.getJob("sweep:reminders"))!.nextRunAt, "2026-09-21T09:36:00.000Z");
});

test("runDueJobs calls ensureJob only when the registry changes (kv jobs:specHash)", async () => {
  const base = testContext().store;
  let ensured = 0;
  const store = Object.create(base, {
    ensureJob: { value: async (name: string, at: string) => (ensured++, base.ensureJob(name, at)) },
  }) as Store;
  const ctx = () => ctxWith([{ match: "never-matches", json: {} }], { store });
  await runDueJobs(ctx());
  const first = ensured;
  assert.ok(first > 0);
  await runDueJobs(ctx());
  assert.equal(ensured, first); // unchanged registry: no ensureJob on the 2nd tick
  await base.kvSet("jobs:specHash", "stale-registry", "2026-09-20T04:30:00Z");
  await runDueJobs(ctx());
  assert.equal(ensured, first * 2); // a changed registry re-ensures every job
});
