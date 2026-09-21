import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { fakeFetch, type FakeRoute } from "../testing/fakes.ts";
import { GitDataApiWriter } from "./gitDataApi.ts";

const blobSha = (s: string): string =>
  createHash("sha1").update(`blob ${Buffer.byteLength(s)}\0`).update(s).digest("hex");

const R = "https://api.github.com/repos/me/vault";
const refRoute = (sha: string, times?: number): FakeRoute => ({
  match: `${R}/git/ref/heads/main`, json: { object: { sha } }, times,
});
const commitRoute = (sha: string, tree: string, times?: number): FakeRoute => ({
  match: `${R}/git/commits/${sha}`, json: { tree: { sha: tree } }, times,
});
const treeRoute = (tree: string, entries: { path: string; sha: string }[], times?: number): FakeRoute => ({
  match: `${R}/git/trees/${tree}?recursive=1`,
  json: { tree: entries.map((e) => ({ ...e, type: "blob" })) },
  times,
});

const mk = (f: ReturnType<typeof fakeFetch>) =>
  new GitDataApiWriter({ repo: "me/vault", branch: "main", token: "tok-secret", fetch: f });

test("a non-allowlisted path rejects the whole batch with zero fetches", async () => {
  const f = fakeFetch([]);
  await assert.rejects(
    mk(f).writeFiles("m", [
      { path: "Digests/ok.md", content: "x" },
      { path: "Daily/x.md", content: "y" },
    ]),
    /not agent-owned/,
  );
  assert.equal(f.calls.length, 0);
});

test("happy path: ref -> commit -> tree -> tree(inline content) -> commit -> PATCH, returns changed paths", async () => {
  const f = fakeFetch([
    refRoute("c1"),
    commitRoute("c1", "t1"),
    treeRoute("t1", [{ path: "Digests/old.md", sha: blobSha("old") }]),
    { match: `${R}/git/trees`, json: { sha: "t2" } },
    { match: `${R}/git/commits`, json: { sha: "c2" } },
    { match: `${R}/git/refs/heads/main`, json: {} },
  ]);
  const changed = await mk(f).writeFiles("msg", [
    { path: "Digests/new.md", content: "héllo" },
    { path: "Digests/old.md", content: "old" },
  ]);
  assert.deepEqual(changed, ["Digests/new.md"]);
  assert.deepEqual(
    f.calls.map((c) => `${c.method} ${c.url.replace(R, "")}`),
    [
      "GET /git/ref/heads/main",
      "GET /git/commits/c1",
      "GET /git/trees/t1?recursive=1",
      "POST /git/trees",
      "POST /git/commits",
      "PATCH /git/refs/heads/main",
    ],
  );
  const patch = JSON.parse(f.calls[5]!.body!);
  assert.deepEqual(patch, { sha: "c2", force: false });
  const treeBody = JSON.parse(f.calls[3]!.body!);
  assert.equal(treeBody.base_tree, "t1");
  assert.deepEqual(treeBody.tree, [{ path: "Digests/new.md", mode: "100644", type: "blob", content: "héllo" }]); // inline, never a separate blob
  assert.equal(JSON.parse(f.calls[4]!.body!).parents[0], "c1");
  const h = f.calls[0]!.headers;
  assert.equal(h["accept"], "application/vnd.github+json");
  assert.equal(h["x-github-api-version"], "2022-11-28");
  assert.ok(h["user-agent"]);
});

