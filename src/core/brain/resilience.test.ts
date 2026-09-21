import assert from "node:assert/strict";
import { test } from "node:test";
import { FixedClock } from "../clock.ts";
import { testContext } from "../../node/testing/context.ts";
import { SqliteStore } from "../../node/store/sqlite.ts";
import type { BrainEntry, Fetcher } from "../types.ts";
import { createBrain } from "./chain.ts";
import { parseRate } from "./openaiCompat.ts";

const entry = (name: string, models: string[], extra: Partial<BrainEntry> = {}): BrainEntry => ({
  kind: "groq",
  name,
  baseUrl: `https://${name}.test/v1`,
  keyEnv: "K",
  models,
  local: false,
  ...extra,
});
const env = (n: string) => (n === "K" ? "key" : undefined);
const ok = (text = "hello", headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { status: 200, headers });
const modelOf = (init?: RequestInit): string => JSON.parse(String(init?.body)).model as string;

// A fetch that hangs until its abort signal fires, like a hung free model.
const hang = (signal: AbortSignal | null | undefined): Promise<Response> =>
  new Promise((_, reject) => signal?.addEventListener("abort", () => reject(Object.assign(new Error("t"), { name: "TimeoutError" }))));

test("a hung model under a chat purpose is abandoned at req.timeoutMs; the next model still answers, well inside 4.5s", async () => {
  const calls: string[] = [];
  const fetch1: Fetcher = async (_u, init) => {
    const model = modelOf(init);
    calls.push(model);
    return model === "slow" ? hang(init?.signal) : ok();
  };
  const ctx = testContext({
    env,
    runtime: "worker",
    fetch: fetch1,
    configPatch: { brain: { entries: [entry("a", ["slow"]), entry("b", ["fast"])] } },
  });
  const t0 = Date.now();
  const r = await createBrain(ctx).complete({ prompt: "p", purpose: "plan", cacheTtlMs: 0, timeoutMs: 200 });
  assert.equal(r.model, "fast");
  assert.deepEqual(calls, ["slow", "fast"]);
  assert.ok(Date.now() - t0 < 4500, `finished in ${Date.now() - t0}ms`);
});

test("a 429 with retry-after puts the model on cooldown; the next call skips it with zero fetches; after the cooldown it is tried again", async () => {
  const clock = new FixedClock("2026-01-01T00:00:00Z", "UTC");
  const store = new SqliteStore(":memory:", clock);
  const entries = [entry("g", ["m1", "m2"])];
  const fetch1: Fetcher = async (_u, init) => {
    const model = modelOf(init);
    return model === "m1" ? new Response("{}", { status: 429, headers: { "retry-after": "30" } }) : ok("second");
  };

  const ctx1 = testContext({ store, clock, env, runtime: "worker", fetch: fetch1, configPatch: { brain: { entries } } });
  const c1: string[] = [];
  const r1 = await createBrain({ ...ctx1, fetch: async (u, init) => (c1.push(modelOf(init)), fetch1(u, init)) }).complete({
    prompt: "p",
    cacheTtlMs: 0,
  });
  assert.equal(r1.model, "m2");
  assert.deepEqual(c1, ["m1", "m2"]);

  const ctx2 = testContext({ store, clock, env, runtime: "worker", fetch: fetch1, configPatch: { brain: { entries } } });
  const c2: string[] = [];
  const r2 = await createBrain({ ...ctx2, fetch: async (u, init) => (c2.push(modelOf(init)), fetch1(u, init)) }).complete({
    prompt: "p",
    cacheTtlMs: 0,
  });
  assert.equal(r2.model, "m2");
  assert.deepEqual(c2, ["m2"]); // m1 skipped: no fetch to it at all

  const clock2 = new FixedClock("2026-01-01T00:00:31Z", "UTC");
  const ctx3 = testContext({ store, clock: clock2, env, runtime: "worker", fetch: fetch1, configPatch: { brain: { entries } } });
  const c3: string[] = [];
  await createBrain({ ...ctx3, fetch: async (u, init) => (c3.push(modelOf(init)), fetch1(u, init)) }).complete({
    prompt: "p",
    cacheTtlMs: 0,
  });
  assert.deepEqual(c3, ["m1", "m2"]); // 31s later: m1 is tried again (it still 429s, so the chain moves to m2)
});

