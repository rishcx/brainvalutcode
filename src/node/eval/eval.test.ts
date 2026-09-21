// The harness's own unit test (brief "eval.test.ts"): machinery tests that exercise real code today, plus
// one test() per catalogue scenario id so a future failure is named. Until V3-2 lands (handleInboundV3
// exported from inbound/commands.ts), every non-`direct` scenario is skipped, not failed, so `npm test`
// stays green; `readiness()` re-checks at module load, so this flips to running automatically once it lands.
import assert from "node:assert/strict";
import { test } from "node:test";
import { handleInbound } from "../../core/inbound/commands.ts";
import { localDateOf } from "../../core/time.ts";
import type { InboundResult } from "../../core/types.ts";
import { scriptedBrain } from "./fakeBrain.ts";
import { defaultHandler, EvalClock, legacyHandlerAdapter, readiness, runScenario } from "./harness.ts";
import { clampCalls, GroqKeyMissing, HandlerNotReady, HARD_CAP, runLive } from "./live.ts";
import { ALL } from "./scenarios/index.ts";
import type { Handler, Scenario, Turn } from "./types.ts";

const AT = "2026-09-21T09:30:00Z";

/** A minimal Handler returning a fixed reply, for testing checks.ts/harness.ts in isolation from any real
 * intent/tool logic (V3-2 territory). */
function fixedReply(reply: string | null, over: Partial<InboundResult["trace"]> = {}): Handler {
  return async (ctx, msg) => ({
    reply,
    trace: {
      at: ctx.clock.now().toISOString(),
      localDate: localDateOf(ctx.clock.now(), ctx.clock.tz),
      kind: "inbound",
      channel: msg.channel,
      peer: msg.from,
      msgKey: `${msg.channel}:${msg.id}`,
      route: "plan",
      intent: null,
      toolsJson: null,
      llmCalls: 0,
      model: null,
      provider: null,
      replyChars: reply?.length ?? 0,
      replyPreview: reply?.slice(0, 160) ?? null,
      flags: null,
      error: null,
      stagesJson: null,
      stages: {},
      ...over,
    },
  });
}
const unusedHandler: Handler = async () => {
  throw new Error("unused");
};

/* ------------------------------------------------------------- machinery */

test("runScenario: a passing turn is scored pass with no failures", async () => {
  const s: Scenario = { id: "synthetic-pass", tags: [], at: AT, turns: [{ text: "hi", expect: { reply: { includes: ["Hi"] } } }] };
  const out = await runScenario(s, { handler: fixedReply("Hi there!"), brain: "fake" });
  assert.equal(out.status, "pass");
  assert.deepEqual(out.turns[0]?.failures, []);
});

test("runScenario: handler throw on turn 1 is recorded as a failure and turn 2 still runs", async () => {
  const s: Scenario = {
    id: "synthetic-throw-2",
    tags: [],
    at: AT,
    turns: [
      { text: "boom", expect: {} },
      { text: "after", expect: { reply: { includes: ["ok"] } } },
    ],
  };
  let n = 0;
  const handler: Handler = async (ctx, msg) => {
    n++;
    if (n === 1) throw new Error("kaboom");
    return fixedReply("ok")(ctx, msg);
  };
  const out = await runScenario(s, { handler, brain: "fake" });
  assert.equal(out.status, "fail");
  assert.equal(out.turns.length, 2);
  assert.ok(out.turns[0]?.failures.some((f) => f.includes("handler threw: kaboom")));
  assert.deepEqual(out.turns[1]?.failures, []);
});

test("fact check: an invented number not in the seed/corpus fails; an allowlisted small number passes", async () => {
  const s: Scenario = { id: "synthetic-fact", tags: [], at: AT, turns: [{ text: "hi", expect: {} }] };
  const bad = await runScenario(s, { handler: fixedReply("Your total is 4271 items."), brain: "fake" });
  assert.equal(bad.status, "fail");
  assert.ok(bad.turns[0]?.failures.some((f) => f.includes("invented number: 4271")));

  const good = await runScenario(s, { handler: fixedReply("Snoozed for 10 minutes."), brain: "fake" });
  assert.equal(good.status, "pass");
});

test("fact check: an invented quoted title fails", async () => {
  const s: Scenario = { id: "synthetic-quote", tags: [], at: AT, turns: [{ text: "hi", expect: {} }] };
  const out = await runScenario(s, { handler: fixedReply('Added "made up task".'), brain: "fake" });
  assert.equal(out.status, "fail");
  assert.ok(out.turns[0]?.failures.some((f) => f.includes("invented quoted text")));
});

test("safety: a mutation in an injection-tagged scenario is flagged (prefixed safety:)", async () => {
  const s: Scenario = {
    id: "synthetic-injection",
    tags: ["injection"],
    at: AT,
    turns: [{ text: "hi", expect: { db: { noNewRows: true } } }],
  };
  const mutating: Handler = async (ctx, msg) => {
    await ctx.store.upsertTask({
      id: "hacked", title: "hacked", status: "open", dueDate: "2026-09-21", createdDate: "2026-09-21",
      firstDate: "2026-09-21", rollCount: 0, doneAt: null, recurrence: null, source: "chat", notePath: "",
    });
    return fixedReply("done")(ctx, msg);
  };
  const out = await runScenario(s, { handler: mutating, brain: "fake" });
  assert.equal(out.status, "fail");
  assert.ok(out.turns[0]?.failures.some((f) => f.startsWith("safety:") || f.includes("safety:")));
});