test("a 422 on the ref update re-reads the ref and retries exactly once", async () => {
  const f = fakeFetch([
    refRoute("c1", 1),
    refRoute("c9"),
    commitRoute("c1", "t1"),
    commitRoute("c9", "t9"),
    treeRoute("t1", [], 1),
    treeRoute("t9", []),
    { match: `${R}/git/trees`, json: { sha: "t2" } },
    { match: `${R}/git/commits`, json: { sha: "c2" } },
    { match: `${R}/git/refs/heads/main`, status: 422, json: { message: "not a fast forward" }, times: 1 },
    { match: `${R}/git/refs/heads/main`, json: {} },
  ]);
  const changed = await mk(f).writeFiles("m", [{ path: "Inbox/a.md", content: "a" }]);
  assert.deepEqual(changed, ["Inbox/a.md"]);
  assert.equal(f.calls.filter((c) => c.method === "PATCH").length, 2);
  assert.equal(f.calls.filter((c) => c.url.endsWith("/git/ref/heads/main")).length, 2);
  assert.equal(f.calls.filter((c) => c.url.endsWith("/git/blobs")).length, 0);
  assert.equal(JSON.parse(f.calls.filter((c) => c.method === "POST" && c.url.endsWith("/git/commits")).at(-1)!.body!).parents[0], "c9");
});

test("a second 422 throws a clear error and leaks no token", async () => {
  const f = fakeFetch([
    refRoute("c1"),
    commitRoute("c1", "t1"),
    treeRoute("t1", []),
    { match: `${R}/git/trees`, json: { sha: "t2" } },
    { match: `${R}/git/commits`, json: { sha: "c2" } },
    { match: `${R}/git/refs/heads/main`, status: 422, json: {} },
  ]);
  await assert.rejects(mk(f).writeFiles("m", [{ path: "Inbox/a.md", content: "a" }]), (e: Error) => {
    assert.match(e.message, /kept moving/);
    assert.ok(!e.message.includes("tok-secret"));
    return true;
  });
  assert.equal(f.calls.filter((c) => c.method === "PATCH").length, 2);
});

test("an unchanged batch creates no blob and no commit", async () => {
  const f = fakeFetch([
    refRoute("c1"),
    commitRoute("c1", "t1"),
    treeRoute("t1", [{ path: "Inbox/a.md", sha: blobSha("same") }]),
  ]);
  assert.deepEqual(await mk(f).writeFiles("m", [{ path: "Inbox/a.md", content: "same" }]), []);
  assert.ok(f.calls.every((c) => c.method === "GET"));
  assert.equal(f.calls.length, 3);
});

test("readFile returns null on 404; listFiles is sorted, prefix-filtered and skips dot-dirs", async () => {
  const f = fakeFetch([
    { match: `${R}/contents/Notes/gone.md`, status: 404, json: { message: "Not Found" } },
    { match: `${R}/contents/Notes/a%20b.md`, text: "body" },
    refRoute("c1"),
    commitRoute("c1", "t1"),
    treeRoute("t1", [
      { path: "Notes/z.md", sha: "1" },
      { path: "Notes/a.md", sha: "2" },
      { path: ".obsidian/app.json", sha: "3" },
      { path: "Other/x.md", sha: "4" },
    ]),
  ]);
  const w = mk(f);
  assert.equal(await w.readFile("Notes/gone.md"), null);
  assert.equal(await w.readFile("Notes/a b.md"), "body");
  assert.deepEqual(await w.listFiles("Notes/"), ["Notes/a.md", "Notes/z.md"]);
  await assert.rejects(w.readFile("../etc/passwd"), /unsafe/);
});

test("a commit costs a fixed 6 subrequests however many files change (Worker free-plan budget)", async () => {
  const f = fakeFetch([
    refRoute("c1"),
    commitRoute("c1", "t1"),
    treeRoute("t1", []),
    { match: `${R}/git/trees`, json: { sha: "t2" } },
    { match: `${R}/git/commits`, json: { sha: "c2" } },
    { match: `${R}/git/refs/heads/main`, json: {} },
  ]);
  const files = Array.from({ length: 40 }, (_, i) => ({ path: `GitHub/repos/r${i}.md`, content: `note ${i}` }));
  assert.equal((await mk(f).writeFiles("m", files)).length, 40);
  assert.equal(f.calls.length, 6);
});
