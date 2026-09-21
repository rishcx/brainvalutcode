import { localDate } from "../time.ts";
import type { AgentContext, ChannelId, ChatTurn, InboundMessage } from "../types.ts";
import { cap, cleanText } from "./text.ts";

export const MAX_STORED_TURN = 2000;

export const summaryKey = (channel: ChannelId, peer: string, date: string): string => `chat:sum:${channel}:${peer}:${date}`;
/** Count of older turns already folded into the summary. */
export const coveredKey = (channel: ChannelId, peer: string, date: string): string => `chat:sumN:${channel}:${peer}:${date}`;

/** Stamps localDate from the clock at append time. A failed write never blocks the reply. */
export async function recordTurn(
  ctx: AgentContext,
  msg: Pick<InboundMessage, "channel" | "from">,
  role: "user" | "assistant",
  text: string,
): Promise<void> {
  try {
    const t = cap(cleanText(text), MAX_STORED_TURN);
    if (!t) return;
    await ctx.store.appendTurn({
      channel: msg.channel,
      peer: msg.from,
      localDate: localDate(ctx.clock),
      role,
      text: t,
      at: ctx.clock.now().toISOString(),
    });
  } catch {
    /* memory degrades, chat does not */
  }
}

/** Newest-first while cumulative (text + 6) fits; tail is chronological, older is the rest. */
export function splitTurns(turns: ChatTurn[], verbatimChars: number): { tail: ChatTurn[]; older: ChatTurn[] } {
  let used = 0;
  let i = turns.length;
  while (i > 0) {
    const cost = (turns[i - 1]?.text.length ?? 0) + 6;
    if (used + cost > verbatimChars) break;
    used += cost;
    i--;
  }
  return { tail: turns.slice(i), older: turns.slice(0, i) };
}

export const turnLine = (t: ChatTurn): string => `${t.role === "user" ? "You" : "Brain"}: ${cap(cleanText(t.text), 600)}`;
