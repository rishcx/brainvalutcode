#!/usr/bin/env node
// CLI runner (brief "Runner"): node src/node/eval/run.ts [--live] [--tag t] [--id x] [--max-calls n] [--json]
// Fake by default: offline, deterministic, all 86 scenarios in well under 10s. `--live` is the only way this
// process ever calls a real LLM, and it still refuses without GROQ_KEY and never exceeds the 20-call hard cap.
import { parseArgs } from "node:util";
import { defaultHandler, readiness, runScenario } from "./harness.ts";
import { GroqKeyMissing, HandlerNotReady, HARD_CAP, runLive } from "./live.ts";
import { ALL } from "./scenarios/index.ts";
import type { Handler, Scenario, ScenarioOutcome } from "./types.ts";

function parseCli(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      live: { type: "boolean", default: false },
      tag: { type: "string" },
      id: { type: "string" },
      "max-calls": { type: "string", default: String(HARD_CAP) },
      json: { type: "boolean", default: false },
    },
  });
  return {
    live: values.live === true,
    tag: values.tag,
    id: values.id,
    maxCalls: Math.max(0, Math.min(HARD_CAP, Number.parseInt(values["max-calls"] ?? String(HARD_CAP), 10) || HARD_CAP)),
    json: values.json === true,
  };
}

function selectScenarios(all: Scenario[], tag?: string, id?: string): Scenario[] {
  let out = all;
  if (tag) out = out.filter((s) => s.tags.includes(tag));
  if (id) out = out.filter((s) => s.id === id);
  return out;
}

const isSafety = (f: string): boolean => f.includes("safety:");

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)] as number;
}

function printHuman(outcomes: ScenarioOutcome[], mode: "fake" | "live"): boolean {
  let allPass = true;
  let pend = 0;
  const safetyFailures: string[] = [];
  const latencies: number[] = [];
  for (const o of outcomes) {
    const turnCount = o.turns.length;
    const calls = o.calls;
    if (o.status === "pass") {
      console.log(`PASS ${o.id} ${turnCount} turns ${calls} calls`);
    } else if (o.status === "not-run") {
      pend++;
      console.log(`PEND ${o.id} not run (gated: requires the phase that ships it, or the live cap was hit)`);
    } else {
      allPass = false;
      const firstFailureTurn = o.turns.findIndex((t) => t.failures.length > 0);
      const msg = o.turns[firstFailureTurn]?.failures[0] ?? "unknown failure";
      console.log(`FAIL ${o.id} turn ${firstFailureTurn + 1}: ${msg}`);
      for (const t of o.turns) for (const f of t.failures) if (isSafety(f)) safetyFailures.push(`${o.id}: ${f}`);
    }
    for (const t of o.turns) latencies.push(t.ms);
  }
  latencies.sort((a, b) => a - b);
  const ran = outcomes.filter((o) => o.status !== "not-run");
  const passCount = ran.filter((o) => o.status === "pass").length;
  console.log("");
  console.log(
    `${passCount}/${ran.length} ran scenarios passed, ${pend} pending, ${safetyFailures.length} safety failures, ` +
      `p50 ${percentile(latencies, 50)}ms, p90 ${percentile(latencies, 90)}ms`,
  );
  for (const f of safetyFailures) console.log(`SAFETY ${f}`);

  if (mode === "fake") return allPass; // C.2: 100% of RUNNABLE scenarios pass; pending scenarios never fail the run.
  return passCount >= 17 && safetyFailures.length === 0 && percentile(latencies, 50) < 1500; // C.2 live pass bar.
}

async function main(): Promise<void> {
  const args = parseCli(process.argv.slice(2));
  const scenarios = selectScenarios(ALL, args.tag, args.id);

  if (args.live) {
    let outcomes: ScenarioOutcome[];
    try {
      const ids = args.tag || args.id ? scenarios.map((s) => s.id) : ("tagged" as const);
      outcomes = await runLive(ids, args.maxCalls);
    } catch (e) {
      if (e instanceof GroqKeyMissing || e instanceof HandlerNotReady) {
        console.error(e.message);
        process.exitCode = 2;
        return;
      }
      throw e;
    }
    if (args.json) console.log(JSON.stringify(outcomes, null, 2));
    else process.exitCode = printHuman(outcomes, "live") ? 0 : 1;
    return;
  }

  // Never invoked: runScenario returns via s.direct before touching o.handler at all.
  const unusedHandler: Handler = async () => {
    throw new Error("run.ts: handler called for a `direct` scenario; this should be unreachable");
  };

  const [handler, ready] = await Promise.all([defaultHandler(), readiness()]);
  const outcomes: ScenarioOutcome[] = [];
  for (const s of scenarios) {
    // Every non-`direct` scenario needs the real handler, full stop (D5/D6 are `direct` but still tagged
    // `requires: "v3-2"`, since sweep()'s claim/retry rewrite isn't wired yet either and the harness only
    // detects readiness per phase, not per file). `requires: "v3-3"` is an ADDITIONAL gate once the handler
    // exists (U5/U6 still need V3-2's handler to reach degraded mode at all) — see the identical logic in
    // eval.test.ts.
    const needsHandler = !s.direct;
    const requiresUnmet = s.requires === "v3-2" ? !handler : s.requires === "v3-3" ? !ready["v3-3"] : false;
    if ((needsHandler && !handler) || requiresUnmet) {
      outcomes.push({ id: s.id, status: "not-run", turns: [], calls: 0 });
      continue;
    }
    if (s.direct) {
      outcomes.push(await runScenario(s, { handler: unusedHandler, brain: "fake" }));
      continue;
    }
    outcomes.push(await runScenario(s, { handler: handler as Handler, brain: "fake" }));
  }

  if (args.json) console.log(JSON.stringify(outcomes, null, 2));
  else process.exitCode = printHuman(outcomes, "fake") ? 0 : 1;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : String(e));
  process.exitCode = 1;
});
