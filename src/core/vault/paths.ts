/** Agent-owned prefixes. Everything else in the vault is human-owned and never written. */
const WRITABLE = [
  "Digests/",
  "GitHub/",
  "Gmail/",
  "Deadlines/index.md",
  "Deadlines/deadlines.json",
  "Plans/Proposed/",
  "Inbox/",
  "Threads/",
  "Meta/",
  "Tasks/",
  "Mindmap/",
];

/** Rejects absolute paths, traversal, empty/dot segments, backslashes and control chars. */
export function isSafeRelativePath(path: string): boolean {
  if (!path || path.startsWith("/") || path.includes("\\")) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(path)) return false;
  return !path.split("/").some((seg) => seg === "" || seg === "." || seg === "..");
}

/**
 * Write gate. Reads are deliberately NOT gated by this (human notes are the Q&A corpus);
 * they are confined to the vault root instead. Shared by FsWriter and GitDataApiWriter —
 * neither may re-implement the allowlist.
 */
export function assertWritable(path: string): void {
  const ok =
    isSafeRelativePath(path) &&
    WRITABLE.some((p) => path === p || (p.endsWith("/") && path.startsWith(p)));
  if (!ok) throw new Error(`vault write refused (not agent-owned): ${path}`);
}
