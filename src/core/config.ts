// Config is data, never secrets: keys live in env vars, only their NAMES appear here.
// ARCHITECT-OWNED: builder packages import from here and never edit this file.
import type { BrainEntry, ChannelId, Config, DeadlineSource, ReminderRule } from "./types.ts";
import { parseOffset } from "./time.ts";

/**
 * Fallback chain, in order. Model ids are data — nothing downstream may hardcode one.
 * The omniroute entry is `local`: chainFor() drops it outside an attended CLI run.
 */
export const DEFAULT_BRAIN_ENTRIES: BrainEntry[] = [
  {
    kind: "omniroute",
    name: "omniroute",
    baseUrl: "http://localhost:20128/v1",
    keyEnv: "OMNIROUTE_KEY",
    models: ["gemini-3-pro", "gemini-3-flash"],
    local: true,
  },
  {
    // Groq: free (no card), very fast (0.3-1 s measured), OpenAI-compatible, and a far larger daily allowance than
    // OpenRouter's free tier (50 requests/day). Skipped automatically until GROQ_KEY is set. Model ids verified against
    // Groq's /models list on 2026-09-21; they change, so re-check with `npm run cli -- models` if calls start failing.
    kind: "groq",
    name: "groq",
    baseUrl: "https://api.groq.com/openai/v1",
    keyEnv: "GROQ_KEY",
    models: ["qwen/qwen3.8-27b", "openai/gpt-oss-120b", "openai/gpt-oss-20b"],
    local: false,
    jsonMode: true,
  },
  {
    kind: "openrouter",
    name: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    keyEnv: "OPENROUTER_KEY",
    models: ["qwen/qwen3.8-27b:free", "nex-agi/nex-n2.5-pro:free", "nvidia/nemotron-3-super-120b-a12b:free", "google/gemma-4-31b-it:free"],
    local: false,
  },
  { kind: "deterministic", name: "deterministic", models: [], local: false },
];

const DEFAULTS: Config = {
  timezone: "Asia/Kolkata",
  github: { maxRepos: 15, repos: [], involvement: { enabled: true, maxPerBucket: 8 } },
  brain: { entries: DEFAULT_BRAIN_ENTRIES, budgetMs: 25_000, cacheTtlMs: 86_400_000, dailyBudget: { groq: 900, openrouter: 45 } },
  reminders: {
    offsets: ["7d", "2d", "24h", "3h", "0"],
    quietHours: { start: "22:00", end: "08:00" },
    dueHourLocal: 9,
    rules: [
      {
        id: "flight",
        offsets: ["24h"],
        keywords: ["flight", "boarding", "airline", "pnr", "indigo", "vistara", "air india", "departure"],
        needsTime: true,
      },
      { id: "github", offsets: ["24h"], keywords: [], sources: ["github"] },
      {
        id: "assignment",
        offsets: ["2h"],
        keywords: ["assignment", "submission", "submit", "viva", "lab report", "quiz", "exam", "practical"],
      },
    ],
  },
  tasks: { enabled: true, maxPerDay: 50, rolloverLocalTime: "03:00" },
  chat: {
    enabled: true,
    persona: "Brain",
    transcript: "summary" as "summary" | "full",
    memory: { verbatimChars: 2400, summaryChars: 600, summariseAboveChars: 3000, retainDays: 3 },
    context: { snapshotChars: 3000, notesChars: 2800, userChars: 1000 },
    maxReplyTokens: 400,
    engine: "v3" as "v3" | "legacy", // v3 agent is the shipped engine; "legacy" is the one-setting rollback
    dialogTtlMin: 10,
    llmBudgetMs: 9_000,
    perAttemptMs: 4_000,
    traceRetainDays: 14,
  },
  index: { batch: 15, maxNotes: 2000 },
  gmail: { enabled: false, query: "newer_than:14d -category:promotions", maxMessages: 50 },
  channels: {
    telegram: { enabled: false, allowedChatIds: [] },
    whatsapp: { enabled: false, allowedWaIds: [], templateName: "deadline_reminder", templateLanguage: "en" },
    defaultChannel: "telegram" as ChannelId,
  },
  qa: { maxNotes: 12, maxChars: 8000 },
};

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const str = (v: unknown, fb: string): string => (typeof v === "string" && v.length ? v : fb);
const num = (v: unknown, fb: number): number => (typeof v === "number" && Number.isFinite(v) ? v : fb);
const bool = (v: unknown, fb: boolean): boolean => (typeof v === "boolean" ? v : fb);
/** Accepts numbers too: chat/WA ids are numeric, so `[1201232794]` is the natural way to write one. */
const strs = (v: unknown, fb: string[]): string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string" || (typeof x === "number" && Number.isFinite(x)))
    ? v.map(String)
    : fb;

