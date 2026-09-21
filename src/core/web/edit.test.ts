import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { FixedClock } from "../clock.ts";
import { testContext } from "../../node/testing/context.ts";
import { fakeFetch, MemoryVault } from "../testing/fakes.ts";
import type { AgentContext, Store } from "../types.ts";
import { handleWeb, type WebEnv } from "./edit.ts";
import { COOKIE_NAME, signSession } from "./session.ts";
import type { HumanVault } from "./vault.ts";

const TOKEN = "correct-horse-battery-staple-XYZ";
const ORIGIN = "https://brain.example.workers.dev";
const AT = "2026-09-21T10:00:00Z";
const blobSha = (s: string): string =>
  createHash("sha1").update(`blob ${Buffer.byteLength(s)}\0`).update(s).digest("hex");

class FakeHumanVault implements HumanVault {
  files = new Map<string, { content: string; sha: string }>();
  saves: { path: string; content: string; baseSha: string | null; message: string }[] = [];
  conflict = false;
  async load(p: string) { return this.files.get(p) ?? null; }
  async save(path: string, content: string, baseSha: string | null, message: string) {
    this.saves.push({ path, content, baseSha, message });
    return this.conflict ? ("conflict" as const) : { sha: "n".repeat(40) };
  }
}

function setup(o: { at?: string; store?: Store; enabled?: boolean; adminToken?: string | undefined; maxBytes?: number; vault?: MemoryVault } = {}) {
  const hv = new FakeHumanVault();
  const clock = new FixedClock(o.at ?? AT, "UTC");
  const ctx: AgentContext = testContext({ clock, store: o.store, vault: o.vault });
  const env: WebEnv = {
    adminToken: "adminToken" in o ? o.adminToken : TOKEN,
    enabled: o.enabled ?? true,
    maxBytes: o.maxBytes,
    humanVault: hv,
  };
  const nowSec = Math.floor(clock.now().getTime() / 1000);
  const login = async () => {
    const s = await signSession(TOKEN, nowSec, 3600);
    return { cookie: `${COOKIE_NAME}=${s.cookie}`, csrf: s.csrf };
  };
  const call = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
    handleWeb(new Request(ORIGIN + path, init), ctx, env);
  const post = (path: string, fields: Record<string, string>, headers: Record<string, string> = {}) =>
    call(path, {
      method: "POST",
      body: new URLSearchParams(fields).toString(),
      headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, ...headers },
    });
  return { hv, ctx, env, login, call, post };
}

const goodSave = (csrf: string, extra: Record<string, string> = {}) => ({
  csrf, path: "Notes/a.md", sha: "", content: "hello", ...extra,
});

/* ------------------------------------------------------------ PLAN 29 */

test("PLAN 29: no cookie => GET 303, POST 401, save never called", async () => {
  const t = setup();
  for (const p of ["/edit", "/edit/file?path=Notes/a.md"]) {
    const r = (await t.call(p))!;
    assert.equal(r.status, 303);
    assert.equal(r.headers.get("location"), "/login");
  }
  assert.equal((await t.post("/edit/save", goodSave("x")))!.status, 401);
  assert.equal(t.hv.saves.length, 0);
});

test("PLAN 29: agent-owned paths => 403, no save; valid edit saves exactly once with loaded sha", async () => {
  const t = setup();
  const { cookie, csrf } = await t.login();
  for (const path of ["Tasks/index.md", "Digests/x.md"]) {
    assert.equal((await t.post("/edit/save", goodSave(csrf, { path }), { cookie }))!.status, 403);
    assert.equal((await t.call(`/edit/file?path=${encodeURIComponent(path)}`, { headers: { cookie } }))!.status, 403);
  }
  assert.equal(t.hv.saves.length, 0);
  t.hv.files.set("Notes/a.md", { content: "old\n", sha: blobSha("old\n") });
  const page = await (await t.call("/edit/file?path=Notes/a.md", { headers: { cookie } }))!.text();
  assert.ok(page.includes(`value="${blobSha("old\n")}"`));
  const r = (await t.post("/edit/save", goodSave(csrf, { sha: blobSha("old\n"), content: "new\r\ntext" }), { cookie }))!;
  assert.equal(r.status, 303);
  assert.equal(r.headers.get("location"), "/edit/file?path=Notes%2Fa.md&saved=1");
  assert.equal(t.hv.saves.length, 1);
  assert.deepEqual(t.hv.saves[0], { path: "Notes/a.md", content: "new\ntext", baseSha: blobSha("old\n"), message: "web edit: Notes/a.md" });
});

