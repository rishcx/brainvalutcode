// The Worker's VaultWriter: commits to the vault repo through the GitHub Git Data API.
// Web-standard APIs only. Shares the write allowlist with FsWriter via paths.ts#assertWritable.
import type { Fetcher, VaultFile, VaultWriter } from "../types.ts";
import { assertWritable, isSafeRelativePath } from "./paths.ts";

export interface GitWriterOpts {
  repo: string; // "owner/name"
  branch: string;
  token: string;
  fetch: Fetcher;
}

const API = "https://api.github.com";
const TIMEOUT_MS = 20_000;

class GitApiError extends Error {
  readonly status: number;
  constructor(status: number, what: string) {
    // Never include the token, request headers or response bodies that could echo them.
    super(`GitHub API ${status} on ${what}`);
    this.name = "GitApiError";
    this.status = status;
  }
}

interface TreeEntry {
  path: string;
  type: string;
  sha: string;
}

const hex = (buf: ArrayBuffer): string =>
  Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");

/** Git's own blob id: sha1("blob <bytes>\0" + content). Lets us skip unchanged files without fetching them. */
async function gitBlobSha(content: string): Promise<string> {
  const body = new TextEncoder().encode(content);
  const head = new TextEncoder().encode(`blob ${body.length}\0`);
  const all = new Uint8Array(head.length + body.length);
  all.set(head, 0);
  all.set(body, head.length);
  return hex(await crypto.subtle.digest("SHA-1", all));
}


const encodePath = (p: string): string => p.split("/").map(encodeURIComponent).join("/");

export class GitDataApiWriter implements VaultWriter {
  private readonly repo: string;
  private readonly branch: string;
  private readonly token: string;
  private readonly fetcher: Fetcher;

  constructor(o: GitWriterOpts) {
    this.repo = o.repo;
    this.branch = o.branch;
    this.token = o.token;
    this.fetcher = o.fetch;
  }

  private call(path: string, init: RequestInit = {}, accept = "application/vnd.github+json"): Promise<Response> {
    if (!/^[\w.-]+\/[\w.-]+$/.test(this.repo)) throw new Error("VAULT_REPO must look like owner/name");
    return this.fetcher(`${API}/repos/${this.repo}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept,
        "x-github-api-version": "2022-11-28",
        "user-agent": "brain-agent",
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }

  private async json<T>(what: string, path: string, init?: RequestInit): Promise<T> {
    const res = await this.call(path, init);
    if (!res.ok) throw new GitApiError(res.status, what);
    return (await res.json()) as T;
  }

  private async head(): Promise<{ commit: string; tree: string }> {
    const ref = await this.json<{ object: { sha: string } }>("read ref", `/git/ref/heads/${encodePath(this.branch)}`);
    const commit = await this.json<{ tree: { sha: string } }>("read commit", `/git/commits/${ref.object.sha}`);
    return { commit: ref.object.sha, tree: commit.tree.sha };
  }

  private async tree(sha: string): Promise<{ entries: TreeEntry[]; truncated: boolean }> {
    const t = await this.json<{ tree: TreeEntry[]; truncated?: boolean }>("read tree", `/git/trees/${sha}?recursive=1`);
    return { entries: t.tree, truncated: t.truncated === true };
  }

  async readFile(path: string): Promise<string | null> {
    if (!isSafeRelativePath(path)) throw new Error(`vault read refused (unsafe path): ${path}`);
    const res = await this.call(
      `/contents/${encodePath(path)}?ref=${encodeURIComponent(this.branch)}`,
      {},
      "application/vnd.github.raw+json",
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new GitApiError(res.status, "read file");
    return res.text();
  }

  async listFiles(prefix = ""): Promise<string[]> {
    const { tree } = await this.head();
    const { entries, truncated } = await this.tree(tree);
    if (truncated) throw new Error("vault tree too large for one Git Data API listing (truncated)");
    return entries
      .filter((e) => e.type === "blob" && e.path.startsWith(prefix) && !e.path.split("/").some((s) => s.startsWith(".")))
      .map((e) => e.path)
      .sort();
  }

  async writeFiles(message: string, files: VaultFile[]): Promise<string[]> {
    // Whole batch refused before any network call.
    for (const f of files) assertWritable(f.path);
    if (!files.length) return [];
    try {
      return await this.commit(message, files);
    } catch (e) {
      if (!(e instanceof GitApiError) || e.status !== 422) throw e;
    }
    // The ref moved under us: re-read it and try exactly once more.
    try {
      return await this.commit(message, files);
    } catch (e) {
      if (e instanceof GitApiError && e.status === 422) {
        throw new Error(`vault commit failed: branch "${this.branch}" kept moving (422 twice); will retry next run`);
      }
      throw e;
    }
  }

  private async commit(message: string, files: VaultFile[]): Promise<string[]> {
    const base = await this.head();
    const { entries } = await this.tree(base.tree);
    const existing = new Map(entries.filter((e) => e.type === "blob").map((e) => [e.path, e.sha]));

    const changed: { file: VaultFile; sha: string }[] = [];
    for (const f of files) {
      const sha = await gitBlobSha(f.content);
      if (existing.get(f.path) !== sha) changed.push({ file: f, sha });
    }
    if (!changed.length) return []; // no-op: no blob, no tree, no commit

    // Content goes inline in the tree: GitHub creates the blobs itself. That keeps a commit at a fixed
    // 6 subrequests however many notes changed (a Worker on the free plan gets only 50 per invocation).
    const items = changed.map((c) => ({ path: c.file.path, mode: "100644", type: "blob", content: c.file.content }));
    const tree = await this.json<{ sha: string }>("create tree", "/git/trees", {
      method: "POST",
      body: JSON.stringify({ base_tree: base.tree, tree: items }),
    });
    const commit = await this.json<{ sha: string }>("create commit", "/git/commits", {
      method: "POST",
      body: JSON.stringify({ message, tree: tree.sha, parents: [base.commit] }),
    });
    // force:false — a moved ref must fail (422), never be overwritten.
    await this.json("update ref", `/git/refs/heads/${encodePath(this.branch)}`, {
      method: "PATCH",
      body: JSON.stringify({ sha: commit.sha, force: false }),
    });
    return changed.map((c) => c.file.path);
  }
}