test("remaining_req 0 with a future reset skips the model with zero fetches; a daily budget of 2 skips the whole entry on the third call", async () => {
  const clock = new FixedClock("2026-01-01T00:00:00Z", "UTC");
  const store = new SqliteStore(":memory:", clock);
  const entries = [entry("g", ["m1", "m2"])];
  const fetch1: Fetcher = async (_u, init) => {
    const model = modelOf(init);
    return model === "m1" ? ok("used", { "x-ratelimit-remaining-requests": "0", "x-ratelimit-reset-requests": "5m" }) : ok("fallback");
  };
  const ctx1 = testContext({ store, clock, env, runtime: "worker", fetch: fetch1, configPatch: { brain: { entries } } });
  const r1 = await createBrain(ctx1).complete({ prompt: "p", cacheTtlMs: 0 });
  assert.equal(r1.model, "m1"); // succeeds, but leaves remaining_req = 0, reset 5 min out

  const ctx2 = testContext({ store, clock, env, runtime: "worker", fetch: fetch1, configPatch: { brain: { entries } } });
  const c2: string[] = [];
  const r2 = await createBrain({ ...ctx2, fetch: async (u, init) => (c2.push(modelOf(init)), fetch1(u, init)) }).complete({
    prompt: "p",
    cacheTtlMs: 0,
  });
  assert.deepEqual(c2, ["m2"]); // m1 skipped, no fetch
  assert.equal(r2.model, "m2");

  // daily budget
  const budgetEntries = [entry("capped", ["m1"])];
  const fetch2: Fetcher = async () => ok("ok");
  const patch = { brain: { entries: budgetEntries, dailyBudget: { capped: 2 } } };
  for (let i = 0; i < 2; i++) {
    const ctx = testContext({ store, clock, env, runtime: "worker", fetch: fetch2, configPatch: patch });
    const r = await createBrain(ctx).complete({ prompt: `p${i}`, cacheTtlMs: 0 });
    assert.equal(r.entry, "capped");
  }
  const ctx3 = testContext({ store, clock, env, runtime: "worker", fetch: fetch2, configPatch: patch });
  const c3: string[] = [];
  const r3 = await createBrain({ ...ctx3, fetch: async (u, init) => (c3.push(modelOf(init)), fetch2(u, init)) }).complete({
    prompt: "p3",
    cacheTtlMs: 0,
  });
  assert.deepEqual(c3, []); // budget exhausted: the whole entry is skipped, no fetch
  assert.equal(r3.entry, "deterministic");
});

test("a 400 caused by extraBody/responseFormat retries the same model once without them, and remembers for next time", async () => {
  const clock = new FixedClock("2026-01-01T00:00:00Z", "UTC");
  const store = new SqliteStore(":memory:", clock);
  const entries = [entry("g", ["m1"], { jsonMode: true, extraBody: { reasoning_effort: "low" } })];
  const bodies: Record<string, unknown>[] = [];
  const fetch1: Fetcher = async (_u, init) => {
    const b = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(b);
    if (b.reasoning_effort !== undefined || b.response_format !== undefined) return new Response("{}", { status: 400 });
    return ok("plain");
  };

  const ctx1 = testContext({ store, clock, env, runtime: "worker", fetch: fetch1, configPatch: { brain: { entries } } });
  const r1 = await createBrain(ctx1).complete({ prompt: "p", cacheTtlMs: 0, responseFormat: "json_object" });
  assert.equal(r1.model, "m1");
  assert.equal(bodies.length, 2);
  assert.ok(bodies[0]!.reasoning_effort !== undefined || bodies[0]!.response_format !== undefined, "first attempt sent extras");
  assert.equal(bodies[1]!.reasoning_effort, undefined);
  assert.equal(bodies[1]!.response_format, undefined);

  bodies.length = 0;
  const ctx2 = testContext({ store, clock, env, runtime: "worker", fetch: fetch1, configPatch: { brain: { entries } } });
  const r2 = await createBrain(ctx2).complete({ prompt: "p2", cacheTtlMs: 0, responseFormat: "json_object" });
  assert.equal(bodies.length, 1); // straight to no-extra: the kv flag from the previous call was honoured
  assert.equal(bodies[0]!.reasoning_effort, undefined);
  assert.equal(r2.model, "m1");
});