/* ------------------------------------------------------------ XSS */

test("XSS: content and path never appear unescaped; CSP on every page", async () => {
  const t = setup();
  const { cookie, csrf } = await t.login();
  const evil = `</textarea><script>alert(1)</script>"><img onerror=1>`;
  t.hv.files.set("Notes/a.md", { content: evil, sha: "a".repeat(40) });
  const responses = [
    (await t.call("/edit/file?path=Notes/a.md", { headers: { cookie } }))!,
    (await t.call(`/edit/file?path=${encodeURIComponent(evil)}`, { headers: { cookie } }))!,
    (await t.post("/edit/save", goodSave(csrf, { path: evil }), { cookie }))!,
    (await t.call("/login"))!,
  ];
  t.hv.conflict = true;
  responses.push((await t.post("/edit/save", goodSave(csrf, { sha: "b".repeat(40), content: evil }), { cookie }))!);
  for (const r of responses) {
    const h = await r.text();
    assert.ok(!h.includes("<script>alert") && !h.includes("<img onerror") && !h.includes('"><img'), h);
    assert.match(r.headers.get("content-security-policy")!, /default-src 'none'.*frame-ancestors 'none'/);
  }
  const list = setup({ vault: new MemoryVault({ "Notes/<b>x</b>.md": "", "Notes/ok.md": "" }) });
  const l = await (await list.call("/edit", { headers: { cookie: (await list.login()).cookie } }))!.text();
  assert.ok(!l.includes("<b>") && l.includes("Notes/ok.md") && l.includes("path=Notes%2Fok.md"));
});

/* ------------------------------------------------------------ CSRF */

test("CSRF: missing/wrong token, foreign Origin, cross-site fetch metadata => 403, no write", async () => {
  const t = setup();
  const { cookie, csrf } = await t.login();
  const fields = goodSave(csrf);
  const { csrf: _omit, ...noCsrf } = fields;
  void _omit;
  assert.equal((await t.post("/edit/save", noCsrf, { cookie }))!.status, 403);
  assert.equal((await t.post("/edit/save", { ...fields, csrf: "0".repeat(64) }, { cookie }))!.status, 403);
  assert.equal((await t.post("/edit/save", fields, { cookie, origin: "https://evil.example" }))!.status, 403);
  assert.equal((await t.post("/edit/save", fields, { cookie, origin: "null" }))!.status, 403);
  const noOrigin = (h: Record<string, string>) =>
    t.call("/edit/save", { method: "POST", body: new URLSearchParams(fields).toString(), headers: { cookie, "content-type": "application/x-www-form-urlencoded", ...h } });
  assert.equal((await noOrigin({ "sec-fetch-site": "cross-site" }))!.status, 403);
  assert.equal((await noOrigin({}))!.status, 403);
  assert.equal(t.hv.saves.length, 0);
  assert.equal((await noOrigin({ "sec-fetch-site": "same-origin" }))!.status, 303);
  assert.equal(t.hv.saves.length, 1);
});

test("CSRF: logout needs session+csrf+origin; without a session it just redirects", async () => {
  const t = setup();
  const { cookie, csrf } = await t.login();
  assert.equal((await t.post("/logout", {}, { cookie }))!.status, 403);
  assert.equal((await t.post("/logout", { csrf }, { cookie, origin: "https://evil.example" }))!.status, 403);
  const ok = (await t.post("/logout", { csrf }, { cookie }))!;
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.get("location"), "/login");
  assert.match(ok.headers.get("set-cookie")!, /Max-Age=0/);
  assert.equal((await t.post("/logout", {}))!.status, 303);
});

/* ------------------------------------------------------------ cookie */

test("cookie: tampered, expired and wrong-secret cookies are not sessions; flags present; token never leaks", async () => {
  const t = setup();
  const { cookie } = await t.login();
  const tampered = cookie.slice(0, -1) + (cookie.endsWith("0") ? "1" : "0");
  assert.equal((await t.call("/edit", { headers: { cookie: tampered } }))!.status, 303);
  const other = await signSession("different-secret", Math.floor(Date.parse(AT) / 1000), 3600);
  assert.equal((await t.call("/edit", { headers: { cookie: `${COOKIE_NAME}=${other.cookie}` } }))!.status, 303);
  const later = setup({ at: "2026-09-21T12:00:01Z" });
  assert.equal((await later.call("/edit", { headers: { cookie } }))!.status, 303);
  assert.equal((await t.call("/edit", { headers: { cookie } }))!.status, 200);

  const r = (await t.post("/login", { password: TOKEN }))!;
  const sc = r.headers.get("set-cookie")!;
  for (const f of ["__Host-brain_sess=", "HttpOnly", "Secure", "SameSite=Strict", "Path=/", "Max-Age=3600"]) assert.ok(sc.includes(f), f);
  const bad = (await t.post("/login", { password: TOKEN + "x" }))!;
  for (const res of [r, bad, (await t.call("/login"))!]) {
    assert.ok(!(await res.text()).includes(TOKEN));
    for (const [, v] of res.headers) assert.ok(!v.includes(TOKEN));
    assert.ok(!(res.headers.get("location") ?? "").includes("password"));
  }
});

