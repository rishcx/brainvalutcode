import type { Retrieved } from "../qa/retrieve.ts";
import type { AgentContext } from "../types.ts";
import { tokenize } from "./tokens.ts";

const DATE_NAME = /(\d{4}-\d{2}-\d{2})/;

/** Ranks from D1 only: 0 vault calls, 0 fetches, 2 D1 queries. null = index empty, caller runs the v1 path. */
export async function retrieveFromIndex(ctx: AgentContext, question: string): Promise<Retrieved[] | null> {
  const q = [...new Set(tokenize(question))];
  if (q.length === 0) return [];
  const all = await ctx.store.listNoteIndex();
  if (all.length === 0) return null;

  const scored: { path: string; score: number; date: string }[] = [];
  for (const n of all) {
    const name = new Set(tokenize(`${n.path} ${n.title}`));
    const body = new Set(n.tokens.split(" "));
    let score = 0;
    for (const t of q) {
      if (name.has(t)) score += 3;
      if (body.has(t)) score += 1;
    }
    if (score > 0) scored.push({ path: n.path, score, date: DATE_NAME.exec(n.path)?.[1] ?? "" });
  }
  scored.sort((a, b) => b.score - a.score || (a.date === b.date ? 0 : a.date < b.date ? 1 : -1) || (a.path < b.path ? -1 : 1));
  const top = scored.slice(0, ctx.config.qa.maxNotes);
  if (top.length === 0) return [];

  const rows = new Map((await ctx.store.getNoteExcerpts(top.map((t) => t.path))).map((r) => [r.path, r.excerpt]));
  const per = Math.max(80, Math.floor(ctx.config.qa.maxChars / top.length));
  let budget = ctx.config.qa.maxChars;
  const out: Retrieved[] = [];
  for (const n of top) {
    if (budget <= 0) break;
    const raw = rows.get(n.path);
    if (raw === undefined) continue;
    const excerpt = raw.slice(0, Math.min(per, budget));
    budget -= excerpt.length;
    out.push({ path: n.path, score: n.score, excerpt });
  }
  return out;
}
