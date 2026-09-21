import type { AgentContext, Brain, BrainRequest, BrainResult } from "../types.ts";

const BLOCK = /<FACTS>\n?([\s\S]*?)\n?<\/FACTS>/g;

/** The floor of the chain: no network, never throws, returns the facts it was handed. */
export class DeterministicBrain implements Brain {
  private readonly ctx: AgentContext;
  constructor(ctx: AgentContext) {
    this.ctx = ctx;
  }

  async complete(req: BrainRequest): Promise<BrainResult> {
    const started = this.ctx.clock.now().getTime();
    let text: string;
    try {
      const blocks = [...req.prompt.matchAll(BLOCK)].map((m) => (m[1] ?? "").trim());
      // Prompts put the payload (notes / digest facts) in the last block.
      const facts = blocks.at(-1);
      text = facts ? `No LLM available; the raw facts:\n${facts}` : req.prompt.slice(0, 500);
    } catch {
      text = req.prompt.slice(0, 500);
    }
    return { text, entry: "deterministic", model: "none", cached: false, ms: this.ctx.clock.now().getTime() - started };
  }
}
