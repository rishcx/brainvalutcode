import assert from "node:assert/strict";
import { test } from "node:test";
import { testContext } from "../../node/testing/context.ts";
import type { AgentContext } from "../types.ts";
import { createBrain } from "./chain.ts";

const ok = (text: string): Response =>
  new Response(JSON.stringify({ choices: [{ message: { content: text } }], model: "m" }), { status: 200, headers: { "content-type": "application/json" } });

function ctxWith(models: string[], budgetMs: number, handler: (model: string, signal: AbortSignal | null | undefined) => Promise<Response>) {
  const calls: string[] = [];
  const ctx: AgentContext = testContext({
    configPatch: { brain: { budgetMs, entries: [{ kind: "openrouter", name: "or", baseUrl: "https://llm.example/v1", keyEnv: "K", local: false, models }] } },
    env: (n) => (n === "K" ? "key" : undefined),
    runtime: "worker",
    fetch: async (_u, init) => {
      const model = JSON.parse(String(init?.body)).model as string;
      calls.push(model);
      return handler(model, init?.signal);
    },
  });
  return { ctx, calls };
}

// A fetch that never answers until its abort signal fires, like a hung free model.
const hang = (signal: AbortSignal | null | undefined): Promise<Response> =>
  new Promise((_, reject) => signal?.addEventListener("abort", () => reject(Object.assign(new Error("timeout"), { name: "TimeoutError" }))));

test("a hung first model is abandoned after its share of the budget and the next model still gets a turn", async () => {
  const { ctx, calls } = ctxWith(["slow", "fast"], 3000, (m, s) => (m === "slow" ? hang(s) : Promise.resolve(ok("hello"))));
  const t0 = Date.now();
  const r = await createBrain(ctx).complete({ prompt: "hi", cacheTtlMs: 0 });
  assert.equal(r.model, "fast");
  assert.equal(r.text, "hello");
  assert.deepEqual(calls, ["slow", "fast"]); // the slow model was NOT retried
  assert.ok(Date.now() - t0 < 3500, "finished inside the whole budget");
});

test("a 429 moves straight on to the next model (no same-model retry); a 500 is retried once", async () => {
  const a = ctxWith(["limited", "next"], 5000, (m) => Promise.resolve(m === "limited" ? new Response("{}", { status: 429 }) : ok("fine")));
  assert.equal((await createBrain(a.ctx).complete({ prompt: "x", cacheTtlMs: 0 })).model, "next");
  assert.deepEqual(a.calls, ["limited", "next"]);

  let n = 0;
  const b = ctxWith(["flaky", "next"], 5000, () => Promise.resolve(++n === 1 ? new Response("{}", { status: 503 }) : ok("recovered")));
  const r = await createBrain(b.ctx).complete({ prompt: "x", cacheTtlMs: 0 });
  assert.equal(r.model, "flaky"); // second attempt on the same model succeeded
  assert.deepEqual(b.calls, ["flaky", "flaky"]);
});
