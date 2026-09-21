// Ordered fallback chain. The local-gateway guard lives in chainFor(); never filter here.
import { chainFor } from "../config.ts";
import type { AgentContext, Brain, BrainRequest, BrainResult } from "../types.ts";
import { cacheKey } from "./cache.ts";
import { DeterministicBrain } from "./deterministic.ts";
import { LlmError, openAiCompat } from "./openaiCompat.ts";
import { canUse, extraBodyFor, loadUsage, recordCall } from "./usage.ts";

const parses = (t: string): boolean => {
  try {
    JSON.parse(t);
    return true;
  } catch {
    return false;
  }
};

/** v3: chat purposes share the chat-specific (fast) budgets; everything else keeps the general brain budget. */
const isChatPurpose = (p: BrainRequest["purpose"]): boolean => p === "plan" || p === "compose" || p === "summary";

const noExtraKey = (entry: string, model: string): string => `brain:noextra:${entry}:${model}`;
// The flag is an expiry instant, not a permanent "1": one bad 400 must not disable the speed settings forever.
const NO_EXTRA_TTL_MS = 24 * 3_600_000;

export function createBrain(ctx: AgentContext, opts: { allowLocalGateway?: boolean } = {}): Brain {
  const allowLocalGateway = opts.allowLocalGateway ?? ctx.runtime === "cli";
  const floor = new DeterministicBrain(ctx);

  async function run(req: BrainRequest): Promise<BrainResult> {
    const t0 = ctx.clock.now().getTime();
    // performance.now() is monotonic wall time; the injected clock may be frozen in tests.
    const start = performance.now();
    const budget = isChatPurpose(req.purpose) ? ctx.config.chat.llmBudgetMs : ctx.config.brain.budgetMs;
    const remaining = (): number => budget - (performance.now() - start);
    const ttl = req.cacheTtlMs ?? ctx.config.brain.cacheTtlMs;
    // One slow or hung model must not eat the whole budget and starve the ones behind it: each attempt gets a share
    // and a timeout moves on to the NEXT model instead of retrying the same one (except the 500/badParam cases below).
    const perAttemptMs =
      req.timeoutMs ?? (isChatPurpose(req.purpose) ? ctx.config.chat.perAttemptMs : Math.max(2000, Math.floor(budget / 3)));

    const usage = await loadUsage(ctx).catch(() => ({ day: "", rows: [] }));

    for (const entry of chainFor(ctx.config, { allowLocalGateway })) {
      if (entry.kind === "deterministic" || !entry.baseUrl) continue;
      if (entry.purposes && !entry.purposes.includes(req.purpose ?? "")) continue; // e.g. a paid model reserved for answer-writing
      const apiKey = entry.keyEnv ? ctx.env(entry.keyEnv) : "none";
      if (!apiKey) continue; // skipped: no key configured

      for (const model of entry.models) {
        if (remaining() <= 0) return floor.complete(req);

        const use = canUse(usage, entry, model, ctx.config, ctx.clock.now());
        if (!use.ok) continue; // on cooldown, exhausted, or over the daily budget: skip, no request

        const key = ttl > 0 ? await cacheKey(entry.name, model, req) : "";
        if (ttl > 0) {
          const hit = await ctx.store.cacheGet(key, ctx.clock.now().toISOString());
          if (hit !== null) {
            return { text: hit, entry: entry.name, model, cached: true, ms: ctx.clock.now().getTime() - t0 };
          }
        }

        const flag = await ctx.store.kvGet(noExtraKey(entry.name, model)).catch(() => null);
        let dropExtra = flag !== null && flag !== "" && (flag === "1" || Date.parse(flag) > ctx.clock.now().getTime());

        for (let attempt = 0; attempt < 2; attempt++) {
          const left = remaining();
          if (left <= 0) return floor.complete(req);
          const sendExtra = !dropExtra;
          try {
            const r = await openAiCompat(
              {
                baseUrl: entry.baseUrl,
                apiKey,
                model,
                fetch: ctx.fetch,
                prompt: req.prompt,
                system: req.system,
                maxTokens: req.maxTokens,
                temperature: req.temperature,
                jsonSchema: req.jsonSchema,
                responseFormat: entry.jsonMode && sendExtra ? req.responseFormat : undefined,
                extraBody: sendExtra ? extraBodyFor(entry, model) : undefined,
                signal: AbortSignal.timeout(Math.ceil(Math.min(left, perAttemptMs))),
              },
              ctx.clock.now(),
            );
            await recordCall(ctx, entry.name, model, { ok: true, status: 200, usage: r.usage, rate: r.rate });
            if (req.jsonSchema !== undefined && !parses(r.text)) break; // next model
            if (ttl > 0) {
              const exp = new Date(ctx.clock.now().getTime() + ttl).toISOString();
              await ctx.store.cacheSet(key, r.text, exp).catch(() => undefined);
            }
            return { text: r.text, entry: entry.name, model, cached: false, ms: ctx.clock.now().getTime() - t0, usage: r.usage, rate: r.rate };
          } catch (e) {
            const status = e instanceof LlmError ? e.status : 0;
            const rate = e instanceof LlmError ? e.rate : undefined;
            await recordCall(ctx, entry.name, model, { ok: false, status, rate });
            if (e instanceof LlmError && e.badParam && sendExtra) {
              // A wrong guess at reasoning/JSON-mode params costs one extra call, once: retry the same model without
              // them, and remember it so the NEXT call to this model skips them from the start.
              dropExtra = true;
              await ctx.store
                .kvSet(noExtraKey(entry.name, model), new Date(ctx.clock.now().getTime() + NO_EXTRA_TTL_MS).toISOString(), ctx.clock.now().toISOString())
                .catch(() => undefined);
              continue;
            }
            // Retry the same model once only for a transient server error (5xx). A timeout or a 429 (free models are
            // rate-limited in bursts) will not improve in the next few milliseconds: go to the next model.
            if (e instanceof LlmError && e.status >= 500 && attempt === 0) continue;
            break;
          }
        }
      }
    }
    return floor.complete(req);
  }

  return {
    async complete(req: BrainRequest): Promise<BrainResult> {
      try {
        return await run(req);
      } catch {
        return floor.complete(req);
      }
    },
  };
}
