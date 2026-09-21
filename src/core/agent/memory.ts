// Per-(channel, peer) day memory for PLAN (PLAN_V3 B.7): summary <= 400 + last 6 turns <= 1,200 chars.
// Summary refresh runs after the reply is built, only when un-summarised older text > 2,000 chars.
import { summarisePrompt } from "../brain/prompts.ts";
import { coveredKey, summaryKey, turnLine } from "../chat/memory.ts";
import { cut } from "../chat/text.ts";
import type { AgentContext, ChatTurn } from "../types.ts";
import type { Target } from "./contract.ts";

export const TAIL_TURNS = 6;
export const TAIL_CHARS = 1200;
export const SUMMARY_CHARS = 400;
export const REFRESH_ABOVE = 2000;
export const REFRESH_BUDGET_MS = 15_000;

/** Newest turns first until 1,200 chars, rendered oldest-first, with the (capped) summary on top. */
export function memoryBlock(turns: ChatTurn[], summary: string): string {
  const tail = turns.slice(-TAIL_TURNS);
  const lines: string[] = [];
  let used = 0;
  for (let i = tail.length - 1; i >= 0; i--) {
    const line = cut(turnLine(tail[i]!), 300);
    if (used + line.length + 1 > TAIL_CHARS) break;
    used += line.length + 1;
    lines.unshift(line);
  }
  const s = summary.trim() ? `Earlier today (summary): ${cut(summary.trim(), SUMMARY_CHARS)}` : "";
  return [s, ...lines].filter(Boolean).join("\n");
}

/** One summary call when needed; any failure keeps the old summary. Never throws. */
export async function refreshSummary(
  ctx: AgentContext,
  who: Target,
  date: string,
  turns: ChatTurn[],
  summary: string,
  elapsedMs: number,
): Promise<void> {
  try {
    if (!ctx.brain || elapsedMs > REFRESH_BUDGET_MS) return;
    const older = turns.slice(0, Math.max(0, turns.length - TAIL_TURNS));
    const size = (ts: ChatTurn[]): number => ts.reduce((n, t) => n + t.text.length, 0);
    if (size(older) <= REFRESH_ABOVE) return; // cheap bound: no kv read on the common path
    const covered = Number((await ctx.store.kvGet(coveredKey(who.channel, who.peer, date))) ?? "0") || 0;
    const fresh = older.slice(Math.min(covered, older.length));
    if (size(fresh) <= REFRESH_ABOVE) return;
    const transcript = [summary ? `Earlier summary: ${summary}` : "", ...fresh.map(turnLine)].filter(Boolean).join("\n");
    const p = summarisePrompt(cut(transcript, 6000), SUMMARY_CHARS);
    const r = await ctx.brain.complete({ ...p, maxTokens: 200, temperature: 0, cacheTtlMs: 0, purpose: "summary", timeoutMs: ctx.config.chat.perAttemptMs });
    const text = cut(r.text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim(), SUMMARY_CHARS);
    if (r.entry === "deterministic" || !text) return;
    const at = ctx.clock.now().toISOString();
    await ctx.store.kvSet(summaryKey(who.channel, who.peer, date), text, at);
    await ctx.store.kvSet(coveredKey(who.channel, who.peer, date), String(older.length), at);
  } catch {
    /* keep the old summary */
  }
}
