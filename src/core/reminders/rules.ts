// Per-category reminder rules: config defaults, overridable via Meta/rules.json. Never throws.
import { DAY, parseOffset } from "../time.ts";
import type { AgentContext, CategoryId, Config, Deadline, DeadlineSource, ReminderRule } from "../types.ts";

export const RULES_PATH = "Meta/rules.json";
export const RULES_KV = "rules:json";
export const RULES_TTL_MS = 3_600_000;

const MAX_BYTES = 20 * 1024;
const MAX_RULES = 30;
const MAX_KEYWORDS = 40;
const MAX_SPAN_MS = 30 * DAY;
const ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const SOURCES: readonly string[] = ["github", "gmail", "manual", "chat"];

const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

export function parseRulesJson(text: string): ReminderRule[] | null {
  try {
    if (typeof text !== "string" || text.length > MAX_BYTES) return null;
    let raw: unknown = JSON.parse(text);
    if (raw && typeof raw === "object" && !Array.isArray(raw)) raw = (raw as { rules?: unknown }).rules;
    if (!Array.isArray(raw) || raw.length > MAX_RULES) return null;
    const seen = new Set<string>();
    const out: ReminderRule[] = [];
    for (const e of raw as unknown[]) {
      if (!e || typeof e !== "object" || Array.isArray(e)) return null;
      const r = e as Record<string, unknown>;
      if (typeof r.id !== "string") return null;
      const id = r.id.trim().toLowerCase();
      if (!ID_RE.test(id) || id === "default" || seen.has(id)) return null;
      seen.add(id);
      if (!isStrArray(r.offsets)) return null;
      for (const o of r.offsets) {
        if (parseOffset(o) > MAX_SPAN_MS) return null; // parseOffset throws on garbage -> caught
      }
      if (!isStrArray(r.keywords ?? [])) return null;
      const keywords = ((r.keywords ?? []) as string[]).map((k) => k.trim().toLowerCase()).filter((k) => k.length > 0);
      if (keywords.length > MAX_KEYWORDS) return null;
      const rule: ReminderRule = { id, offsets: [...r.offsets], keywords };
      if (r.sources !== undefined) {
        if (!isStrArray(r.sources) || !r.sources.every((s) => SOURCES.includes(s))) return null;
        if (r.sources.length) rule.sources = r.sources as DeadlineSource[];
      }
      if (r.needsTime !== undefined) {
        if (typeof r.needsTime !== "boolean") return null;
        rule.needsTime = r.needsTime;
      }
      out.push(rule);
    }
    return out;
  } catch {
    return null;
  }
}

export async function loadRules(ctx: AgentContext): Promise<ReminderRule[]> {
  const fallback = ctx.config.reminders.rules;
  try {
    const nowMs = ctx.clock.now().getTime();
    const cached = await ctx.store.kvGet(RULES_KV);
    if (cached) {
      try {
        const c = JSON.parse(cached) as { at?: unknown; rules?: unknown };
        if (typeof c.at === "number" && nowMs - c.at < RULES_TTL_MS && nowMs >= c.at) {
          if (c.rules === null) return fallback;
          const again = Array.isArray(c.rules) ? parseRulesJson(JSON.stringify(c.rules)) : null;
          if (again) return again;
        }
      } catch {
        /* corrupt cache entry: re-read */
      }
    }
    const text = await ctx.vault.readFile(RULES_PATH);
    const parsed = text === null ? null : parseRulesJson(text);
    if (text !== null && parsed === null) console.warn(`[rules] ${RULES_PATH} is invalid; using config rules`);
    await ctx.store.kvSet(RULES_KV, JSON.stringify({ at: nowMs, rules: parsed }), ctx.clock.now().toISOString());
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

export function ruleFor(category: CategoryId, rules: ReminderRule[]): ReminderRule | undefined {
  return rules.find((r) => r.id === category);
}

export function categorise(
  d: Pick<Deadline, "title" | "sourceRef" | "source"> & { category?: CategoryId },
  rules: ReminderRule[],
  extra = "",
): CategoryId {
  if (d.category && d.category !== "default" && ruleFor(d.category, rules)) return d.category;
  const hay = `${d.title} ${d.sourceRef} ${extra}`.toLowerCase().replace(/\s+/g, " ");
  const hits = (r: ReminderRule): boolean => r.keywords.some((k) => k.length > 0 && hay.includes(k));
  for (const r of rules) {
    if (r.sources?.length && r.sources.includes(d.source) && (r.keywords.length === 0 || hits(r))) return r.id;
  }
  for (const r of rules) {
    if (!r.sources?.length && hits(r)) return r.id;
  }
  return "default";
}

export function offsetsFor(category: CategoryId, rules: ReminderRule[], cfg: Config): string[] {
  const r = category === "default" ? undefined : ruleFor(category, rules);
  return r && r.offsets.length > 0 ? r.offsets : cfg.reminders.offsets;
}
