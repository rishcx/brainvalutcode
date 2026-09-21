import type { Prompt } from "../brain/prompts.ts";
import { buildChatPrompt } from "./prompt.ts";
import { safeText } from "../render/involvement.ts";
import type { AgentContext, ChatTurn, InboundMessage } from "../types.ts";
import { splitTurns, turnLine } from "./memory.ts";
import { renderSnapshot, type Snapshot } from "./snapshot.ts";
import { cap, cleanText, cut } from "./text.ts";

export interface BuiltContext {
  prompt: Prompt;
  chars: number;
  usedSummary: boolean;
  /** Upper bound (ignores what the kv "covered" counter already folded in); respond refines it. */
  needsSummary: boolean;
}

const OVERHEAD = 200; // block labels and fences

function formatNotes(notes: { path: string; excerpt: string }[], max: number): string {
  const out: string[] = [];
  let used = 0;
  for (const n of notes) {
    // Excerpts are DATA: cleaned here, delimiter-neutralised by fence() in chatPrompt.
    const l = `[${safeText(n.path, 100)}] ${cleanText(n.excerpt).replace(/\s+/g, " ")}`;
    const room = max - used;
    if (room <= 20) break;
    const piece = cut(l, room);
    out.push(piece);
    used += piece.length + 1;
  }
  return out.join("\n");
}

export function buildContext(
  ctx: AgentContext,
  _msg: InboundMessage,
  cmdText: string,
  snap: Snapshot,
  turns: ChatTurn[],
  summary: string,
  notes: { path: string; excerpt: string }[],
): BuiltContext {
  const c = ctx.config.chat;
  const message = cap(cleanText(cmdText), c.context.userChars);
  const { tail, older } = splitTurns(turns, c.memory.verbatimChars);
  const sum = cut(cleanText(summary), c.memory.summaryChars);

  let noteBudget = c.context.notesChars;
  let snapBudget = c.context.snapshotChars;
  let sumText = sum;
  let tailLines = tail.map(turnLine);

  const build = (): Prompt =>
    buildChatPrompt({
      persona: c.persona,
      nowLocal: snap.nowLocal,
      tz: snap.tz,
      snapshot: renderSnapshot(snap, snapBudget),
      summary: sumText,
      transcript: tailLines.join("\n"),
      notes: formatNotes(notes, noteBudget),
      message,
    });

  let prompt = build();
  const caps = c.context.snapshotChars + c.memory.summaryChars + c.memory.verbatimChars + c.context.notesChars + c.context.userChars;
  const limit = prompt.system.length + caps + OVERHEAD;
  const size = (): number => prompt.system.length + prompt.prompt.length;
  // Trim order, bottom-up: notes, snapshot, summary, oldest tail turns. System and message are never trimmed.
  for (let guard = 0; size() > limit && guard < 1000; guard++) {
    const over = size() - limit;
    if (noteBudget > 0) noteBudget = Math.max(0, noteBudget - over);
    else if (snapBudget > 0) snapBudget = Math.max(0, snapBudget - over);
    else if (sumText) sumText = cut(sumText, Math.max(0, sumText.length - over));
    else if (tailLines.length) tailLines = tailLines.slice(1);
    else break;
    prompt = build();
  }

  const olderChars = older.reduce((n, t) => n + t.text.length, 0);
  return { prompt, chars: size(), usedSummary: sumText !== "", needsSummary: olderChars > c.memory.summariseAboveChars };
}
