import { summarisePrompt } from "../brain/prompts.ts";
import { retrieveFromIndex } from "../index/search.ts";
import { retrieve, tokenize } from "../qa/retrieve.ts";
import type { AgentContext, ChatTurn, InboundMessage } from "../types.ts";
import { buildContext } from "./context.ts";
import { deterministicReply, NO_FACTS_DOWN } from "./fallback.ts";
import { coveredKey, recordTurn, splitTurns, summaryKey, turnLine } from "./memory.ts";
import { baseSnapshot, buildSnapshot, type Snapshot } from "./snapshot.ts";
import { cap, cut, redactSecrets } from "./text.ts";
import { executeActions, parseModelOutput } from "./actions.ts";
import { formatChat } from "./format.ts";
import { localDate } from "../time.ts";

export const EMPTY_HINT = "Ask me about your deadlines, tasks or GitHub.";
const SUBREQUEST_GUARD = 35;

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

async function loadNotes(ctx: AgentContext, cmdText: string): Promise<{ path: string; excerpt: string }[]> {
  if (tokenize(cmdText).length === 0) return [];
  // Worker: never fall back to reading the vault (subrequests); an empty index means no notes.
  const found = ctx.runtime === "worker" ? ((await retrieveFromIndex(ctx, cmdText)) ?? []) : await retrieve(ctx, cmdText);
  return found.map((r) => ({ path: r.path, excerpt: r.excerpt }));
}

// Wall-clock guards. On the Worker the reply must be finished well inside the ~30 s the runtime allows after the webhook
// has been acknowledged, and the model chain may spend its whole per-call budget on ONE attempt. So: retry only after a
// FAST failure (e.g. every free model answered 429 within seconds), and never let the optional summarising call delay a reply.
// v3: the chain itself now bounds each attempt (chat.perAttemptMs) and moves on to the next model on its own, so the
// extra fixed sleep here would only slow an already-bounded retry down further.
const RETRY_ONLY_IF_ELAPSED_UNDER_MS = 5_000;
const SUMMARISE_ONLY_IF_ELAPSED_UNDER_MS = 12_000;
const nowMs = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());

