// Provenance v2 (PLAN_V3 B.4): a mutation's string args must be spans of the user's own words.
// Spans are matched token-by-token on normalised text; a token of >= 3 letters may differ by one edit (Damerau-1)
// so "call mum" matches "call mom" (owner requirement; PLAN_V3 said >= 5, which would miss exactly that case).

const TOKEN = /[\p{L}\p{N}]+/gu;
const LEAD_FILLER = new Set(["to", "about", "that", "for", "me"]);

/** NFKC, lowercase, punctuation to spaces, collapsed whitespace. */
export function norm(s: string): string {
  if (typeof s !== "string") return "";
  return s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

interface Tok {
  t: string;
  start: number;
  end: number;
}

function tokens(s: string): Tok[] {
  const src = s.normalize("NFKC");
  const out: Tok[] = [];
  for (const m of src.matchAll(TOKEN)) out.push({ t: m[0].toLowerCase(), start: m.index, end: m.index + m[0].length });
  return out;
}

/** True when a and b differ by at most one insertion, deletion, substitution or adjacent transposition. */
export function damerau1(a: string, b: string): boolean {
  if (a === b) return true;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0;
  while (i < la && i < lb && a[i] === b[i]) i++;
  if (la === lb) {
    if (a.slice(i + 1) === b.slice(i + 1)) return true; // substitution
    return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2); // transposition
  }
  return la > lb ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

const fuzzyOk = (a: string, b: string): boolean =>
  a.length >= 3 && b.length >= 3 && !/\d/.test(a) && !/\d/.test(b) && damerau1(a, b);

function windowMatch(span: string[], src: Tok[], fuzzy: boolean): { from: number; to: number } | null {
  const n = span.length;
  const budget = fuzzy ? 1 + Math.floor(n / 4) : 0;
  for (let i = 0; i + n <= src.length; i++) {
    let edits = 0;
    let ok = true;
    for (let j = 0; j < n; j++) {
      const s = src[i + j]!.t;
      if (s === span[j]) continue;
      if (fuzzyOk(s, span[j]!) && ++edits <= budget) continue;
      ok = false;
      break;
    }
    if (ok) return { from: i, to: i + n - 1 };
  }
  return null;
}

/**
 * The user's own text that `span` refers to (original casing, from the first to the last matched token), or null.
 * A leading "to|about|that|for|me" in the span may be dropped. The returned text is what gets stored, never the
 * model's paraphrase.
 */
export function matchSpan(span: string, sources: string[]): string | null {
  if (typeof span !== "string") return null;
  let want = tokens(span).map((t) => t.t);
  while (want.length > 0) {
    // Exact everywhere first (newest source wins), then one-edit tolerance: "7pm" never matches an older "6pm".
    for (const fuzzy of [false, true]) {
      for (const s of [...sources].reverse()) {
        if (typeof s !== "string") continue;
        const toks = tokens(s);
        const hit = windowMatch(want, toks, fuzzy);
        if (hit) return s.normalize("NFKC").slice(toks[hit.from]!.start, toks[hit.to]!.end);
      }
    }
    if (want.length > 1 && LEAD_FILLER.has(want[0]!)) want = want.slice(1);
    else break;
  }
  return null;
}

export function spanOk(span: string, sources: string[]): boolean {
  return matchSpan(span, sources) !== null;
}

const TIME_WORDS =
  /\b(?:am|pm|a\.m|p\.m|tonight|tomorrow|tmrw|tmr|tomorow|today|aaj|kal|parso|subah|shaam|sham|raat|baje|noon|midnight|morning|evening|afternoon|night|mins?|minutes?|hrs?|hours?|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next week)\b/i;

/** A digit, am/pm or a time word (incl. Hinglish) in any source: the gate for the model's advisory `at_local`. */
export function hasTimeToken(sources: string[]): boolean {
  return sources.some((s) => typeof s === "string" && (/\d/.test(s) || TIME_WORDS.test(s.normalize("NFKC"))));
}
