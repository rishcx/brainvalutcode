import assert from "node:assert/strict";
import { test } from "node:test";
import { testContext } from "../../node/testing/context.ts";
import { fakeFetch } from "../testing/fakes.ts";
import { createHumanVault, fromBase64, toBase64 } from "./vault.ts";

const ENV: Record<string, string> = { VAULT_REPO: "me/vault", GITHUB_TOKEN_VAULT: "tok-secret-1" };
const mk = (f: ReturnType<typeof fakeFetch>, env = ENV) =>
  createHumanVault(testContext({ fetch: f, env: (n) => env[n] }));
const U = "https://api.github.com/repos/me/vault/contents/Notes/a%20b.md";

test("base64 round-trips UTF-8", () => {
  const s = "héllo 🌍\n" + "x".repeat(100_000);
  assert.equal(fromBase64(toBase64(s)), s);
});

test("load: decodes, returns blob sha, 1 fetch; 404 => null", async () => {
  const f = fakeFetch([
    { match: `${U}?ref=main`, json: { type: "file", encoding: "base64", content: toBase64("héllo\n").replace(/(.{4})/g, "$1\n"), sha: "abc" }, times: 1 },
    { match: U, status: 404, json: {} },
  ]);
  const v = mk(f);
  assert.deepEqual(await v.load("Notes/a b.md"), { content: "héllo\n", sha: "abc" });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]!.headers.authorization, "Bearer tok-secret-1");
  assert.equal(await v.load("Notes/a b.md"), null);
});

test("save: PUT with sha; create-only sends no sha; 409/422 => conflict; 1 fetch each", async () => {
  const f = fakeFetch([{ match: U, json: { content: { sha: "new" } }, times: 2 }, { match: U, status: 409, times: 1 }, { match: U, status: 422, times: 1 }]);
  const v = mk(f, { ...ENV, VAULT_BRANCH: "dev" });
  assert.deepEqual(await v.save("Notes/a b.md", "x", "old", "m"), { sha: "new" });
  assert.deepEqual(await v.save("Notes/a b.md", "x", null, "m"), { sha: "new" });
  assert.equal(await v.save("Notes/a b.md", "x", "old", "m"), "conflict");
  assert.equal(await v.save("Notes/a b.md", "x", null, "m"), "conflict");
  const b = f.calls.map((c) => JSON.parse(c.body!));
  assert.equal(b[0].sha, "old");
  assert.ok(!("sha" in b[1]));
  assert.equal(b[0].branch, "dev");
  assert.equal(b[0].content, toBase64("x"));
  assert.ok(f.calls.every((c) => c.method === "PUT"));
});

test("non-2xx throws without body or token; GITHUB_TOKEN fallback; bad repo/path/no token refused", async () => {
  const f = fakeFetch([{ match: U, status: 500, text: "boom tok-secret-1" }]);
  await assert.rejects(mk(f).save("Notes/a b.md", "x", null, "m"), (e: Error) => {
    assert.equal(e.message, "GitHub API 500 on save");
    return true;
  });
  await assert.rejects(mk(f).load("Notes/a b.md"), /GitHub API 500 on load/);
  const g = fakeFetch([{ match: U, status: 404 }]);
  await mk(g, { VAULT_REPO: "me/vault", GITHUB_TOKEN: "fallback" }).load("Notes/a b.md");
  assert.equal(g.calls[0]!.headers.authorization, "Bearer fallback");
  await assert.rejects(mk(g, { VAULT_REPO: "bad repo", GITHUB_TOKEN: "t" }).load("Notes/a b.md"), /VAULT_REPO/);
  await assert.rejects(mk(g, { VAULT_REPO: "me/vault" }).load("Notes/a b.md"), /token not configured/);
  await assert.rejects(mk(g).load("Tasks/index.md"), /not editable/);
  await assert.rejects(mk(g).save("Digests/x.md", "x", null, "m"), /not editable/);
});
