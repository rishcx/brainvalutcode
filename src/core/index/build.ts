import type { AgentContext } from "../types.ts";
import { blobSha, buildEntry } from "./tokens.ts";

export interface TreeEntry {
  path: string;
  sha: string;
}
export type TreeSource = (ctx: AgentContext) => Promise<TreeEntry[]>;
export interface IndexStats {
  indexed: number;
  removed: number;
  unchanged: number;
  pending: number;
}

const REMOVE_CHUNK = 50; // D1 binds at most 100 parameters per statement

const wanted = (p: string): boolean => p.toLowerCase().endsWith(".md") && !p.split("/").some((seg) => seg.startsWith("."));

/** Worker: the whole vault listing in ONE subrequest. Anything short of a complete listing throws (index untouched). */
export const githubTree: TreeSource = async (ctx) => {
  const repo = ctx.env("VAULT_REPO");
  const token = ctx.env("GITHUB_TOKEN_VAULT") ?? ctx.env("GITHUB_TOKEN");
  if (!repo || !token) throw new Error("index: VAULT_REPO and a vault token are required for the GitHub tree");
  const branch = ctx.env("VAULT_BRANCH") || "main";
  const res = await ctx.fetch(`https://api.github.com/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "brain-agent",
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`index: GitHub tree ${res.status}`);
  const body = (await res.json()) as { truncated?: boolean; tree?: { path?: unknown; type?: unknown; sha?: unknown }[] };
  if (body.truncated || !Array.isArray(body.tree)) throw new Error("index: GitHub tree truncated or malformed");
  return body.tree.flatMap((n) =>
    n.type === "blob" && typeof n.path === "string" && typeof n.sha === "string" && wanted(n.path) ? [{ path: n.path, sha: n.sha }] : [],
  );
};

/** CLI/tests: list and read the vault, hashing each note. No network. */
export const readTree: TreeSource = async (ctx) => {
  const out: TreeEntry[] = [];
  for (const p of await ctx.vault.listFiles()) {
    if (!wanted(p)) continue;
    const text = await ctx.vault.readFile(p);
    if (text !== null) out.push({ path: p, sha: await blobSha(text) });
  }
  return out;
};

export async function buildIndex(ctx: AgentContext, tree?: TreeSource): Promise<IndexStats> {
  const source = tree ?? (ctx.env("VAULT_REPO") ? githubTree : readTree);
  const entries = (await source(ctx)).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).slice(0, ctx.config.index.maxNotes);
  const have = new Map((await ctx.store.listNoteIndex()).map((n) => [n.path, n.sha]));

  const changed = entries.filter((e) => have.get(e.path) !== e.sha);
  const batch = changed.slice(0, ctx.config.index.batch);
  const at = ctx.clock.now().toISOString();

  let indexed = 0;
  for (const e of batch) {
    const text = await ctx.vault.readFile(e.path);
    if (text === null) continue;
    await ctx.store.upsertNote({ path: e.path, sha: e.sha, ...buildEntry(e.path, text), updatedAt: at });
    indexed++;
  }

  const live = new Set(entries.map((e) => e.path));
  const vanished = [...have.keys()].filter((p) => !live.has(p));
  const removed = vanished.length ? await ctx.store.deleteNotes(vanished.slice(0, REMOVE_CHUNK)) : 0;

  return {
    indexed,
    removed,
    unchanged: entries.length - changed.length,
    pending: changed.length - batch.length + Math.max(0, vanished.length - REMOVE_CHUNK),
  };
}
