import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { chainFor, parseConfig } from "./core/config.ts";
import { fakeFetch } from "./core/testing/fakes.ts";
import type {
  D1Database, D1PreparedStatement, D1Result, ExecutionContext, InboundMessage, WebhookAdapter,
} from "./core/types.ts";
import { createWorker } from "./worker.ts";

const MIGRATIONS_DIR = new URL("../migrations/", import.meta.url);
// Every migration in filename order, exactly what production applies.
const SCHEMA = readdirSync(MIGRATIONS_DIR)
  .filter((n) => n.endsWith(".sql"))
  .sort()
  .map((n) => readFileSync(new URL(n, MIGRATIONS_DIR), "utf8"))
  .join("\n");

function fakeD1(): D1Database {
  const sql = new DatabaseSync(":memory:");
  sql.exec(SCHEMA);
  const stmt = (q: string, args: unknown[] = []): D1PreparedStatement => ({
    bind: (...v) => stmt(q, v),
    first: async <T,>() => (sql.prepare(q).get(...(args as never[])) as unknown as T | undefined) ?? null,
    all: async <T,>() => ({ results: sql.prepare(q).all(...(args as never[])) as unknown as T[], success: true }),
    run: async () => {
      const r = sql.prepare(q).run(...(args as never[]));
      return { results: [], success: true, meta: { changes: Number(r.changes) } };
    },
  });
  return {
    prepare: (q) => stmt(q),
    batch: async (ss) => {
      const out: D1Result[] = [];
      for (const s of ss) out.push(await s.run());
      return out;
    },
    exec: async (q) => (sql.exec(q), { count: 1, duration: 0 }),
  };
}

const SECRETS = {
  GITHUB_TOKEN: "ghp_SECRET_TOKEN_VALUE",
  ADMIN_TOKEN: "admin-secret-value",
  TELEGRAM_WEBHOOK_PATH: "hidden-path-123",
  TELEGRAM_WEBHOOK_SECRET: "tg-secret-value",
  WHATSAPP_VERIFY_TOKEN: "wa-verify-value",
};
const mkEnv = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  DB: fakeD1(), VAULT_REPO: "me/vault", VAULT_BRANCH: "main", BRAIN_CONFIG: "{}", ...SECRETS, ...over,
});

function recordingCtx(): ExecutionContext & { promises: Promise<unknown>[] } {
  const promises: Promise<unknown>[] = [];
  return { promises, waitUntil: (p) => void promises.push(p), passThroughOnException: () => {} };
}

/** A webhook adapter whose parse() result and handler completion the test controls. */
function stubAdapter(ok: (req: Request) => boolean): WebhookAdapter {
  return {
    verify: async (req) => ok(req),
    parse: async (): Promise<InboundMessage[]> => [{ channel: "telegram", id: "1", from: "9", text: "status", at: "2026-09-20T00:00:00Z" }],
  };
}

const post = (path: string, headers: Record<string, string> = {}, body = "{}"): Request =>
  new Request(`https://w.example${path}`, { method: "POST", headers, body });

test("GET /health is 200 JSON, leaks no secret; unknown path is 404", async () => {
  const w = createWorker();
  const res = await w.fetch(new Request("https://w.example/health"), mkEnv(), recordingCtx());
  assert.equal(res.status, 200);
  const raw = await res.text();
  const body = JSON.parse(raw);
  assert.equal(body.ok, true);
  assert.equal(body.runtime, "worker");
  assert.deepEqual(body.jobs, []);
  for (const v of Object.values(SECRETS)) assert.ok(!raw.includes(v));
  assert.equal((await w.fetch(new Request("https://w.example/nope"), mkEnv(), recordingCtx())).status, 404);
});

test("POST /wh/tg: wrong path -> 403 and handler never runs; wrong secret header -> 403", async () => {
  let handled = 0;
  const w = createWorker({
    telegram: stubAdapter((r) => r.headers.get("x-telegram-bot-api-secret-token") === SECRETS.TELEGRAM_WEBHOOK_SECRET),
    onInbound: async () => (handled++, null),
  });
  const ectx = recordingCtx();
  const bad = await w.fetch(post("/wh/tg/wrong-path"), mkEnv(), ectx);
  assert.equal(bad.status, 403);
  const badSecret = await w.fetch(
    post(`/wh/tg/${SECRETS.TELEGRAM_WEBHOOK_PATH}`, { "x-telegram-bot-api-secret-token": "nope" }),
    mkEnv(),
    ectx,
  );
  assert.equal(badSecret.status, 403);
  assert.equal(ectx.promises.length, 0);
  assert.equal(handled, 0);
});

