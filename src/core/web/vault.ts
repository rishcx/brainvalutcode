// Human-path writer over the GitHub Contents API. ctx.vault.writeFiles refuses human paths
// (assertWritable), so /edit needs its own path; it is confined to isEditablePath() here too.
import type { AgentContext } from "../types.ts";
import { isEditablePath } from "./paths.ts";

export interface HumanVault {
  load(path: string): Promise<{ content: string; sha: string } | null>;
  save(path: string, content: string, baseSha: string | null, message: string): Promise<{ sha: string } | "conflict">;
}

const TIMEOUT_MS = 10_000;

export function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function fromBase64(b64: string): string {
  const bin = atob(b64.replace(/\s+/g, ""));
  return new TextDecoder("utf-8").decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export function createHumanVault(ctx: AgentContext): HumanVault {
  const target = (path: string) => {
    if (!isEditablePath(path)) throw new Error("human vault: path not editable");
    const repo = ctx.env("VAULT_REPO") ?? "";
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("VAULT_REPO must look like owner/name");
    const token = ctx.env("GITHUB_TOKEN_VAULT") ?? ctx.env("GITHUB_TOKEN");
    if (!token) throw new Error("vault token not configured");
    const branch = ctx.env("VAULT_BRANCH") ?? "main";
    const url = `https://api.github.com/repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}`;
    return { url, token, branch };
  };
  const headers = (token: string, body: boolean): Record<string, string> => ({
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "brain-agent",
    ...(body ? { "content-type": "application/json" } : {}),
  });

  return {
    async load(path) {
      const t = target(path);
      const res = await ctx.fetch(`${t.url}?ref=${encodeURIComponent(t.branch)}`, {
        headers: headers(t.token, false),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`GitHub API ${res.status} on load`);
      const j = (await res.json()) as { type?: string; encoding?: string; content?: string; sha?: string };
      if (Array.isArray(j) || j.encoding !== "base64" || typeof j.content !== "string" || typeof j.sha !== "string") {
        throw new Error("GitHub API unexpected shape on load");
      }
      return { content: fromBase64(j.content), sha: j.sha };
    },

    async save(path, content, baseSha, message) {
      const t = target(path);
      const body: Record<string, string> = { message, content: toBase64(content), branch: t.branch };
      if (baseSha) body.sha = baseSha;
      const res = await ctx.fetch(t.url, {
        method: "PUT",
        headers: headers(t.token, true),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status === 409 || res.status === 422) return "conflict";
      if (!res.ok) throw new Error(`GitHub API ${res.status} on save`);
      const j = (await res.json()) as { content?: { sha?: string } };
      return { sha: j.content?.sha ?? "" };
    },
  };
}
