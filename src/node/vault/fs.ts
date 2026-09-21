import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { VaultFile, VaultWriter } from "../../core/types.ts";
import { assertWritable, isSafeRelativePath } from "../../core/vault/paths.ts";

// Mac-only: node:fs cannot run in a Worker, so this lives outside src/core/**.
// The Worker's GitDataApiWriter implements the same VaultWriter against the same allowlist.
export class FsWriter implements VaultWriter {
  private readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
  }

  /**
   * Reads are allowed anywhere in the vault (human notes feed Q&A) but nowhere outside it:
   * an LLM-supplied "../../.env" must not resolve. Prefix containment only — a symlink
   * planted inside the vault is treated as part of the vault.
   */
  private abs(path: string): string {
    if (!isSafeRelativePath(path)) throw new Error(`vault read refused (unsafe path): ${path}`);
    const abs = resolve(this.root, path);
    if (abs !== this.root && !abs.startsWith(this.root + sep)) {
      throw new Error(`vault read refused (outside root): ${path}`);
    }
    return abs;
  }

  async readFile(path: string): Promise<string | null> {
    try {
      return await readFile(this.abs(path), "utf8");
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EISDIR") return null;
      throw e;
    }
  }

  async listFiles(prefix = ""): Promise<string[]> {
    const dir = prefix.replace(/\/+$/, ""); // callers pass "Deadlines/manual/"; the safety check rejects empty segments
    const base = dir ? this.abs(dir) : this.root;
    let entries;
    try {
      entries = await readdir(base, { withFileTypes: true, recursive: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
    const out: string[] = [];
    for (const e of entries) {
      if (!e.isFile() || e.name.startsWith(".")) continue;
      const rel = relative(this.root, join(e.parentPath, e.name));
      if (rel.split(sep).some((s) => s.startsWith("."))) continue; // .obsidian/, .git/
      out.push(rel.split(sep).join("/"));
    }
    return out.sort();
  }

  async writeFiles(_message: string, files: VaultFile[]): Promise<string[]> {
    for (const f of files) assertWritable(f.path);
    const changed: string[] = [];
    for (const f of files) {
      if ((await this.readFile(f.path)) === f.content) continue;
      const abs = this.abs(f.path);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, f.content);
      changed.push(f.path);
    }
    return changed;
  }
}