// Some free models "think out loud" instead of answering ("We need to output JSON ... The user asks ..."). That text must
// never reach the user: it counts as a failed attempt (retried, else the friendly fallback). Reasoning blocks are removed.
const REASONING_LEAK =
  /\b(we need to (output|produce|respond|craft|write|reply)|the user (asks|is asking|says|wants|wrote)|output json|according to (the )?(style|instructions|rules|guide)|let'?s (craft|compose|draft|write)|as per the (style|instructions))\b/i;
const stripThinking = (t: string): string => t.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "").trim();
// A router can hand the prompt to a moderation model whose whole output is a verdict ("User Safety: safe").
const CLASSIFIER_OUTPUT = /^\s*(?:(?:user|assistant|agent|content|response)\s+)?safety\s*:|^\s*(?:safe|unsafe)\s*(?:\n|$)/i;
export const looksLikeReasoningLeak = (t: string): boolean => !/^\s*[{\[]/.test(t) && (REASONING_LEAK.test(t) || CLASSIFIER_OUTPUT.test(t));

/** Folds the uncovered older turns into the day summary. Only after a good answer; failure keeps the old summary. */
async function maybeSummarise(ctx: AgentContext, msg: InboundMessage, older: ChatTurn[], summary: string, covered: number, today: string): Promise<void> {
  const brain = ctx.brain;
  const m = ctx.config.chat.memory;
  if (!brain || (ctx.requestCount?.() ?? 0) > SUBREQUEST_GUARD) return;
  const fresh = older.slice(Math.min(covered, older.length));
  if (fresh.reduce((n, t) => n + t.text.length, 0) <= m.summariseAboveChars) return;
  try {
    const transcript = [summary ? `Earlier summary: ${summary}` : "", ...fresh.map(turnLine)].filter(Boolean).join("\n");
    const p = summarisePrompt(transcript, m.summaryChars);
    const r = await brain.complete({ system: p.system, prompt: p.prompt, maxTokens: 300, cacheTtlMs: 0, purpose: "summary" });
    const text = cut(r.text.trim(), m.summaryChars);
    if (!text || r.entry === "deterministic") return;
    const at = ctx.clock.now().toISOString();
    await ctx.store.kvSet(summaryKey(msg.channel, msg.from, today), text, at);
    await ctx.store.kvSet(coveredKey(msg.channel, msg.from, today), String(older.length), at);
  } catch {
    /* keep the old summary; the oldest turns simply fall out of context */
  }
}

async function answer(ctx: AgentContext, msg: InboundMessage, cmdText: string): Promise<string> {
  if (cmdText.trim() === "") return EMPTY_HINT;
  const today = localDate(ctx.clock);
  const snap: Snapshot = await safe(() => buildSnapshot(ctx), baseSnapshot(ctx));
  const turns = await safe(() => ctx.store.turnsForDay(msg.channel, msg.from, today), [] as ChatTurn[]);
  const summary = (await safe(() => ctx.store.kvGet(summaryKey(msg.channel, msg.from, today)), null)) ?? "";
  const covered = Number((await safe(() => ctx.store.kvGet(coveredKey(msg.channel, msg.from, today)), null)) ?? "0") || 0;
  const notes = await safe(() => loadNotes(ctx, cmdText), []);

  await recordTurn(ctx, msg, "user", cmdText);

  const reply = async (text: string): Promise<string> => {
    const out = formatChat(redactSecrets(text), msg.channel) || NO_FACTS_DOWN;
    await recordTurn(ctx, msg, "assistant", out);
    return out;
  };

  if (!ctx.brain) return reply(deterministicReply(snap, { llmDown: false }));

  const built = buildContext(ctx, msg, cmdText, snap, turns, summary, notes);
  let raw = "";
  const t0 = nowMs();
  for (let attempt = 0; attempt < 2 && raw === ""; attempt++) {
    if (attempt > 0 && nowMs() - t0 > RETRY_ONLY_IF_ELAPSED_UNDER_MS) break; // the first attempt was slow: no time for a second
    try {
      const r = await ctx.brain.complete({
        system: built.prompt.system,
        prompt: built.prompt.prompt,
        maxTokens: ctx.config.chat.maxReplyTokens,
        cacheTtlMs: 0,
        purpose: "compose",
        timeoutMs: ctx.config.chat.perAttemptMs,
      });
      if (r.entry !== "deterministic") raw = stripThinking(r.text);
      if (raw !== "" && looksLikeReasoningLeak(raw)) raw = ""; // a failed attempt, not an answer
    } catch {
      raw = "";
    }
  }
  if (raw === "") return reply(deterministicReply(snap, { llmDown: true }));

  const parsed = parseModelOutput(raw);
  const lines = await safe(() => executeActions(ctx, msg, cmdText, parsed.actions), [] as string[]);
  const text = formatChat(redactSecrets(parsed.reply.replace(/^\s*Brain:\s*/i, "")), msg.channel);
  const final = [text, lines.join("\n")].filter(Boolean).join("\n\n") || deterministicReply(snap, { llmDown: false });
  const out = await reply(final);
  if (built.needsSummary && nowMs() - t0 < SUMMARISE_ONLY_IF_ELAPSED_UNDER_MS) {
    const { older } = splitTurns(turns, ctx.config.chat.memory.verbatimChars);
    await maybeSummarise(ctx, msg, older, summary, covered, today);
  }
  return out;
}

/** Never throws, never returns "" or an error string.  */
export async function respond(ctx: AgentContext, msg: InboundMessage, cmdText: string): Promise<string> {
  try {
    return (await answer(ctx, msg, cmdText)) || NO_FACTS_DOWN;
  } catch {
    return NO_FACTS_DOWN;
  }
}