const SOURCES: readonly DeadlineSource[] = ["github", "gmail", "manual", "chat"];

/** Validates reminder rules: unique ids, no reserved "default", parseable offsets, lower-cased keywords. */
function rules(v: unknown, fb: ReminderRule[]): ReminderRule[] {
  if (!Array.isArray(v)) return fb;
  const seen = new Set<string>();
  return v.map((raw, i) => {
    const r = obj(raw);
    const id = str(r.id, "").trim();
    if (!id) throw new Error(`reminders.rules[${i}].id is required`);
    if (id === "default") throw new Error('reminders.rules: id "default" is reserved');
    if (seen.has(id)) throw new Error(`reminders.rules: duplicate id "${id}"`);
    seen.add(id);
    const offsets = strs(r.offsets, []);
    for (const o of offsets) parseOffset(o);
    const rule: ReminderRule = {
      id,
      offsets,
      keywords: strs(r.keywords, []).map((k) => k.toLowerCase()).filter((k) => k.length > 0),
    };
    if (Array.isArray(r.sources)) {
      const src = strs(r.sources, []).filter((x): x is DeadlineSource => (SOURCES as readonly string[]).includes(x));
      if (src.length) rule.sources = src;
    }
    if (r.needsTime === true) rule.needsTime = true;
    return rule;
  });
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

function entries(v: unknown, fb: BrainEntry[]): BrainEntry[] {
  if (!Array.isArray(v) || v.length === 0) return fb;
  return v.map((raw, i) => {
    const e = obj(raw);
    const kind = str(e.kind, "openrouter");
    if (kind !== "omniroute" && kind !== "openrouter" && kind !== "groq" && kind !== "deterministic") {
      throw new Error(`brain.entries[${i}].kind must be omniroute|openrouter|groq|deterministic`);
    }
    const entry: BrainEntry = {
      kind,
      name: str(e.name, kind),
      baseUrl: typeof e.baseUrl === "string" ? e.baseUrl : undefined,
      keyEnv: typeof e.keyEnv === "string" ? e.keyEnv : undefined,
      models: strs(e.models, []),
      local: bool(e.local, kind === "omniroute"),
    };
    // v3 keys are added only when present, so v2 entries parse to exactly the same object as before.
    if (typeof e.jsonMode === "boolean") entry.jsonMode = e.jsonMode;
    if (Array.isArray(e.purposes) && e.purposes.every((x) => typeof x === "string")) entry.purposes = e.purposes as string[];
    if (e.extraBody !== undefined) {
      if (!isPlainObject(e.extraBody)) throw new Error(`brain.entries[${i}].extraBody must be an object`);
      entry.extraBody = e.extraBody;
    }
    return entry;
  });
}

/**
 * Per-entry daily request budgets, merged over the defaults so a partial override never silently drops a safety limit.
 * An entry with no key is unlimited.
 */
function dailyBudget(v: unknown, fb: Record<string, number>): Record<string, number> {
  if (v === undefined) return { ...fb };
  if (!isPlainObject(v)) throw new Error("brain.dailyBudget must be an object of entry name -> requests/day");
  const out: Record<string, number> = { ...fb };
  for (const [k, n] of Object.entries(v)) {
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
      throw new Error(`brain.dailyBudget.${k} must be an integer >= 0`);
    }
    out[k] = n;
  }
  return out;
}

