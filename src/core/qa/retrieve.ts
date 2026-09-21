// Deterministic keyword retrieval over the vault. No embeddings.
import { retrieveFromIndex } from "../index/search.ts";
import type { AgentContext } from "../types.ts";

export interface Retrieved {
  path: string;
  score: number;
  excerpt: string;
}

const STOP = new Set(
  ("the and for are but not you all any can had her was one our out has have what when where which who whom why how " +
    "this that these those with from into about does did done will would should could there their them then than " +
    "been being were your mine its his she him too very just also over under again more most some such only own same " +
    "tell show give find note notes").split(" "),
);

export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => t.length >= 3 && !STOP.has(t));
}

const MAX_CANDIDATES = 300;
const DATE_NAME = /(\d{4}-\d{2}-\d{2})/;

function splitFrontmatter(text: string): { fm: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  return m ? { fm: m[1] ?? "", body: text.slice(m[0].length) } : { fm: "", body: text };
}

export async function retrieve(ctx: AgentContext, question: string): Promise<Retrieved[]> {
  const q = [...new Set(tokenize(question))];
  if (q.length === 0) return [];

  const indexed = await retrieveFromIndex(ctx, question); // null = index empty: the v1 path below runs unchanged
  if (indexed) return indexed;

  const paths = (await ctx.vault.listFiles()).filter((p) => p.toLowerCase().endsWith(".md"));
  // Cheap pre-rank by path so a huge vault does not mean thousands of reads.
  const pre = paths
    .map((p) => ({ p, s: tokenize(p).filter((t) => q.includes(t)).length }))
    .sort((a, b) => b.s - a.s || (a.p < b.p ? -1 : 1))
    .slice(0, MAX_CANDIDATES);

  const scored: { path: string; score: number; date: string; lines: string[]; best: number }[] = [];
  for (const { p } of pre) {
    const text = await ctx.vault.readFile(p);
    if (text === null) continue;
    const { fm, body } = splitFrontmatter(text);

    const title = /^#\s+(.+)$/m.exec(body)?.[1] ?? "";
    const nameToks = new Set(tokenize(`${p.replace(/\.md$/i, "")} ${title}`));
    const fmToks = new Set(tokenize(fm));
    const bodyToks = tokenize(body);
    const freq = new Map<string, number>();
    for (const t of bodyToks) freq.set(t, (freq.get(t) ?? 0) + 1);

    let score = 0;
    for (const t of q) {
      if (nameToks.has(t)) score += 3;
      if (fmToks.has(t)) score += 2;
      score += Math.min(freq.get(t) ?? 0, 10);
    }
    if (score <= 0) continue;

    const lines = body.split(/\r?\n/);
    let best = 0;
    let bestHits = -1;
    lines.forEach((line, i) => {
      const lt = new Set(tokenize(line));
      const hits = q.filter((t) => lt.has(t)).length;
      if (hits > bestHits) {
        bestHits = hits;
        best = i;
      }
    });
    scored.push({ path: p, score, date: DATE_NAME.exec(p)?.[1] ?? "", lines, best });
  }

  scored.sort((a, b) => b.score - a.score || (a.date === b.date ? 0 : a.date < b.date ? 1 : -1) || (a.path < b.path ? -1 : 1));
  const top = scored.slice(0, ctx.config.qa.maxNotes);
  if (top.length === 0) return [];

  const per = Math.max(80, Math.floor(ctx.config.qa.maxChars / top.length));
  let budget = ctx.config.qa.maxChars;
  const out: Retrieved[] = [];
  for (const n of top) {
    if (budget <= 0) break;
    const from = Math.max(0, n.best - 1);
    const raw = n.lines.slice(from, n.best + 2).join("\n").trim();
    const excerpt = raw.slice(0, Math.min(per, budget));
    budget -= excerpt.length;
    out.push({ path: n.path, score: n.score, excerpt });
  }
  return out;
}
