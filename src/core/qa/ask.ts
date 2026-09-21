import { createBrain } from "../brain/chain.ts";
import { qaPrompt } from "../brain/prompts.ts";
import type { AgentContext } from "../types.ts";
import { retrieve, type Retrieved } from "./retrieve.ts";

export interface AskResult {
  answer: string;
  sources: string[];
  entry: string;
  cached: boolean;
  ms: number;
}

const factDump = (rs: Retrieved[]): string =>
  `No LLM available; the most relevant notes:\n\n${rs.map((r) => `${r.path}\n${r.excerpt}`).join("\n\n")}`;

export async function ask(ctx: AgentContext, question: string): Promise<AskResult> {
  const t0 = ctx.clock.now().getTime();
  const rs = await retrieve(ctx, question);
  const sources = rs.map((r) => r.path);
  if (rs.length === 0) {
    return { answer: "No matching notes found.", sources, entry: "deterministic", cached: false, ms: ctx.clock.now().getTime() - t0 };
  }
  const brain = ctx.brain ?? createBrain(ctx);
  const context = rs.map((r) => `### ${r.path}\n${r.excerpt}`).join("\n\n");
  const { system, prompt } = qaPrompt(question, context);
  const r = await brain.complete({ system, prompt, maxTokens: 600, temperature: 0.2 });
  return {
    answer: r.entry === "deterministic" ? factDump(rs) : r.text,
    sources,
    entry: r.entry,
    cached: r.cached,
    ms: ctx.clock.now().getTime() - t0,
  };
}
