import assert from "node:assert/strict";
import { test } from "node:test";
import { FixedClock } from "../clock.ts";
import { testContext } from "../../node/testing/context.ts";
import { SqliteStore } from "../../node/store/sqlite.ts";
import type { AgentContext, BrainEntry, ProviderUsage } from "../types.ts";
import { canUse, extraBodyFor, loadUsage, quotaStatus, recordCall } from "./usage.ts";

const entry = (name: string, models: string[], extra: Partial<BrainEntry> = {}): BrainEntry => ({
  kind: "groq",
  name,
  baseUrl: `https://${name}.test/v1`,
  keyEnv: "K",
  models,
  local: false,
  ...extra,
});

const row = (over: Partial<ProviderUsage> = {}): ProviderUsage => ({
  day: "2026-01-01",
  provider: "g",
  model: "m1",
  requests: 0,
  tokensIn: 0,
  tokensOut: 0,
  rateLimited: 0,
  remainingReq: null,
  remainingTok: null,
  cooldownUntil: null,
  resetAt: null,
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

function counting(ctx: AgentContext): { ctx: AgentContext; getUsageCalls: () => number } {
  let n = 0;
  const store = new Proxy(ctx.store, {
    get(t, k, r) {
      const v = Reflect.get(t, k, r);
      if (k === "getUsage" && typeof v === "function") {
        return (...a: unknown[]) => {
          n++;
          return (v as (...x: unknown[]) => unknown).apply(t, a);
        };
      }
      return v;
    },
  });
  return { ctx: { ...ctx, store }, getUsageCalls: () => n };
}

test("loadUsage: one D1 read per ctx, memoised across repeated calls on the same day", async () => {
  const clock = new FixedClock("2026-01-01T00:00:00Z", "UTC");
  const base = testContext({ clock });
  const { ctx, getUsageCalls } = counting(base);
  await loadUsage(ctx);
  await loadUsage(ctx);
  await loadUsage(ctx);
  assert.equal(getUsageCalls(), 1);
});

test("loadUsage: day is UTC, not the configured local timezone", async () => {
  // 23:30 UTC on 2025-12-31 is already 2026-01-01 in Asia/Kolkata (+5:30): the usage day must stay on UTC.
  const clock = new FixedClock("2025-12-31T23:30:00Z", "Asia/Kolkata");
  const ctx = testContext({ clock, tz: "Asia/Kolkata" });
  const v = await loadUsage(ctx);
  assert.equal(v.day, "2025-12-31");
});

test("canUse: cooldown, exhausted (with a passed reset being usable again), and daily budget", async () => {
  const cfg = testContext({}).config;
  const e = entry("g", ["m1"]);
  const now = new Date("2026-01-01T00:00:30Z");

  const cooling = { day: "2026-01-01", rows: [row({ cooldownUntil: "2026-01-01T00:01:00Z" })] };
  assert.deepEqual(canUse(cooling, e, "m1", cfg, now), { ok: false, reason: "cooldown", until: "2026-01-01T00:01:00Z" });

  const expiredCooldown = { day: "2026-01-01", rows: [row({ cooldownUntil: "2026-01-01T00:00:00Z" })] };
  assert.deepEqual(canUse(expiredCooldown, e, "m1", cfg, now), { ok: true });

  const exhausted = { day: "2026-01-01", rows: [row({ remainingReq: 0, resetAt: "2026-01-01T00:05:00Z" })] };
  assert.deepEqual(canUse(exhausted, e, "m1", cfg, now), { ok: false, reason: "exhausted", until: "2026-01-01T00:05:00Z" });

  const resetPassed = { day: "2026-01-01", rows: [row({ remainingReq: 0, resetAt: "2026-01-01T00:00:00Z" })] };
  assert.deepEqual(canUse(resetPassed, e, "m1", cfg, now), { ok: true });

  const unknownReset = { day: "2026-01-01", rows: [row({ remainingReq: 0, resetAt: null })] };
  assert.equal(canUse(unknownReset, e, "m1", cfg, now).ok, false);

  const budgeted = testContext({ configPatch: { brain: { dailyBudget: { g: 2 } } } }).config;
  const twoModels = entry("g", ["m1", "m2"]);
  const atBudget = { day: "2026-01-01", rows: [row({ requests: 1 }), row({ model: "m2", requests: 1 })] };
  assert.deepEqual(canUse(atBudget, twoModels, "m1", budgeted, now), { ok: false, reason: "budget", until: null });

  const underBudget = { day: "2026-01-01", rows: [row({ requests: 1 })] };
  assert.deepEqual(canUse(underBudget, twoModels, "m1", budgeted, now), { ok: true });

  // no configured budget for this entry name => unlimited
  const noBudget = { day: "2026-01-01", rows: [row({ requests: 10_000 })] };
  assert.deepEqual(canUse(noBudget, e, "m1", cfg, now), { ok: true });
});

test("recordCall: bumps the store and the memoised view in place, without a second D1 read", async () => {
  const clock = new FixedClock("2026-01-01T00:00:00Z", "UTC");
  const base = testContext({ clock });
  const { ctx, getUsageCalls } = counting(base);
  const v0 = await loadUsage(ctx);
  assert.equal(v0.rows.length, 0);

  await recordCall(ctx, "g", "m1", { ok: true, status: 200, usage: { in: 10, out: 5 }, rate: { remainingReq: 3, resetAt: "2026-01-01T01:00:00Z" } });
  assert.equal(getUsageCalls(), 1); // still just the first loadUsage read

  const v1 = await loadUsage(ctx);
  assert.equal(getUsageCalls(), 1); // no extra read: served from memo
  assert.equal(v1.rows.length, 1);
  assert.equal(v1.rows[0]?.requests, 1);
  assert.equal(v1.rows[0]?.tokensIn, 10);
  assert.equal(v1.rows[0]?.tokensOut, 5);
  assert.equal(v1.rows[0]?.remainingReq, 3);

  await recordCall(ctx, "g", "m1", { ok: false, status: 429, rate: { retryAfterMs: 30_000 } });
  const v2 = await loadUsage(ctx);
  assert.equal(v2.rows[0]?.requests, 2); // additive
  assert.equal(v2.rows[0]?.rateLimited, 1);
  assert.equal(v2.rows[0]?.cooldownUntil, "2026-01-01T00:00:30.000Z");
  assert.equal(v2.rows[0]?.remainingReq, 3); // unset field on this bump: previous value survives

  const persisted = await ctx.store.getUsage("2026-01-01");
  assert.equal(persisted[0]?.requests, 2);
});

test("recordCall: a store write failure is swallowed, never thrown", async () => {
  const clock = new FixedClock("2026-01-01T00:00:00Z", "UTC");
  const base = testContext({ clock });
  const store = new Proxy(base.store, {
    get(t, k, r) {
      if (k === "bumpUsage") return async () => { throw new Error("D1 write failed"); };
      return Reflect.get(t, k, r);
    },
  });
  const ctx = { ...base, store };
  await assert.doesNotReject(recordCall(ctx, "g", "m1", { ok: true, status: 200 }));
});

test("quotaStatus: not exhausted while at least one keyed HTTP entry/model can still be used", async () => {
  const clock = new FixedClock("2026-01-01T00:00:30Z", "UTC");
  const store = new SqliteStore(":memory:", clock);
  const ctx = testContext({
    store,
    clock,
    env: (n) => (n === "K1" ? "key1" : n === "K2" ? "key2" : undefined),
    configPatch: {
      brain: {
        entries: [
          entry("a", ["m1"], { keyEnv: "K1" }),
          entry("b", ["m2"], { keyEnv: "K2" }),
          { kind: "deterministic", name: "deterministic", models: [], local: false },
        ],
      },
    },
  });
  await recordCall(ctx, "a", "m1", { ok: false, status: 429, rate: { retryAfterMs: 60_000 } });
  const s = await quotaStatus(ctx);
  assert.equal(s.exhausted, false); // "b" is still fine
});

test("quotaStatus: exhausted once every keyed entry has no usable model, resetAt is the earliest", async () => {
  const clock = new FixedClock("2026-01-01T00:00:30Z", "UTC");
  const store = new SqliteStore(":memory:", clock);
  const ctx = testContext({
    store,
    clock,
    env: (n) => (n === "K1" ? "key1" : n === "K2" ? "key2" : undefined),
    configPatch: {
      brain: {
        entries: [entry("a", ["m1"], { keyEnv: "K1" }), entry("b", ["m2"], { keyEnv: "K2" })],
      },
    },
  });
  await recordCall(ctx, "a", "m1", { ok: false, status: 429, rate: { retryAfterMs: 120_000 } }); // until :02:30
  await recordCall(ctx, "b", "m2", { ok: false, status: 429, rate: { retryAfterMs: 60_000 } }); // until :01:30 (earlier)
  const s = await quotaStatus(ctx);
  assert.equal(s.exhausted, true);
  assert.equal(s.resetAt, "2026-01-01T00:01:30.000Z");
});

test("quotaStatus: no HTTP entry with a key configured at all is not reported exhausted (that is no-brain, a different cause)", async () => {
  const ctx = testContext({ configPatch: { brain: { entries: [entry("a", ["m1"])] } } }); // no env => no key
  const s = await quotaStatus(ctx);
  assert.deepEqual(s, { exhausted: false, resetAt: null });
});

test("extraBodyFor: a flat map applies to every model; a per-model map (keys are model ids or \"*\") is looked up per model", async () => {
  const flat = entry("g", ["m1", "m2"], { extraBody: { reasoning_effort: "low" } });
  assert.deepEqual(extraBodyFor(flat, "m1"), { reasoning_effort: "low" });
  assert.deepEqual(extraBodyFor(flat, "m2"), { reasoning_effort: "low" });

  const perModel = entry("g", ["m1", "m2"], {
    extraBody: { m1: { reasoning_effort: "none" }, "*": { reasoning_effort: "low" } },
  });
  assert.deepEqual(extraBodyFor(perModel, "m1"), { reasoning_effort: "none" });
  assert.deepEqual(extraBodyFor(perModel, "m2"), { reasoning_effort: "low" }); // falls back to "*"

  const noWildcard = entry("g", ["m1", "m2"], { extraBody: { m1: { reasoning_effort: "none" } } });
  assert.deepEqual(extraBodyFor(noWildcard, "m1"), { reasoning_effort: "none" });
  assert.equal(extraBodyFor(noWildcard, "m2"), undefined); // per-model map, no entry and no "*"

  assert.equal(extraBodyFor(entry("g", ["m1"]), "m1"), undefined); // no extraBody at all
});