/* ------------------------------------------------------------ login */

test("login: wrong 401, right 303 + cookie to /edit", async () => {
  const t = setup();
  assert.equal((await t.post("/login", { password: "nope" }))!.status, 401);
  const r = (await t.post("/login", { password: TOKEN }))!;
  assert.equal(r.status, 303);
  assert.equal(r.headers.get("location"), "/edit");
  assert.equal((await t.post("/login", { password: TOKEN }, { origin: "https://evil.example" }))!.status, 403);
  const big = await t.call("/login", { method: "POST", body: "password=" + "a".repeat(3000), headers: { origin: ORIGIN } });
  assert.equal(big!.status, 413);
});

test("login: sixth attempt 429 even with the right token; next window OK; D1 usage per table", async () => {
  const t = setup();
  for (let i = 0; i < 5; i++) assert.equal((await t.post("/login", { password: "bad" + i }))!.status, 401);
  const r = (await t.post("/login", { password: TOKEN }))!;
  assert.equal(r.status, 429);
  assert.ok(Number(r.headers.get("retry-after")) > 0);
  assert.equal(await t.ctx.store.kvGet("web:rl:" + Math.floor(Date.parse(AT) / 1000 / 900)), "5");
  const next = setup({ at: "2026-09-21T10:15:00Z", store: t.ctx.store });
  assert.equal((await next.post("/login", { password: TOKEN }))!.status, 303);

  let gets = 0, sets = 0;
  const base = setup().ctx.store;
  const counting = Object.create(base, {
    kvGet: { value: (k: string) => (gets++, base.kvGet(k)) },
    kvSet: { value: (k: string, v: string, a: string) => (sets++, base.kvSet(k, v, a)) },
  }) as Store;
  const c = setup({ store: counting });
  await c.post("/login", { password: TOKEN });
  assert.deepEqual([gets, sets], [1, 0]);
  await c.post("/login", { password: "bad" });
  assert.deepEqual([gets, sets], [2, 1]);
});

test("login: kvGet throwing => 503", async () => {
  const base = setup().ctx.store;
  const broken = Object.create(base, { kvGet: { value: async () => { throw new Error("d1 down"); } } }) as Store;
  assert.equal((await setup({ store: broken }).post("/login", { password: TOKEN }))!.status, 503);
});

/* ------------------------------------------------------------ conflict, size, unchanged */

test("conflict: 409 page keeps the user's text and offers a reload link", async () => {
  const t = setup();
  const { cookie, csrf } = await t.login();
  t.hv.conflict = true;
  const r = (await t.post("/edit/save", goodSave(csrf, { sha: "c".repeat(40), content: "my precious edit" }), { cookie }))!;
  assert.equal(r.status, 409);
  const h = await r.text();
  assert.ok(h.includes("my precious edit") && h.includes("/edit/file?path=Notes%2Fa.md"));
});

test("size: oversize 413, NUL 400, CRLF normalised, unchanged => 303 with no write", async () => {
  const t = setup({ maxBytes: 100 });
  const { cookie, csrf } = await t.login();
  assert.equal((await t.post("/edit/save", goodSave(csrf, { content: "x".repeat(101) }), { cookie }))!.status, 413);
  assert.equal((await t.post("/edit/save", goodSave(csrf, { content: "x".repeat(20_000) }), { cookie }))!.status, 413);
  assert.equal((await t.post("/edit/save", goodSave(csrf, { content: "a\0b" }), { cookie }))!.status, 400);
  assert.equal((await t.post("/edit/save", goodSave(csrf, { sha: "zz" }), { cookie }))!.status, 400);
  assert.equal(t.hv.saves.length, 0);
  assert.equal((await t.post("/edit/save", goodSave(csrf, { content: "x".repeat(100) }), { cookie }))!.status, 303);
  await t.post("/edit/save", goodSave(csrf, { content: "a\r\nb\r\n" }), { cookie });
  assert.equal(t.hv.saves.at(-1)!.content, "a\nb\n");
  assert.equal(t.hv.saves.at(-1)!.baseSha, null);
  const n = t.hv.saves.length;
  const r = (await t.post("/edit/save", goodSave(csrf, { sha: blobSha("a\nb\n"), content: "a\r\nb\r\n" }), { cookie }))!;
  assert.equal(r.status, 303);
  assert.equal(t.hv.saves.length, n);
});

