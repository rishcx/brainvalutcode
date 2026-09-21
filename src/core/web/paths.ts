// Human-path allowlist for the /edit route. The path never touches a filesystem: it is only
// ever used as a GitHub Contents API key, and only after passing isEditablePath().
import { assertWritable, isSafeRelativePath } from "../vault/paths.ts";

/** Human-owned folders /edit may write. Agent-owned folders are refused by assertWritable too. */
export const HUMAN_PREFIXES: readonly string[] = ["Daily/", "Plans/", "Deadlines/manual/", "Notes/"];

const ALLOWED_CHARS = /^[\p{L}\p{N} _.\-()/]+$/u;

export function isEditablePath(path: string): boolean {
  if (typeof path !== "string" || path.length === 0 || path.length > 200) return false;
  if (path.normalize("NFC") !== path) return false;
  if (!isSafeRelativePath(path)) return false;
  if (!path.endsWith(".md")) return false;
  if (path.split("/").some((seg) => seg.startsWith("."))) return false;
  if (!ALLOWED_CHARS.test(path)) return false;
  if (!HUMAN_PREFIXES.some((p) => path.startsWith(p))) return false;
  if (path.startsWith("Plans/Proposed/")) return false;
  // Overlap guard: a path the agent owns must never be editable from the web.
  try {
    assertWritable(path);
    return false;
  } catch {
    return true;
  }
}
