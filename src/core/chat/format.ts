// Deterministic plain-text cleanup applied to EVERY chat reply (model output and fallbacks).
import type { ChannelId } from "../types.ts";

const CONTROL = new RegExp("[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069\\ufeff\\u2028\\u2029]", "g");
export const MAX_CHAT_CHARS = 3500;

function stripInline(s: string): string {
  return s
    .replace(/!?\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_m, t: string, u: string) => (t.trim() ? `${t} (${u})` : u))
    .replace(/`+([^`]*)`+/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[\s(])\*(?!\s)([^*\n]+?)\*(?=[\s).,!?:;]|$)/g, "$1$2")
    .replace(/(^|[\s(])_(?!\s)([^_\n]+?)_(?=[\s).,!?:;]|$)/g, "$1$2")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/\*\*|__/g, "");
}

/** Cuts on a line boundary (or a space) and appends an ellipsis. */
function capLines(s: string, max: number): string {
  if (s.length <= max) return s;
  const room = max - 1;
  const head = s.slice(0, room);
  const nl = head.lastIndexOf("\n");
  const cut = nl > room * 0.5 ? head.slice(0, nl) : head.replace(/\s+\S*$/, "") || head;
  return `${cut.trimEnd()}…`;
}

export function formatChat(text: string, _channel: ChannelId): string {
  if (typeof text !== "string") return "";
  const src = text.normalize("NFKC").replace(/\r\n?/g, "\n").replace(/\t/g, " ").replace(CONTROL, "");
  const out: string[] = [];
  let inFence = false;
  for (const raw of src.split("\n")) {
    let line = raw;
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      out.push(line.trimEnd());
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) continue; // horizontal rule
    if (/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line) && line.includes("|")) continue; // table separator
    if (/^\s*\|.*\|\s*$/.test(line)) {
      line = line.trim().slice(1, -1).split("|").map((c) => c.trim()).filter(Boolean).join(" - ");
    }
    line = line.replace(/^\s{0,3}#{1,6}\s+/, "").replace(/^\s*>\s?/, "");
    const bullet = /^(\s*)(?:[-*+•]|\d{1,2}[.)])\s+(.*)$/.exec(line);
    if (bullet) line = `• ${stripInline(bullet[2] ?? "")}`;
    else line = stripInline(line);
    out.push(line.replace(/[ ]+$/g, ""));
  }
  const joined = out.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\*\*|`/g, "").trim();
  return capLines(joined, MAX_CHAT_CHARS);
}