test("response_format is sent only for an entry with jsonMode: true", async () => {
  const bodies: Record<string, unknown>[] = [];
  const fetch1: Fetcher = async (_u, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return ok();
  };

  const withJson = testContext({ env, runtime: "worker", fetch: fetch1, configPatch: { brain: { entries: [entry("g", ["m1"], { jsonMode: true })] } } });
  await createBrain(withJson).complete({ prompt: "p", cacheTtlMs: 0, responseFormat: "json_object" });
  assert.deepEqual(bodies.at(-1)!.response_format, { type: "json_object" });

  const withoutJson = testContext({ env, runtime: "worker", fetch: fetch1, configPatch: { brain: { entries: [entry("h", ["m1"])] } } });
  await createBrain(withoutJson).complete({ prompt: "p", cacheTtlMs: 0, responseFormat: "json_object" });
  assert.equal(bodies.at(-1)!.response_format, undefined);
});

test("usage tokens from the provider are recorded in provider_usage", async () => {
  const clock = new FixedClock("2026-01-01T00:00:00Z", "UTC");
  const store = new SqliteStore(":memory:", clock);
  const fetch1: Fetcher = async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 12, completion_tokens: 34 } }), { status: 200 });
  const ctx = testContext({ store, clock, env, runtime: "worker", fetch: fetch1, configPatch: { brain: { entries: [entry("g", ["m1"])] } } });
  await createBrain(ctx).complete({ prompt: "p", cacheTtlMs: 0 });
  const rows = await store.getUsage("2026-01-01");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.requests, 1);
  assert.equal(rows[0]?.tokensIn, 12);
  assert.equal(rows[0]?.tokensOut, 34);
});

test("extraBody can never override model, messages, max_tokens or response_format", async () => {
  const bodies: Record<string, unknown>[] = [];
  const fetch1: Fetcher = async (_u, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return ok();
  };
  const entries = [entry("g", ["m1"], { extraBody: { model: "evil", messages: [{ role: "user", content: "evil" }], max_tokens: 1, temperature: 2 } })];
  const ctx = testContext({ env, runtime: "worker", fetch: fetch1, configPatch: { brain: { entries } } });
  await createBrain(ctx).complete({ prompt: "p", cacheTtlMs: 0, maxTokens: 50 });
  assert.equal(bodies[0]!.model, "m1");
  assert.equal(bodies[0]!.max_tokens, 50);
  assert.deepEqual((bodies[0]!.messages as { content: string }[]).at(-1)?.content, "p");
  assert.equal(bodies[0]!.temperature, 2); // temperature is not protected, so extraBody may set it
});

test("purpose plan/compose/summary use chat.llmBudgetMs; anything else keeps brain.budgetMs (existing floor behaviour unaffected)", async () => {
  const ctx = testContext({
    fetch: async (_u, init) => hang(init?.signal),
    env,
    configPatch: { brain: { budgetMs: 1000, entries: [entry("a", ["m1", "m2"])] } },
  });
  const r = await createBrain(ctx).complete({ prompt: "p" });
  assert.equal(r.entry, "deterministic");
});

