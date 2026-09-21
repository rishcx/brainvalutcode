import { localDayOfWeek } from "../time.ts";

/** Index = localDayOfWeek (0 = Sunday). */
const CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;
const ORDER = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;

const NAMES: Record<string, string> = {
  sun: "SU", sunday: "SU",
  mon: "MO", monday: "MO",
  tue: "TU", tues: "TU", tuesday: "TU",
  wed: "WE", weds: "WE", wednesday: "WE",
  thu: "TH", thur: "TH", thurs: "TH", thursday: "TH",
  fri: "FR", friday: "FR",
  sat: "SA", saturday: "SA",
};

function canonical(codes: Iterable<string>): string | null {
  const set = new Set(codes);
  if (set.size === 0) return null;
  if (set.size === 7) return "daily";
  return `weekly:${ORDER.filter((c) => set.has(c)).join(",")}`;
}

/** Canonical "daily" | "weekdays" | "weekly:MO,WE,FR", or null when unrecognised. */
export function parseRecurrence(s: string): string | null {
  if (typeof s !== "string") return null;
  const n = s.trim().toLowerCase().replace(/\s+/g, " ");
  if (n === "daily" || n === "every day") return "daily";
  if (n === "weekdays" || n === "every weekday") return "weekdays";
  const canon = /^weekly:([a-z]{2}(?:,[a-z]{2})*)$/.exec(n);
  if (canon) {
    const codes = canon[1]!.toUpperCase().split(",");
    return codes.every((c) => (ORDER as readonly string[]).includes(c)) ? canonical(codes) : null;
  }
  const m = /^(?:every|weekly on) (.+)$/.exec(n);
  if (!m) return null;
  const tokens = m[1]!.split(/\s*,\s*|\s+and\s+|\s*&\s*|\s+/).filter(Boolean);
  const codes: string[] = [];
  for (const t of tokens) {
    const c = NAMES[t];
    if (!c) return null;
    codes.push(c);
  }
  return canonical(codes);
}

/** Uses only localDayOfWeek(date): never the host timezone. */
export function recurrenceMatches(rec: string, date: string): boolean {
  const dow = localDayOfWeek(date);
  if (rec === "daily") return true;
  if (rec === "weekdays") return dow >= 1 && dow <= 5;
  if (rec.startsWith("weekly:")) return rec.slice(7).split(",").includes(CODES[dow]!);
  return false;
}