test("a verified webhook returns 200 before the handler resolves (work goes to waitUntil)", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let finished = false;
  const w = createWorker({
    telegram: stubAdapter(() => true),
    onInbound: async () => {
      await gate;
      finished = true;
      return null;
    },
  });
  const ectx = recordingCtx();
  const res = await w.fetch(post(`/wh/tg/${SECRETS.TELEGRAM_WEBHOOK_PATH}`), mkEnv(), ectx);
  assert.equal(res.status, 200);
  assert.equal(finished, false);
  assert.equal(ectx.promises.length, 1);
  release();
  await Promise.all(ectx.promises);
  assert.equal(finished, true);
});

test("an inbound reply is sent through the matching channel", async () => {
  const sent: string[] = [];
  const w = createWorker({
    telegram: stubAdapter(() => true),
    onInbound: async () => "pong",
    makeChannels: () => [{ id: "telegram", send: async (t) => void sent.push(t) }],
  });
  const ectx = recordingCtx();
  await w.fetch(post(`/wh/tg/${SECRETS.TELEGRAM_WEBHOOK_PATH}`), mkEnv(), ectx);
  await Promise.all(ectx.promises);
  assert.deepEqual(sent, ["pong"]);
});

test("an absent adapter answers 503, not a crash", async () => {
  const w = createWorker();
  assert.equal((await w.fetch(post(`/wh/tg/${SECRETS.TELEGRAM_WEBHOOK_PATH}`), mkEnv(), recordingCtx())).status, 503);
  assert.equal((await w.fetch(post("/wh/whatsapp"), mkEnv(), recordingCtx())).status, 503);
});

test("GET /wh/whatsapp echoes hub.challenge only for the matching verify token", async () => {
  const w = createWorker();
  const q = (t: string) =>
    new Request(`https://w.example/wh/whatsapp?hub.mode=subscribe&hub.verify_token=${t}&hub.challenge=abc123`);
  const ok = await w.fetch(q(SECRETS.WHATSAPP_VERIFY_TOKEN), mkEnv(), recordingCtx());
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), "abc123");
  assert.equal((await w.fetch(q("wrong"), mkEnv(), recordingCtx())).status, 403);
  assert.equal((await w.fetch(q("x"), mkEnv({ WHATSAPP_VERIFY_TOKEN: undefined }), recordingCtx())).status, 403);
});

test("POST /admin/run without the bearer token runs nothing", async () => {
  const f = fakeFetch([]);
  const w = createWorker({ fetch: f });
  const env = mkEnv();
  for (const headers of [{} as Record<string, string>, { authorization: "Bearer wrong" }]) {
    const res = await w.fetch(post("/admin/run?job=poll:github", headers), env, recordingCtx());
    assert.equal(res.status, 403);
  }
  assert.equal(f.calls.length, 0);
  assert.equal((await w.fetch(new Request("https://w.example/health"), env, recordingCtx()).then((r) => r.json())).jobs.length, 0);
});