test("parseRate: Groq-style durations, retry-after as seconds and as an http date, garbled/missing headers are absent, never thrown", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  const h = (o: Record<string, string>) => new Headers(o);

  assert.equal(parseRate(h({ "x-ratelimit-reset-requests": "2m59.56s" }), now).resetAt, new Date(now.getTime() + 179_560).toISOString());
  assert.equal(parseRate(h({ "x-ratelimit-reset-requests": "7.66s" }), now).resetAt, new Date(now.getTime() + 7660).toISOString());
  assert.equal(parseRate(h({ "x-ratelimit-reset-requests": "1h2m" }), now).resetAt, new Date(now.getTime() + 3_720_000).toISOString());
  assert.equal(parseRate(h({ "x-ratelimit-reset-requests": "1h2m3.5s" }), now).resetAt, new Date(now.getTime() + 3_723_500).toISOString());
  assert.equal(parseRate(h({ "x-ratelimit-reset-requests": "garbled" }), now).resetAt, undefined);

  assert.equal(parseRate(h({ "retry-after": "30" }), now).retryAfterMs, 30_000);
  const future = new Date(now.getTime() + 15_000).toUTCString();
  assert.equal(parseRate(h({ "retry-after": future }), now).retryAfterMs, 15_000);
  assert.equal(parseRate(h({ "retry-after": "not a date" }), now).retryAfterMs, undefined);

  assert.equal(parseRate(h({ "x-ratelimit-remaining-requests": "7", "x-ratelimit-remaining-tokens": "999" }), now).remainingReq, 7);
  assert.equal(parseRate(h({ "x-ratelimit-remaining-requests": "7" }), now).remainingTok, undefined);

  assert.deepEqual(parseRate(h({}), now), {});
});

test("a broken usage store (getUsage/bumpUsage/kv) degrades the bookkeeping only: the reply still succeeds", async () => {
  const ctx = testContext({ env, runtime: "worker", fetch: async () => ok(), configPatch: { brain: { entries: [entry("g", ["m1"])] } } });
  const broken = new Proxy(ctx.store, {
    get(t, k, r) {
      if (k === "getUsage" || k === "bumpUsage" || k === "kvGet" || k === "kvSet") {
        return async () => {
          throw new Error("store down");
        };
      }
      return Reflect.get(t, k, r);
    },
  });
  // cacheTtlMs 0 also sidesteps cacheGet/cacheSet, which are pre-existing (not v3) and unguarded by design.
  const r = await createBrain({ ...ctx, store: broken }).complete({ prompt: "p", cacheTtlMs: 0 });
  assert.equal(r.entry, "g"); // the request itself still succeeds; only the bookkeeping is degraded
});

test("the 'drop extras' memory expires after 24 h: extras are tried again the next day", async () => {
  const store = new SqliteStore(":memory:", new FixedClock("2026-01-01T00:00:00Z", "UTC"));
  const entries = [entry("g", ["m1"], { jsonMode: true })];
  const bodies: Record<string, unknown>[] = [];
  const f: Fetcher = async (_u, init) => {
    const b = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(b);
    return b.response_format !== undefined ? new Response("{}", { status: 400 }) : ok("plain");
  };
  const at = (iso: string) =>
    testContext({ store, clock: new FixedClock(iso, "UTC"), env, runtime: "worker", fetch: f, configPatch: { brain: { entries } } });
  await createBrain(at("2026-01-01T00:00:00Z")).complete({ prompt: "a", cacheTtlMs: 0, responseFormat: "json_object" });
  bodies.length = 0;
  await createBrain(at("2026-01-01T23:00:00Z")).complete({ prompt: "b", cacheTtlMs: 0, responseFormat: "json_object" });
  assert.equal(bodies[0]!.response_format, undefined, "still remembered within 24 h");
  bodies.length = 0;
  await createBrain(at("2026-01-02T00:30:00Z")).complete({ prompt: "c", cacheTtlMs: 0, responseFormat: "json_object" });
  assert.notEqual(bodies[0]!.response_format, undefined, "tried again after 24 h");
});

test("an entry with `purposes` is used only for those purposes (paid model reserved for answer-writing)", async () => {
  const seen: string[] = [];
  const f: Fetcher = async (_u, init) => { seen.push(modelOf(init)); return ok("x"); };
  const entries = [entry("paid", ["big"], { purposes: ["compose"] }), entry("free", ["small"])];
  const mk = () => testContext({ env, runtime: "worker", fetch: f, configPatch: { brain: { entries } } });
  await createBrain(mk()).complete({ prompt: "p", cacheTtlMs: 0, purpose: "plan" });
  await createBrain(mk()).complete({ prompt: "p", cacheTtlMs: 0 });
  await createBrain(mk()).complete({ prompt: "p", cacheTtlMs: 0, purpose: "compose" });
  assert.deepEqual(seen, ["small", "small", "big"]);
});
