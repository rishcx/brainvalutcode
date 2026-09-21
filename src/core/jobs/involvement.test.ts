import assert from "node:assert/strict";
import { test } from "node:test";
import { testContext } from "../../node/testing/context.ts";
import { INVOLVEMENT_NOTE_PATH } from "../render/involvement.ts";
import { INVOLVEMENT_KV, LOGIN_KV, MAX_FETCHES } from "../sources/involvement.ts";
import { fakeFetch, MemoryVault, type FakeRoute } from "../testing/fakes.ts";
import { pollInvolvement } from "./involvement.ts";

const node = (repo: string, n: number, title = `t${n}`) => ({
  number: n, title, url: "x", updatedAt: "2026-09-10T00:00:00Z", state: "OPEN", repository: { nameWithOwner: repo },
});
const data = (over: Record<string, unknown> = {}) => ({
  viewer: { login: "me", repositoriesContributedTo: { nodes: [{ nameWithOwner: "a/b", isPrivate: false, pushedAt: "2026-09-10T00:00:00Z" }] } },
  assigned: { issueCount: 1, nodes: [node("o/r", 1, "assigned one")] },
  myPRs: { issueCount: 1, nodes: [node("o/r", 2)] },
  reviews: { issueCount: 1, nodes: [node("o/r", 3, "review me")] },
  mentions: { issueCount: 0, nodes: [] },
  ...over,
});
const login: FakeRoute = { match: "/graphql", times: 1, json: { data: { viewer: { login: "me" } } } };
const ok = (over: Record<string, unknown> = {}): FakeRoute => ({ match: "/graphql", json: { data: data(over) } });

test("budget guard: at most 2 fetches with a MemoryVault; source cap plus commit fits the tick", async () => {
  const f = fakeFetch([login, ok()]);
  const ctx = testContext({ fetch: f, vault: new MemoryVault() });
  const out = await pollInvolvement.run(ctx);
  assert.ok(f.calls.length <= 2);
  assert.ok(MAX_FETCHES + 6 <= 25);
  assert.match(out, /^login=me review=1 assigned=1 prs=1 mentions=0 repos=1 partial=0 changed=1$/);
  assert.doesNotMatch(out, /review me|test-token/);
  assert.match((ctx.vault as MemoryVault).files.get(INVOLVEMENT_NOTE_PATH)!, /review me/);
  assert.equal(await ctx.store.kvGet(LOGIN_KV), "me");
});

test("a partial bucket still writes the note and keeps the old lines", async () => {
  const vault = new MemoryVault();
  const first = testContext({ fetch: fakeFetch([ok()]), vault });
  await first.store.kvSet(LOGIN_KV, "me", "2026-09-20T00:00:00Z");
  await pollInvolvement.run(first);
  const second = testContext({ fetch: fakeFetch([{ match: "/graphql", json: { data: data({ reviews: null, assigned: { issueCount: 2, nodes: [node("o/r", 1, "assigned one"), node("o/r", 7, "new")] } }), errors: [{}] } }]), vault, store: first.store });
  const out = await pollInvolvement.run(second);
  assert.match(out, /partial=1/);
  const note = vault.files.get(INVOLVEMENT_NOTE_PATH)!;
  assert.match(note, /partial: \[reviewRequests\]/);
  assert.match(note, /review me/);
  assert.match(note, /new/);
});

test("a rate-limit throw leaves vault and both kv keys unchanged", async () => {
  const vault = new MemoryVault();
  const good = testContext({ fetch: fakeFetch([login, ok()]), vault });
  await pollInvolvement.run(good);
  const before = { note: vault.files.get(INVOLVEMENT_NOTE_PATH), a: await good.store.kvGet(INVOLVEMENT_KV), b: await good.store.kvGet(LOGIN_KV), commits: vault.commits.length };
  const bad = testContext({ fetch: fakeFetch([{ match: "/graphql", status: 429, headers: { "x-ratelimit-remaining": "0" }, text: "" }]), vault, store: good.store });
  await assert.rejects(pollInvolvement.run(bad), /rate limit/);
  assert.equal(vault.files.get(INVOLVEMENT_NOTE_PATH), before.note);
  assert.equal(await good.store.kvGet(INVOLVEMENT_KV), before.a);
  assert.equal(await good.store.kvGet(LOGIN_KV), before.b);
  assert.equal(vault.commits.length, before.commits);
});

test("an identical second run adds no commit", async () => {
  const vault = new MemoryVault();
  const c1 = testContext({ fetch: fakeFetch([login, ok()]), vault });
  await pollInvolvement.run(c1);
  const c2 = testContext({ fetch: fakeFetch([ok()]), vault, store: c1.store, at: "2026-09-21T09:00:00Z" });
  assert.match(await pollInvolvement.run(c2), /changed=0$/);
  assert.equal(vault.commits.length, 1);
});

test("disabled: no fetches, no writes", async () => {
  const f = fakeFetch([]);
  const ctx = testContext({ fetch: f, configPatch: { github: { involvement: { enabled: false } } } });
  assert.equal(await pollInvolvement.run(ctx), "disabled");
  assert.equal(f.calls.length, 0);
  assert.equal(await ctx.store.kvGet(INVOLVEMENT_KV), null);
  assert.equal((ctx.vault as MemoryVault).commits.length, 0);
});

test("login is cached (no viewer call) and VAULT_REPO is excluded", async () => {
  const f = fakeFetch([ok({ assigned: { issueCount: 2, nodes: [node("me/vault", 1), node("o/r", 2)] } })]);
  const ctx = testContext({ fetch: f, env: (k) => (k === "VAULT_REPO" ? "me/vault" : undefined) });
  await ctx.store.kvSet(LOGIN_KV, "me", "2026-09-20T00:00:00Z");
  await pollInvolvement.run(ctx);
  assert.equal(f.calls.length, 1);
  const note = (ctx.vault as MemoryVault).files.get(INVOLVEMENT_NOTE_PATH)!;
  assert.doesNotMatch(note, /me\/vault/);
  assert.match(note, /o\/r #2/);
});