/* ------------------------------------------------------------ kill switch / methods */

test("kill switch: disabled or no adminToken => null for every web path; other paths always null", async () => {
  for (const o of [{ enabled: false }, { adminToken: undefined }, { adminToken: "" }]) {
    const t = setup(o);
    for (const p of ["/login", "/logout", "/edit", "/edit/file?path=Notes/a.md", "/edit/save"]) {
      assert.equal(await t.call(p), null, p);
      assert.equal(await t.post(p, {}), null, p);
    }
  }
  const t = setup();
  for (const p of ["/health", "/wh/tg/x", "/edit/", "/edit/other", "/admin/run", "/"]) assert.equal(await t.call(p), null, p);
});

test("wrong methods => 405 with allow", async () => {
  const t = setup();
  const { cookie } = await t.login();
  const m = async (path: string, method: string) => (await t.call(path, { method, headers: { cookie } }))!;
  for (const [p, method, allow] of [
    ["/logout", "GET", "POST"], ["/edit/save", "GET", "POST"], ["/edit", "POST", "GET"],
    ["/edit/file", "DELETE", "GET"], ["/login", "PUT", "GET, POST"],
  ] as const) {
    const r = await m(p, method);
    assert.equal(r.status, 405, `${method} ${p}`);
    assert.equal(r.headers.get("allow"), allow);
  }
});

/* ------------------------------------------------------------ list + subrequests */

test("GET /edit lists only editable human files (max 300) with 0 D1 and no login state leaked", async () => {
  const seed: Record<string, string> = { "Tasks/index.md": "", "Digests/d.md": "", ".obsidian/x.md": "", "Plans/Proposed/p.md": "", "Notes/a.txt": "" };
  for (let i = 0; i < 350; i++) seed[`Notes/n${String(i).padStart(3, "0")}.md`] = "";
  seed["Daily/2026-09-21.md"] = "";
  const t = setup({ vault: new MemoryVault(seed) });
  const { cookie } = await t.login();
  const h = await (await t.call("/edit", { headers: { cookie } }))!.text();
  assert.ok(h.includes("Daily%2F2026-09-21.md"));
  assert.ok(!h.includes("Tasks") && !h.includes("Digests") && !h.includes("obsidian") && !h.includes("Proposed") && !h.includes("a.txt"));
  assert.equal((h.match(/<li><a /g) ?? []).length, 300);
  assert.ok(h.includes('action="/edit/file"'));
});

test("integration: real HumanVault through fake fetch uses exactly 1 fetch per file view and per save", async () => {
  const f = fakeFetch([
    { match: "/contents/Notes/a.md?ref=main", json: { encoding: "base64", content: btoa("hi"), sha: blobSha("hi") } },
    { match: "/contents/Notes/a.md", json: { content: { sha: "s2" } } },
  ]);
  const clock = new FixedClock(AT, "UTC");
  const ctx = testContext({ clock, fetch: f, env: (n) => ({ VAULT_REPO: "me/vault", GITHUB_TOKEN_VAULT: "tok" })[n] });
  const env: WebEnv = { adminToken: TOKEN, enabled: true };
  const s = await signSession(TOKEN, Math.floor(clock.now().getTime() / 1000), 3600);
  const cookie = `${COOKIE_NAME}=${s.cookie}`;
  const v = await handleWeb(new Request(`${ORIGIN}/edit/file?path=Notes/a.md`, { headers: { cookie } }), ctx, env);
  assert.equal(v!.status, 200);
  assert.equal(f.calls.length, 1);
  const r = await handleWeb(new Request(`${ORIGIN}/edit/save`, {
    method: "POST", headers: { cookie, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf: s.csrf, path: "Notes/a.md", sha: blobSha("hi"), content: "ho" }).toString(),
  }), ctx, env);
  assert.equal(r!.status, 303);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1]!.method, "PUT");
});

test("internal errors give a generic 500 without detail", async () => {
  const t = setup();
  const { cookie } = await t.login();
  t.hv.load = async () => { throw new Error("secret detail tok-123"); };
  const r = (await t.call("/edit/file?path=Notes/a.md", { headers: { cookie } }))!;
  assert.equal(r.status, 500);
  assert.ok(!(await r.text()).includes("tok-123"));
});
