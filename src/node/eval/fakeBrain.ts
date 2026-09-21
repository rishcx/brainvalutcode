// Fake mode's Brain: answers a scripted PLAN/COMPOSE/SUMMARY per turn (brief "Fake brain").
import type { Brain, BrainRequest, BrainResult } from "../../core/types.ts";
import type { Turn } from "./types.ts";

const render = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));

const deterministic = (): BrainResult => ({ text: "", entry: "deterministic", model: "fake", cached: false, ms: 0 });
const ok = (text: string): BrainResult => ({ text, entry: "fake", model: "scripted", cached: false, ms: 0 });

/**
 * `turn` is a thunk the harness updates to "the turn currently in flight" before each handler call, so one
 * Brain instance serves a whole scenario. `plan`/`compose` scripts are per-purpose; an array `plan` is
 * consumed one element per successive "plan" call within the SAME turn (retry tests), reset when the turn
 * the thunk returns changes identity. A call the current turn did not script gets `{ entry: "deterministic",
 * text: "" }` and is recorded in `failures` as `unexpected LLM call (<purpose>)`.
 */
export function scriptedBrain(turn: () => Turn): Brain & { calls: BrainRequest[]; failures: string[] } {
  const calls: BrainRequest[] = [];
  const failures: string[] = [];
  let lastTurn: Turn | null = null;
  let planIdx = 0;

  const complete = async (req: BrainRequest): Promise<BrainResult> => {
    calls.push(req);
    const t = turn();
    if (t !== lastTurn) {
      lastTurn = t;
      planIdx = 0;
    }
    const purpose = req.purpose ?? "other";
    if (purpose === "plan") {
      if (t.plan === undefined) {
        failures.push(`unexpected LLM call (plan)`);
        return deterministic();
      }
      if (Array.isArray(t.plan)) {
        const item = t.plan[Math.min(planIdx, t.plan.length - 1)];
        planIdx++;
        return ok(render(item));
      }
      return ok(render(t.plan));
    }
    if (purpose === "compose") {
      if (t.compose === undefined) {
        failures.push(`unexpected LLM call (compose)`);
        return deterministic();
      }
      return ok(t.compose);
    }
    if (purpose === "summary") return ok("summary");
    failures.push(`unexpected LLM call (${purpose})`);
    return deterministic();
  };

  return Object.assign({ complete }, { calls, failures });
}
