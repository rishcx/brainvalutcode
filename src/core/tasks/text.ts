// Untrusted-text helpers for task titles. Titles are data: they are sanitised on the way in and escaped on the
// way out, never re-parsed as commands, and never reach a path, an id (beyond [a-z0-9-]) or frontmatter.

const MAX_TITLE = 200;

// C0/C1 controls, U+2028/9, zero-width + direction marks (U+200B-200F), bidi embeds/isolates, BOM.
// eslint-disable-next-line no-control-regex
const STRIP_RE = new RegExp("[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f\\u2028\\u2029\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069\\ufeff]", "g");

/** Returns "" when nothing usable is left (callers treat "" as a rejection). */
export function sanitiseTitle(raw: string): string {
  if (typeof raw !== "string") return "";
  let s = raw.normalize("NFKC");
  s = s.replace(/[\t\n\r]+/g, " ").replace(STRIP_RE, "");
  s = s.replace(/\s+/g, " ").trim();
  // Cap by code points so a surrogate pair is never cut in half.
  const cps = Array.from(s);
  if (cps.length > MAX_TITLE) s = cps.slice(0, MAX_TITLE).join("").trim();
  return s;
}

const MD_SPECIAL = /[\\`*_[\]<>#|~]/g;

/** Render-time escape: a title can only ever be inline text on one line. */
export function mdEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(MD_SPECIAL, (c) => `\\${c}`);
}

/** lowercase, non [a-z0-9] runs to "-", max 40, "task" when empty. */
export function slugify(title: string): string {
  const s = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return s || "task";
}

/** Case-folded, whitespace-collapsed form used for duplicate and name matching. */
export const normaliseTitle = (s: string): string => sanitiseTitle(s).toLowerCase();
