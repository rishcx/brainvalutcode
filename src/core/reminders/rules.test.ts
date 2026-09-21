import assert from "node:assert/strict";
import { test } from "node:test";
import { testContext } from "../../node/testing/context.ts";
import { FixedClock } from "../clock.ts";
import { MemoryVault } from "../testing/fakes.ts";
import type { VaultWriter } from "../types.ts";
import { loadRules, offsetsFor, parseRulesJson, RULES_PATH, RULES_TTL_MS } from "./rules.ts";

const HOTEL = JSON.stringify({ rules: [{ id: "Hotel", offsets: ["3h"], keywords: [" Hotel ", ""] }] });

function counting(seed: Record<string, string>) {
  const inner = new MemoryVault(seed);
  const state = { reads: 0 };
  const vault: VaultWriter = {
    readFile: async (p) => (state.reads++, inner.readFile(p)),
    listFiles: (p) => inner.listFiles(p),
    writeFiles: (m, f) => inner.writeFiles(m, f),
  };
  return { vault, state };
}

test("Meta/rules.json overrides config; cached within TTL, re-read after", async () => {
  const { vault, state } = counting({ [RULES_PATH]: HOTEL });
  const ctx = testContext({ vault });
  const r = await loadRules(ctx);
  assert.deepEqual(r, [{ id: "hotel", offsets: ["3h"], keywords: ["hotel"] }]);
  assert.equal(state.reads, 1);
  await loadRules(ctx);
  assert.equal(state.reads, 1);
  const later = { ...ctx, clock: new FixedClock(new Date(ctx.clock.now().getTime() + RULES_TTL_MS + 1).toISOString(), ctx.clock.tz) };
  await loadRules(later);
  assert.equal(state.reads, 2);
});

test("invalid rules files parse to null and loadRules falls back to config", async () => {
  const bad = [
    "{nope",
    JSON.stringify([{ id: "default", offsets: ["1h"], keywords: [] }]),
    JSON.stringify([{ id: "a", offsets: [], keywords: [] }, { id: "a", offsets: [], keywords: [] }]),
    JSON.stringify([{ id: "a", offsets: ["7x"], keywords: [] }]),
    JSON.stringify([{ id: "a", offsets: ["31d"], keywords: [] }]),
  ];
  for (const b of bad) assert.equal(parseRulesJson(b), null, b);
  assert.deepEqual(parseRulesJson("[]"), []);
  for (const b of bad) {
    const ctx = testContext({ vault: new MemoryVault({ [RULES_PATH]: b }) });
    assert.deepEqual(await loadRules(ctx), ctx.config.reminders.rules);
  }
  const throwing: VaultWriter = {
    readFile: async () => { throw new Error("boom"); },
    listFiles: async () => [],
    writeFiles: async () => [],
  };
  const ctx = testContext({ vault: throwing });
  assert.deepEqual(await loadRules(ctx), ctx.config.reminders.rules);
});

test("offsetsFor falls back to default offsets", () => {
  const ctx = testContext();
  const rules = [{ id: "x", offsets: [], keywords: [] }, { id: "f", offsets: ["24h"], keywords: [] }];
  assert.deepEqual(offsetsFor("x", rules, ctx.config), ctx.config.reminders.offsets);
  assert.deepEqual(offsetsFor("default", rules, ctx.config), ctx.config.reminders.offsets);
  assert.deepEqual(offsetsFor("nope", rules, ctx.config), ctx.config.reminders.offsets);
  assert.deepEqual(offsetsFor("f", rules, ctx.config), ["24h"]);
});