test("worker never reaches the local gateway; admin run drives a job end to end", async () => {
  const V = "https://api.github.com/repos/me/vault";
  const f = fakeFetch([
    { match: /api\.github\.com\/user$/, json: { login: "me" } },
    { match: "/user/repos", json: [] },
    { match: "/search/issues", json: { items: [] } },
    { match: `${V}/git/ref/heads/main`, json: { object: { sha: "c1" } } },
    { match: `${V}/git/commits/c1`, json: { tree: { sha: "t1" } } },
    { match: `${V}/git/trees/t1`, json: { tree: [] } },
    { match: `${V}/git/blobs`, json: { sha: "b" } },
    { match: `${V}/git/trees`, json: { sha: "t2" } },
    { match: `${V}/git/commits`, json: { sha: "c2" } },
    { match: `${V}/git/refs/heads/main`, json: {} },
  ]);
  const w = createWorker({ fetch: f });
  const res = await w.fetch(
    post("/admin/run?job=poll:github", { authorization: `Bearer ${SECRETS.ADMIN_TOKEN}` }),
    mkEnv(),
    recordingCtx(),
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(f.calls.length > 5);
  assert.ok(f.calls.every((c) => !c.url.includes("localhost:20128")));
  const chain = chainFor(parseConfig({}), { allowLocalGateway: false });
  assert.ok(chain.every((e) => !e.local && e.name !== "omniroute"));

  const unknown = await w.fetch(
    post("/admin/run?job=nope", { authorization: `Bearer ${SECRETS.ADMIN_TOKEN}` }),
    mkEnv(),
    recordingCtx(),
  );
  assert.equal(unknown.status, 400);
});

test("scheduled() hands the job run to waitUntil and records job rows", async () => {
  const f = fakeFetch([{ match: "api.github.com", status: 500, json: {} }]); // jobs fail; they must still be recorded
  const w = createWorker({ fetch: f });
  const env = mkEnv();
  const ectx = recordingCtx();
  await w.scheduled({ scheduledTime: 0, cron: "*/15 * * * *" }, env, ectx);
  assert.equal(ectx.promises.length, 1);
  await Promise.all(ectx.promises);
  const health = await (await w.fetch(new Request("https://w.example/health"), env, recordingCtx())).json();
  assert.ok(health.jobs.length >= 4);
  const st = Object.fromEntries(health.jobs.map((j: { name: string; lastStatus: string }) => [j.name, j.lastStatus]));
  assert.equal(st["poll:github"], "error"); // GitHub is down; the failure is recorded, not thrown
  assert.equal(st["digest:daily"], "error");
  assert.equal(st["sweep:reminders"], "ok");
  assert.ok(f.calls.every((c) => !c.url.includes("localhost:20128")));
});

test("every call to the vault repo carries only the vault token; every other GitHub call carries only the read token", async () => {
  const f = fakeFetch([{ match: "api.github.com", status: 500, json: {} }]); // jobs fail, but every attempted call is recorded
  const w = createWorker({ fetch: f });
  const env = { ...mkEnv(), GITHUB_TOKEN_VAULT: "vault-secret", GITHUB_TOKEN_READ: "read-secret", GITHUB_TOKEN: undefined };
  const ectx = recordingCtx();
  await w.scheduled({ scheduledTime: 0, cron: "*/15 * * * *" }, env as never, ectx);
  await Promise.all(ectx.promises);
  const bearer = (c: { headers: Record<string, string> }) =>
    Object.entries(c.headers).find(([k]) => k.toLowerCase() === "authorization")?.[1];
  const gh = f.calls.filter((c) => c.url.includes("api.github.com"));
  const isVault = (u: string) => u.includes("/repos/me/vault/"); // git data calls AND contents reads (e.g. Meta/rules.json)
  const vault = gh.filter((c) => isVault(c.url));
  const rest = gh.filter((c) => !isVault(c.url));
  assert.ok(vault.length > 0, "the manual-notes sync must have touched the vault");
  assert.ok(rest.length > 0, "the GitHub poll must have run");
  assert.ok(vault.every((c) => bearer(c) === "Bearer vault-secret"));
  assert.ok(rest.every((c) => bearer(c) === "Bearer read-secret"));
});

test("phone editor: EDIT_ENABLED off (or no ADMIN_TOKEN) makes every /login and /edit route a plain 404", async () => {
  const w = createWorker({ fetch: fakeFetch([]) });
  for (const over of [{ EDIT_ENABLED: "0" }, {}, { EDIT_ENABLED: "1", ADMIN_TOKEN: undefined }, { EDIT_ENABLED: "true" }]) {
    const env = mkEnv(over);
    for (const [method, path] of [["GET", "/login"], ["GET", "/edit"], ["GET", "/edit/file?path=Notes/a.md"], ["POST", "/edit/save"], ["POST", "/login"]] as const) {
      const r = await w.fetch(new Request(`https://w.example${path}`, { method }), env as never, recordingCtx());
      assert.equal(r.status, 404, `${method} ${path} with ${JSON.stringify(over)}`);
    }
  }
});

test("phone editor: when enabled, /login is served with security headers; /edit without a session redirects to /login; a wrong password is 401", async () => {
  const w = createWorker({ fetch: fakeFetch([]) });
  const env = mkEnv({ EDIT_ENABLED: "1" });
  const login = await w.fetch(new Request("https://w.example/login"), env as never, recordingCtx());
  assert.equal(login.status, 200);
  assert.match(login.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  assert.equal(login.headers.get("cache-control"), "no-store");
  const anon = await w.fetch(new Request("https://w.example/edit"), env as never, recordingCtx());
  assert.equal(anon.status, 303);
  assert.equal(anon.headers.get("location"), "/login");
  const bad = await w.fetch(
    new Request("https://w.example/login", { method: "POST", headers: { origin: "https://w.example", "content-type": "application/x-www-form-urlencoded" }, body: "password=nope" }),
    env as never, recordingCtx(),
  );
  assert.equal(bad.status, 401);
  assert.equal(bad.headers.get("set-cookie"), null); // no session on a failed login
});

test("phone editor: a cross-origin login POST is refused even with the right password", async () => {
  const w = createWorker({ fetch: fakeFetch([]) });
  const env = mkEnv({ EDIT_ENABLED: "1" });
  const r = await w.fetch(
    new Request("https://w.example/login", { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/x-www-form-urlencoded" }, body: "password=admin-secret-value" }),
    env as never, recordingCtx(),
  );
  assert.equal(r.status, 403);
  assert.equal(r.headers.get("set-cookie"), null);
});
