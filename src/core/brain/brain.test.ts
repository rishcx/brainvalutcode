import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fakeFetch, type FakeRoute } from "../testing/fakes.ts";
import { testContext } from "../../node/testing/context.ts";
import { createBrain } from "./chain.ts";

const ok = (text: string, extra: Partial<FakeRoute> = {}): FakeRoute => ({
  match: "chat/completions",
  json: { choices: [{ message: { content: text } }] },
  ...extra,
});
const entry = (name: string, host: string, models = ["m1"], local = false) => ({
  kind: "openrouter",
  name,
  baseUrl: `https://${host}/v1`,
  keyEnv: "K",
  models,
  local,
});
const env = (n: string) => (n === "K" ? "key" : undefined);
const det = { kind: "deterministic", name: "deterministic", models: [] };

test("retries once on 500 then succeeds", async () => {
  const f = fakeFetch([{ match: "chat/completions", status: 500, times: 1 }, ok("hello")]);
  const ctx = testContext({ fetch: f, env, configPatch: { brain: { entries: [entry("a", "a.test"), det] } } });
  const r = await createBrain(ctx).complete({ prompt: "p" });
  assert.equal(f.calls.length, 2);
  assert.equal(r.text, "hello");
  assert.equal(r.entry, "a");
});

test("no retry on 401; moves to next entry", async () => {
  const f = fakeFetch([{ match: "a.test", status: 401 }, { match: "b.test", json: { choices: [{ message: { content: "B" } }] } }]);
  const ctx = testContext({ fetch: f, env, configPatch: { brain: { entries: [entry("a", "a.test"), entry("b", "b.test"), det] } } });
  const r = await createBrain(ctx).complete({ prompt: "p" });
  assert.equal(f.calls.filter((c) => c.url.includes("a.test")).length, 1);
  assert.equal(r.entry, "b");
});

test("deterministic floor when everything fails, never rejects", async () => {
  const f = fakeFetch([{ match: "chat/completions", status: 500 }]);
  const ctx = testContext({ fetch: f, env, configPatch: { brain: { entries: [entry("a", "a.test", ["m1", "m2"]), det] } } });
  const r = await createBrain(ctx).complete({ prompt: "hi <FACTS>\nfact one\n</FACTS>" });
  assert.equal(r.entry, "deterministic");
  assert.ok(r.text.includes("fact one"));
  const r2 = await createBrain(ctx).complete({ prompt: "no block" });
  assert.equal(r2.text, "no block");
});

test("missing key skips entry without a call", async () => {
  const f = fakeFetch([ok("x")]);
  const ctx = testContext({ fetch: f, configPatch: { brain: { entries: [entry("a", "a.test"), det] } } });
  const r = await createBrain(ctx).complete({ prompt: "p" });
  assert.equal(f.calls.length, 0);
  assert.equal(r.entry, "deterministic");
});

test("cache hit makes zero fetches; different prompt misses", async () => {
  const f = fakeFetch([ok("cached-text")]);
  const ctx = testContext({ fetch: f, env, configPatch: { brain: { entries: [entry("a", "a.test"), det] } } });
  const brain = createBrain(ctx);
  const a = await brain.complete({ prompt: "same" });
  const n = f.calls.length;
  const b = await brain.complete({ prompt: "same" });
  assert.equal(a.cached, false);
  assert.equal(b.cached, true);
  assert.equal(b.text, "cached-text");
  assert.equal(f.calls.length, n);
  await brain.complete({ prompt: "different" });
  assert.equal(f.calls.length, n + 1);
});

test("cacheTtlMs 0 disables the cache", async () => {
  const f = fakeFetch([ok("t")]);
  const ctx = testContext({ fetch: f, env, configPatch: { brain: { entries: [entry("a", "a.test"), det] } } });
  const brain = createBrain(ctx);
  await brain.complete({ prompt: "same", cacheTtlMs: 0 });
  const r = await brain.complete({ prompt: "same", cacheTtlMs: 0 });
  assert.equal(r.cached, false);
  assert.equal(f.calls.length, 2);
});

test("local gateway never reached from worker or when disallowed", async () => {
  const entries = [entry("local", "localhost:20128", ["m1"], true), entry("or", "or.test"), det];
  const f1 = fakeFetch([ok("x")]);
  const w = testContext({ fetch: f1, env, runtime: "worker", configPatch: { brain: { entries } } });
  await createBrain(w).complete({ prompt: "p" });
  assert.ok(f1.calls.length > 0);
  assert.ok(f1.calls.every((c) => !c.url.includes("localhost:20128")));

  const f2 = fakeFetch([ok("x")]);
  const c = testContext({ fetch: f2, env, runtime: "cli", configPatch: { brain: { entries } } });
  await createBrain(c, { allowLocalGateway: false }).complete({ prompt: "p" });
  assert.ok(f2.calls.every((x) => !x.url.includes("localhost:20128")));

  const f3 = fakeFetch([ok("x")]);
  const c3 = testContext({ fetch: f3, env, runtime: "cli", configPatch: { brain: { entries } } });
  await createBrain(c3).complete({ prompt: "p" });
  assert.ok(f3.calls[0]!.url.includes("localhost:20128"));
});

test("budget exhaustion falls through to deterministic", async () => {
  const hang = ((_u: string, init?: RequestInit) =>
    new Promise<Response>((_res, rej) => {
      init?.signal?.addEventListener("abort", () => rej(Object.assign(new Error("t"), { name: "TimeoutError" })));
    })) as never;
  const ctx = testContext({ fetch: hang, env, configPatch: { brain: { budgetMs: 1000, entries: [entry("a", "a.test", ["m1", "m2"]), det] } } });
  const r = await createBrain(ctx).complete({ prompt: "p" });
  assert.equal(r.entry, "deterministic");
});

test("model ids come from config only", async () => {
  const f = fakeFetch([ok("x")]);
  const ctx = testContext({ fetch: f, env, configPatch: { brain: { entries: [entry("a", "a.test", ["custom/model-x"]), det] } } });
  const r = await createBrain(ctx).complete({ prompt: "p" });
  assert.equal(r.model, "custom/model-x");
  assert.equal(JSON.parse(f.calls[0]!.body!).model, "custom/model-x");
  for (const file of ["chain", "openaiCompat", "deterministic", "cache"]) {
    const src = readFileSync(new URL(`./${file}.ts`, import.meta.url), "utf8");
    assert.ok(!/gemini|deepseek|qwen|gpt-/i.test(src), `${file}.ts hardcodes a model id`);
  }
});

test("invalid JSON for a schema request moves on", async () => {
  const f = fakeFetch([ok("not json")]);
  const ctx = testContext({ fetch: f, env, configPatch: { brain: { entries: [entry("a", "a.test"), det] } } });
  const r = await createBrain(ctx).complete({ prompt: "p", jsonSchema: { type: "object" } });
  assert.equal(r.entry, "deterministic");
});