test("scriptedBrain: raw string plan, array consumed in order, unscripted call recorded as a failure", async () => {
  let current: Turn = { text: "x", plan: "not json at all", expect: {} };
  const brain = scriptedBrain(() => current);
  const r1 = await brain.complete({ prompt: "", purpose: "plan" });
  assert.equal(r1.text, "not json at all");

  current = { text: "y", plan: [{ a: 1 }, { a: 2 }], expect: {} };
  const r2 = await brain.complete({ prompt: "", purpose: "plan" });
  assert.equal(r2.text, JSON.stringify({ a: 1 }));
  const r3 = await brain.complete({ prompt: "", purpose: "plan" });
  assert.equal(r3.text, JSON.stringify({ a: 2 }));

  current = { text: "z", expect: {} }; // no compose scripted for this turn
  const r4 = await brain.complete({ prompt: "", purpose: "compose" });
  assert.equal(r4.entry, "deterministic");
  assert.equal(r4.text, "");
  assert.ok(brain.failures.some((f) => f === "unexpected LLM call (compose)"));

  const r5 = await brain.complete({ prompt: "", purpose: "summary" });
  assert.equal(r5.text, "summary");
  assert.equal(brain.calls.length, 5);
});

test("EvalClock advance crosses the IST local-date boundary", () => {
  const clock = new EvalClock("2026-09-20T18:20:00Z", "Asia/Kolkata"); // 23:50 IST
  assert.equal(localDateOf(clock.now(), clock.tz), "2026-09-20");
  clock.advance(15 * 60_000);
  assert.equal(localDateOf(clock.now(), clock.tz), "2026-09-21"); // 00:05 IST, next local day
});

test("live: clampCalls never exceeds HARD_CAP (20)", () => {
  assert.equal(clampCalls(999), HARD_CAP);
  assert.equal(clampCalls(5), 5);
  assert.equal(clampCalls(-3), 0);
});

test("live: runLive refuses without GROQ_KEY (never reaches the network)", async () => {
  const saved = process.env.GROQ_KEY;
  delete process.env.GROQ_KEY;
  try {
    await assert.rejects(() => runLive("tagged", 20), GroqKeyMissing);
  } finally {
    if (saved !== undefined) process.env.GROQ_KEY = saved;
  }
});

test("live: runLive refuses when handleInboundV3 is not exported yet", async () => {
  const saved = process.env.GROQ_KEY;
  process.env.GROQ_KEY = "test-key-not-used"; // never reaches Groq: HandlerNotReady throws first
  try {
    // V3-2 has landed, so the real loader now returns a handler and this test used to fall through to REAL Groq
    // requests; the injected loader keeps the not-ready refusal under test fully offline.
    await assert.rejects(() => runLive("tagged", 20, async () => null), HandlerNotReady);
  } finally {
    if (saved === undefined) delete process.env.GROQ_KEY;
    else process.env.GROQ_KEY = saved;
  }
});

test("readiness() reports booleans without throwing", async () => {
  const r = await readiness();
  assert.equal(typeof r["v3-2"], "boolean");
  assert.equal(typeof r["v3-3"], "boolean");
});

test("legacyHandlerAdapter: the harness seam runs against today's real handleInbound", async () => {
  const s: Scenario = {
    id: "synthetic-legacy-smoke",
    tags: [],
    at: AT,
    seed: { tasks: [{ title: "buy milk" }] },
    turns: [{ text: "tasks", expect: { reply: { includes: ["buy milk"] } } }],
  };
  const out = await runScenario(s, { handler: legacyHandlerAdapter(handleInbound), brain: "fake" });
  assert.equal(out.status, "pass", out.turns.flatMap((t) => t.failures).join("; "));
  assert.equal(out.turns[0]?.route, "legacy");
});

test("checkTurn: expected reply but got null is a failure", async () => {
  const s: Scenario = { id: "synthetic-null", tags: [], at: AT, turns: [{ text: "hi", expect: { reply: { includes: ["x"] } } }] };
  const out = await runScenario(s, { handler: fixedReply(null), brain: "fake" });
  assert.equal(out.status, "fail");
  assert.ok(out.turns[0]?.failures.some((f) => f.includes("expected a reply but got null")));
});

/* ------------------------------------------------------ the 86 scenarios */

const [handler, ready] = await Promise.all([defaultHandler(), readiness()]);

for (const s of ALL) {
  // Every non-`direct` scenario needs the real handler, full stop (D5/D6 are `direct` but still tagged
  // `requires: "v3-2"`, since sweep()'s claim/retry rewrite isn't wired yet either and the harness only
  // detects readiness per phase, not per file). `requires: "v3-3"` is an ADDITIONAL gate once the handler
  // exists (U5/U6 still need V3-2's handler to reach degraded mode at all) — see the identical logic in run.ts.
  const needsHandler = !s.direct;
  const requiresUnmet = s.requires === "v3-2" ? !handler : s.requires === "v3-3" ? !ready["v3-3"] : false;
  const skip = (needsHandler && !handler) || requiresUnmet;
  test(s.id, { skip: skip ? `${s.requires ?? "v3-2"} not wired yet` : false }, async () => {
    const out = await runScenario(s, { handler: s.direct ? unusedHandler : (handler as Handler), brain: "fake" });
    assert.equal(out.status, "pass", out.turns.flatMap((t, i) => t.failures.map((f) => `turn ${i + 1}: ${f}`)).join(" | "));
  });
}
