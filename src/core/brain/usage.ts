// Per-provider daily usage/quota bookkeeping (V3-3, PLAN_V3 B.9). Web-standard APIs only.
import type { AgentContext, BrainEntry, Config, ProviderUsage, UsageBump } from "../types.ts";
import type { RateInfo } from "./openaiCompat.ts";

export interface UsageView {
  day: string; // UTC date: provider quotas reset on UTC days, not the user's local day.
  rows: ProviderUsage[];
}

const utcDay = (at: Date): string => at.toISOString().slice(0, 10);

/** One D1 read per (ctx, day); a fresh ctx (a fresh request) always re-reads. Mutated in place by recordCall. */
const memo = new WeakMap<AgentContext, UsageView>();

export async function loadUsage(ctx: AgentContext): Promise<UsageView> {
  const day = utcDay(ctx.clock.now());
  const cached = memo.get(ctx);
  if (cached && cached.day === day) return cached;
  const rows = await ctx.store.getUsage(day).catch(() => [] as ProviderUsage[]);
  const view: UsageView = { day, rows };
  memo.set(ctx, view);
  return view;
}

export function canUse(
  v: UsageView,
  entry: BrainEntry,
  model: string,
  cfg: Config,
  now: Date,
): { ok: true } | { ok: false; reason: "cooldown" | "exhausted" | "budget"; until: string | null } {
  const row = v.rows.find((r) => r.provider === entry.name && r.model === model);
  const nowMs = now.getTime();
  if (row?.cooldownUntil && new Date(row.cooldownUntil).getTime() > nowMs) {
    return { ok: false, reason: "cooldown", until: row.cooldownUntil };
  }
  if (row?.remainingReq === 0 && (row.resetAt === null || new Date(row.resetAt).getTime() > nowMs)) {
    return { ok: false, reason: "exhausted", until: row.resetAt };
  }
  const budget = cfg.brain.dailyBudget[entry.name];
  if (budget !== undefined) {
    const used = v.rows
      .filter((r) => r.provider === entry.name && entry.models.includes(r.model))
      .reduce((s, r) => s + r.requests, 0);
    if (used >= budget) return { ok: false, reason: "budget", until: null };
  }
  return { ok: true };
}

/** Applies the same additive/overwrite-only-if-provided semantics as the store's bumpUsage, to the cached view. */
function applyBump(view: UsageView, u: UsageBump): void {
  if (u.day !== view.day) return;
  const i = view.rows.findIndex((r) => r.provider === u.provider && r.model === u.model);
  if (i < 0) {
    view.rows.push({
      day: u.day,
      provider: u.provider,
      model: u.model,
      requests: u.requests,
      tokensIn: u.tokensIn,
      tokensOut: u.tokensOut,
      rateLimited: u.rateLimited,
      remainingReq: u.remainingReq ?? null,
      remainingTok: u.remainingTok ?? null,
      cooldownUntil: u.cooldownUntil ?? null,
      resetAt: u.resetAt ?? null,
      updatedAt: u.atIso,
    });
    return;
  }
  const row = view.rows[i]!;
  row.requests += u.requests;
  row.tokensIn += u.tokensIn;
  row.tokensOut += u.tokensOut;
  row.rateLimited += u.rateLimited;
  if (u.remainingReq !== undefined) row.remainingReq = u.remainingReq;
  if (u.remainingTok !== undefined) row.remainingTok = u.remainingTok;
  if (u.cooldownUntil !== undefined) row.cooldownUntil = u.cooldownUntil;
  if (u.resetAt !== undefined) row.resetAt = u.resetAt;
  row.updatedAt = u.atIso;
}

/** Records one completed attempt (success or failure). Never throws: a D1 write failure is swallowed. */
export async function recordCall(
  ctx: AgentContext,
  entry: string,
  model: string,
  o: { ok: boolean; status?: number; usage?: { in: number; out: number }; rate?: RateInfo },
): Promise<void> {
  try {
    const now = ctx.clock.now();
    const bump: UsageBump = {
      day: utcDay(now),
      provider: entry,
      model,
      requests: 1,
      tokensIn: o.usage?.in ?? 0,
      tokensOut: o.usage?.out ?? 0,
      rateLimited: o.status === 429 ? 1 : 0,
      atIso: now.toISOString(),
    };
    if (o.rate?.remainingReq !== undefined) bump.remainingReq = o.rate.remainingReq;
    if (o.rate?.remainingTok !== undefined) bump.remainingTok = o.rate.remainingTok;
    if (o.rate?.resetAt !== undefined) bump.resetAt = o.rate.resetAt;
    if (o.status === 429) bump.cooldownUntil = new Date(now.getTime() + (o.rate?.retryAfterMs ?? 60_000)).toISOString();
    await ctx.store.bumpUsage(bump);
    const view = await loadUsage(ctx);
    applyBump(view, bump);
  } catch {
    /* usage bookkeeping must never break a reply */
  }
}

/**
 * True once every non-local HTTP entry that has a key configured has no usable model left, per `canUse`.
 * An entry with no key, or the deterministic/local entries, is not counted: they were never in the running.
 */
export async function quotaStatus(ctx: AgentContext): Promise<{ exhausted: boolean; resetAt: string | null }> {
  try {
    const view = await loadUsage(ctx);
    const now = ctx.clock.now();
    let sawEntry = false;
    let anyOk = false;
    const untils: string[] = [];
    for (const entry of ctx.config.brain.entries) {
      if (entry.kind === "deterministic" || entry.local || !entry.baseUrl) continue;
      const key = entry.keyEnv ? ctx.env(entry.keyEnv) : undefined;
      if (!key) continue;
      sawEntry = true;
      for (const model of entry.models) {
        const r = canUse(view, entry, model, ctx.config, now);
        if (r.ok) anyOk = true;
        else if (r.until) untils.push(r.until);
      }
    }
    if (!sawEntry || anyOk) return { exhausted: false, resetAt: null };
    untils.sort();
    return { exhausted: true, resetAt: untils[0] ?? null };
  } catch {
    return { exhausted: false, resetAt: null };
  }
}

/**
 * `entry.extraBody` is either a flat body-field map (applies to every model) or a per-model map (every key is "*"
 * or one of `entry.models`), in which case `map[model] ?? map["*"]` applies. The `brain:noextra:<entry>:<model>`
 * kv override (set after a badParam retry) is honoured by the caller (chain.ts), which has store access; this
 * function is pure and has none.
 */
export function extraBodyFor(entry: BrainEntry, model: string): Record<string, unknown> | undefined {
  const eb = entry.extraBody;
  if (!eb) return undefined;
  const keys = Object.keys(eb);
  const isPerModel = keys.every((k) => k === "*" || entry.models.includes(k));
  if (!isPerModel) return eb;
  const v = eb[model] ?? eb["*"];
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}
