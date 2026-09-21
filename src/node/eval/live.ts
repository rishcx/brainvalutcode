// Opt-in live mode: the `live`-tagged scenarios (or an explicit id list) against the real Groq chain, hard
// capped at 20 LLM calls total. Never imported by eval.test.ts's default run, never reached without --live on
// the CLI, and GROQ_KEY is read only inside runLive() at call time (never at import time) so merely importing
// this file is safe.
import { createBrain } from "../../core/brain/chain.ts";
import { DEFAULT_BRAIN_ENTRIES } from "../../core/config.ts";
import type { AgentContext, Brain, BrainRequest, BrainResult } from "../../core/types.ts";
import { defaultHandler, runScenario } from "./harness.ts";
import { ALL } from "./scenarios/index.ts";
import type { Handler, ScenarioOutcome } from "./types.ts";

export const HARD_CAP = 20;

/** Never above HARD_CAP regardless of what run.ts's --max-calls passes. */
export function clampCalls(n: number): number {
  return Math.max(0, Math.min(HARD_CAP, n));
}

export class GroqKeyMissing extends Error {
  constructor() {
    super('GROQ_KEY is not set. Run with: GROQ_KEY=<your key> npm run eval -- --live (or put it in .env).');
  }
}

export class HandlerNotReady extends Error {
  constructor() {
    super("live mode needs handleInboundV3 (V3-2), which is not exported yet.");
  }
}

/** A Brain that counts every complete() into `.calls` (same shape scriptedBrain exposes, so harness.ts's
 * llmCalls diffing works unchanged) and shares one budget across the whole live run. */
function countingBrain(real: Brain, budget: { used: number; cap: number }): Brain & { calls: BrainRequest[] } {
  const calls: BrainRequest[] = [];
  const complete = async (req: BrainRequest): Promise<BrainResult> => {
    calls.push(req);
    budget.used++;
    return real.complete(req);
  };
  return Object.assign({ complete }, { calls });
}

/**
 * Runs `ids` (or every scenario tagged "live" when `ids === "tagged"`) against Groq, capped at
 * `min(maxCalls, HARD_CAP)` LLM calls total. Config carries only the groq entry + the deterministic floor
 * (never openrouter, never the local gateway) and runtime "worker". Scripts are ignored; scoring uses
 * `<=` for llmCalls. Refuses to start without GROQ_KEY or without V3-2's handler.
 */
export async function runLive(
  ids: string[] | "tagged",
  maxCalls: number,
  /** Test seam: lets eval.test.ts prove the not-ready refusal now that V3-2 has landed, without the network. */
  loadHandler: () => Promise<Handler | null> = defaultHandler,
): Promise<ScenarioOutcome[]> {
  const groqKey = process.env.GROQ_KEY;
  if (!groqKey) throw new GroqKeyMissing();
  const handler = await loadHandler();
  if (!handler) throw new HandlerNotReady();
  const cap = clampCalls(maxCalls);

  const groqEntry = DEFAULT_BRAIN_ENTRIES.find((e) => e.kind === "groq");
  const deterministicEntry = DEFAULT_BRAIN_ENTRIES.find((e) => e.kind === "deterministic");
  if (!groqEntry || !deterministicEntry) throw new Error("live.ts: groq/deterministic entries missing from config defaults");

  const toRun = ids === "tagged" ? ALL.filter((s) => s.tags.includes("live")) : ALL.filter((s) => ids.includes(s.id));

  const budget = { used: 0, cap };
  const outcomes: ScenarioOutcome[] = [];
  for (const s of toRun) {
    if (budget.used >= cap) {
      outcomes.push({ id: s.id, status: "not-run", turns: [], calls: 0 });
      continue;
    }
    const remaining = cap - budget.used;
    const out = await runScenario(s, {
      handler,
      brain: (ctx: AgentContext) => countingBrain(createBrain(ctx, { allowLocalGateway: false }), budget),
      maxCalls: remaining,
      fetch: globalThis.fetch,
      env: (name: string) => (name === "GROQ_KEY" ? groqKey : undefined),
      runtime: "worker",
      configPatch: { brain: { entries: [groqEntry, deterministicEntry] } },
    });
    outcomes.push(out);
  }
  return outcomes;
}
