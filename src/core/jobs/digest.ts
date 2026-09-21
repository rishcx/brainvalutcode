// Deterministic digest facts (renderDigest is the only fact source), optionally narrated
// by the brain. With no brain, or a deterministic fallback, the output is exactly the facts.
import { digestPrompt } from "../brain/prompts.ts";
import { renderDigest } from "../render/digest.ts";
import { renderInvolvementDigestSection } from "../render/involvement.ts";
import { readInvolvementSnapshot } from "../sources/involvement.ts";
import { renderTasksDigestSection } from "../tasks/index.ts";
import { githubSnapshot, milestoneDeadlines } from "./github.ts";
import { upsertAndMaterialise } from "../reminders/engine.ts";
import { localDate } from "../time.ts";
import type { AgentContext, JobSpec } from "../types.ts";

/** Returns the narrated document, or null when the deterministic one should be written as-is. */
async function narrate(ctx: AgentContext, content: string): Promise<string | null> {
  if (!ctx.brain) return null;
  const end = content.indexOf("\n---\n", 4); // closes the frontmatter block
  if (!content.startsWith("---\n") || end < 0) return null;
  const head = content.slice(0, end + 5);
  const body = content.slice(end + 5);
  try {
    const p = digestPrompt(body);
    const r = await ctx.brain.complete({ ...p });
    const prose = r.text.replace(/<\s*\/?\s*FACTS\s*>/gi, "").replace(/\s+/g, " ").trim().slice(0, 1500);
    if (r.entry === "deterministic" || !prose) return null;
    const model = /^[\w.\-]+$/.test(r.entry) ? r.entry : "llm";
    const title = body.match(/^\n# .*\n\n/);
    if (!title) return null;
    return (
      head.replace(/^model: .*$/m, `model: ${model}`) +
      title[0] +
      `${prose}\n\n` +
      body.slice(title[0].length)
    );
  } catch {
    return null;
  }
}

export const digestDaily: JobSpec = {
  name: "digest:daily",
  schedule: { dailyAtLocal: "08:00" },
  async run(ctx) {
    const gh = await githubSnapshot(ctx);
    await upsertAndMaterialise(ctx, milestoneDeadlines(gh, ctx));
    const path = `Digests/${localDate(ctx.clock)}.md`;
    const tasks = await renderTasksDigestSection(ctx);
    const digest = renderDigest(gh, await ctx.store.listDeadlines(), ctx.clock, tasks);
    const inv = renderInvolvementDigestSection(await readInvolvementSnapshot(ctx.store), ctx.config.github.involvement.maxPerBucket);
    const facts = inv ? `${digest}\n${inv}` : digest;
    const content = (await narrate(ctx, facts)) ?? facts;
    const changed = await ctx.vault.writeFiles(`digest ${localDate(ctx.clock)}`, [{ path, content }]);
    return `wrote ${path} changed=${changed.length}`;
  },
};
