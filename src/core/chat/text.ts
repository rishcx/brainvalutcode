// Text hygiene for every untrusted string that reaches the chat prompt or the vault.

// C0 (except \n) and C1 controls, zero-width/bidi marks, BOM, line/paragraph separators.
const STRIP = new RegExp("[\\u0000-\\u0009\\u000b-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069\\ufeff\\u2028\\u2029]", "g");

export function cleanText(s: string): string {
  if (typeof s !== "string") return "";
  return s.normalize("NFKC").replace(/\t/g, " ").replace(STRIP, "").replace(/\n{3,}/g, "\n\n").trim();
}

/** Cuts to max code units with a trailing ellipsis, never splitting a surrogate pair. */
export function cap(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = Math.max(0, max - 1);
  const c = s.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end--;
  return `${s.slice(0, end)}…`;
}

/** Hard cut with no ellipsis (for summaries and budgets). */
export function cut(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = max;
  const c = s.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end--;
  return s.slice(0, end);
}

const SECRET = [
  /\bsk-[A-Za-z0-9_-]{12,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{16,}/g,
  /\bxox[bpaso]-[A-Za-z0-9-]{8,}/g,
  /\bbot\d{5,}:[A-Za-z0-9_-]{20,}/g,
];

/** Output guard: token-like strings never leave the bot. */
export function redactSecrets(s: string): string {
  let out = s;
  for (const re of SECRET) out = out.replace(re, "[redacted]");
  return out;
}