/** Validates and fills in defaults. Throws on values that would fail silently later. */
export function parseConfig(raw: unknown): Config {
  const c = obj(raw);
  const gh = obj(c.github);
  const br = obj(c.brain);
  const rm = obj(c.reminders);
  const quiet = obj(rm.quietHours);
  const gm = obj(c.gmail);
  const ch = obj(c.channels);
  const tg = obj(ch.telegram);
  const wa = obj(ch.whatsapp);
  const qa = obj(c.qa);
  const inv = obj(gh.involvement);
  const tk = obj(c.tasks);
  const cht = obj(c.chat);
  const mem = obj(cht.memory);
  const ctxc = obj(cht.context);
  const ix = obj(c.index);

  const cfg: Config = {
    timezone: str(c.timezone, DEFAULTS.timezone),
    github: {
      maxRepos: Math.max(1, num(gh.maxRepos, DEFAULTS.github.maxRepos)),
      repos: strs(gh.repos, DEFAULTS.github.repos),
      involvement: {
        enabled: bool(inv.enabled, DEFAULTS.github.involvement.enabled),
        maxPerBucket: Math.max(1, num(inv.maxPerBucket, DEFAULTS.github.involvement.maxPerBucket)),
      },
    },
    brain: {
      entries: entries(br.entries, DEFAULTS.brain.entries),
      budgetMs: Math.max(1000, num(br.budgetMs, DEFAULTS.brain.budgetMs)),
      cacheTtlMs: Math.max(0, num(br.cacheTtlMs, DEFAULTS.brain.cacheTtlMs)),
      dailyBudget: dailyBudget(br.dailyBudget, DEFAULTS.brain.dailyBudget),
    },
    reminders: {
      offsets: strs(rm.offsets, DEFAULTS.reminders.offsets),
      quietHours: {
        start: str(quiet.start, DEFAULTS.reminders.quietHours.start),
        end: str(quiet.end, DEFAULTS.reminders.quietHours.end),
      },
      dueHourLocal: Math.min(23, Math.max(0, Math.trunc(num(rm.dueHourLocal, DEFAULTS.reminders.dueHourLocal)))),
      rules: rules(rm.rules, DEFAULTS.reminders.rules),
    },
    tasks: {
      enabled: bool(tk.enabled, DEFAULTS.tasks.enabled),
      maxPerDay: Math.max(1, num(tk.maxPerDay, DEFAULTS.tasks.maxPerDay)),
      rolloverLocalTime: str(tk.rolloverLocalTime, DEFAULTS.tasks.rolloverLocalTime),
    },
    chat: {
      enabled: bool(cht.enabled, DEFAULTS.chat.enabled),
      persona: str(cht.persona, DEFAULTS.chat.persona),
      transcript: cht.transcript === "full" || cht.transcript === "summary" ? cht.transcript : DEFAULTS.chat.transcript,
      memory: {
        verbatimChars: Math.max(200, num(mem.verbatimChars, DEFAULTS.chat.memory.verbatimChars)),
        summaryChars: Math.max(200, num(mem.summaryChars, DEFAULTS.chat.memory.summaryChars)),
        summariseAboveChars: Math.max(200, num(mem.summariseAboveChars, DEFAULTS.chat.memory.summariseAboveChars)),
        retainDays: Math.max(1, num(mem.retainDays, DEFAULTS.chat.memory.retainDays)),
      },
      context: {
        snapshotChars: Math.max(200, num(ctxc.snapshotChars, DEFAULTS.chat.context.snapshotChars)),
        notesChars: Math.max(200, num(ctxc.notesChars, DEFAULTS.chat.context.notesChars)),
        userChars: Math.max(200, num(ctxc.userChars, DEFAULTS.chat.context.userChars)),
      },
      maxReplyTokens: Math.max(1, num(cht.maxReplyTokens, DEFAULTS.chat.maxReplyTokens)),
      engine: cht.engine === undefined ? DEFAULTS.chat.engine : (cht.engine as "v3" | "legacy"),
      dialogTtlMin: Math.min(120, Math.max(1, Math.trunc(num(cht.dialogTtlMin, DEFAULTS.chat.dialogTtlMin)))),
      llmBudgetMs: Math.max(2000, Math.trunc(num(cht.llmBudgetMs, DEFAULTS.chat.llmBudgetMs))),
      perAttemptMs: Math.max(1000, Math.trunc(num(cht.perAttemptMs, DEFAULTS.chat.perAttemptMs))),
      traceRetainDays: Math.max(1, Math.trunc(num(cht.traceRetainDays, DEFAULTS.chat.traceRetainDays))),
    },
    index: {
      batch: Math.max(1, num(ix.batch, DEFAULTS.index.batch)),
      maxNotes: Math.max(1, num(ix.maxNotes, DEFAULTS.index.maxNotes)),
    },
    gmail: {
      enabled: bool(gm.enabled, DEFAULTS.gmail.enabled),
      query: str(gm.query, DEFAULTS.gmail.query),
      maxMessages: Math.max(1, num(gm.maxMessages, DEFAULTS.gmail.maxMessages)),
    },
    channels: {
      telegram: {
        enabled: bool(tg.enabled, DEFAULTS.channels.telegram.enabled),
        allowedChatIds: strs(tg.allowedChatIds, DEFAULTS.channels.telegram.allowedChatIds),
      },
      whatsapp: {
        enabled: bool(wa.enabled, DEFAULTS.channels.whatsapp.enabled),
        allowedWaIds: strs(wa.allowedWaIds, DEFAULTS.channels.whatsapp.allowedWaIds),
        templateName: str(wa.templateName, DEFAULTS.channels.whatsapp.templateName),
        templateLanguage: str(wa.templateLanguage, DEFAULTS.channels.whatsapp.templateLanguage),
      },
      defaultChannel: ch.defaultChannel === undefined ? DEFAULTS.channels.defaultChannel : (ch.defaultChannel as ChannelId),
    },
    qa: {
      maxNotes: Math.max(1, num(qa.maxNotes, DEFAULTS.qa.maxNotes)),
      maxChars: Math.max(500, num(qa.maxChars, DEFAULTS.qa.maxChars)),
    },
  };

  // Fail loudly here rather than at 03:00 inside a cron.
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: cfg.timezone });
  } catch {
    throw new Error(`unknown timezone: ${cfg.timezone}`);
  }
  for (const o of cfg.reminders.offsets) parseOffset(o);
  for (const e of cfg.brain.entries) {
    // An HTTP entry with no models is skipped silently by the chain: catch it here instead.
    if (e.kind !== "deterministic" && e.models.length === 0) {
      throw new Error(`brain entry "${e.name}" has no models`);
    }
    if (e.kind !== "deterministic" && !e.baseUrl) throw new Error(`brain entry "${e.name}" has no baseUrl`);
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(cfg.tasks.rolloverLocalTime)) {
    throw new Error("tasks.rolloverLocalTime must be HH:MM");
  }
  if (!/^\d{1,2}:\d{2}$/.test(cfg.reminders.quietHours.start) || !/^\d{1,2}:\d{2}$/.test(cfg.reminders.quietHours.end)) {
    throw new Error("reminders.quietHours must be HH:MM");
  }
  if (cfg.channels.defaultChannel !== "telegram" && cfg.channels.defaultChannel !== "whatsapp") {
    throw new Error("channels.defaultChannel must be telegram|whatsapp");
  }
  if (cfg.chat.engine !== "v3" && cfg.chat.engine !== "legacy") throw new Error("chat.engine must be v3|legacy");
  if (cfg.chat.perAttemptMs > cfg.chat.llmBudgetMs) throw new Error("chat.perAttemptMs must be <= chat.llmBudgetMs");
  return cfg;
}

/**
 * The chain for this runtime. `allowLocalGateway` is false in the Worker and in any
 * unattended run: the local gateway holds the user's personal quota and must never be
 * driven by a cron or an inbound webhook. Enforced here, not by convention in callers.
 */
export function chainFor(cfg: Config, opts: { allowLocalGateway: boolean }): BrainEntry[] {
  const chain = cfg.brain.entries.filter((e) => opts.allowLocalGateway || !e.local);
  return chain.some((e) => e.kind === "deterministic")
    ? chain
    : [...chain, { kind: "deterministic" as const, name: "deterministic", models: [], local: false }];
}
