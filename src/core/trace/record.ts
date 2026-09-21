// Per-message trace lifecycle (PLAN_V3 B.8): begin once, accumulate stage timings and LLM calls as the
// handler runs, finish once (never throws — a trace write failure must never block a reply or a delivery).
import { cut, redactSecrets } from "../chat/text.ts";
import { localDateOf } from "../time.ts";
import type { AgentContext, Brain, NewTrace, TraceDraft, TraceKind } from "../types.ts";

/** Starts a draft for one inbound message or one reminder delivery. Caller mutates route/intent/etc as it learns them. */
export function beginTrace(
  ctx: AgentContext,
  who: { channel: string; peer: string },
  kind: TraceKind,
  msgKey: string | null,
): TraceDraft & { t0: number } {
  const now = ctx.clock.now();
  return {
    at: now.toISOString(),
    localDate: localDateOf(now, ctx.clock.tz),
    kind,
    channel: who.channel,
    peer: who.peer,
    msgKey,
    route: "dropped",
    intent: null,
    toolsJson: null,
    llmCalls: 0,
    model: null,
    provider: null,
    replyChars: 0,
    replyPreview: null,
    stagesJson: null,
    flags: null,
    error: null,
    stages: {},
    t0: performance.now(),
  };
}

/** Runs `fn`, adding its wall time (ms) to `d.stages[stage]`. The clock may be frozen, so this uses performance.now(). */
export async function timed<T>(d: TraceDraft, stage: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  const cur = d as TraceDraft & { current?: string };
  cur.current = stage; // read by the Worker's watchdog: names the stage that was running when a message hung
  try {
    return await fn();
  } finally {
    d.stages[stage] = (d.stages[stage] ?? 0) + Math.round(performance.now() - t0);
    if (cur.current === stage) cur.current = undefined;
  }
}

/** Wraps a Brain so every `complete()` call counts toward the trace's llmCalls/model/provider/"llm" stage. */
export function instrumentBrain(brain: Brain, d: TraceDraft): Brain {
  return {
    async complete(req) {
      const t0 = performance.now();
      try {
        const res = await brain.complete(req);
        d.model = res.model;
        d.provider = res.entry;
        return res;
      } finally {
        d.stages.llm = (d.stages.llm ?? 0) + Math.round(performance.now() - t0);
        d.llmCalls++;
      }
    },
  };
}

/** Redacted, whitespace-collapsed, <= 160 chars: what msg_trace.reply_preview stores. */
export function preview(text: string): string {
  return cut(redactSecrets(text).replace(/\s+/g, " ").trim(), 160);
}

/**
 * Never throws. Computes latencyMs from d.t0 (performance.now(), immune to a frozen wall clock), redacts and
 * caps every free-text field, and appends the row. A store failure here must never surface to the caller.
 */
export async function finishTrace(
  ctx: AgentContext,
  d: TraceDraft & { t0: number },
  delivery: string,
  error?: string,
): Promise<void> {
  try {
    const latencyMs = Math.max(0, Math.round(performance.now() - d.t0));
    const { t0: _t0, stages, ...rest } = d;
    const finalError = error !== undefined ? error : rest.error;
    const row: NewTrace = {
      ...rest,
      delivery: cut(redactSecrets(delivery), 140),
      latencyMs,
      stagesJson: Object.keys(stages).length ? JSON.stringify(stages) : null,
      replyPreview: rest.replyPreview !== null ? cut(redactSecrets(rest.replyPreview), 160) : null,
      toolsJson: rest.toolsJson !== null ? cut(redactSecrets(rest.toolsJson), 1000) : null,
      error: finalError !== null && finalError !== undefined ? cut(redactSecrets(finalError), 300) : null,
    };
    await ctx.store.appendTrace(row);
  } catch {
    /* a trace write failure never blocks the reply or the delivery */
  }
}
