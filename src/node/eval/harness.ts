// The scenario runner (brief "Harness"). Builds a fully offline AgentContext around testContext(), seeds it,
// drives each turn through an injected Handler, fires the due-reminder job when the clock advances, and
// scores the outcome with checks.ts.
import { sweepReminders } from "../../core/jobs/reminders.ts";
import { upsertAndMaterialise } from "../../core/reminders/engine.ts";
import { createBrain } from "../../core/brain/chain.ts";
import { DEFAULT_BRAIN_ENTRIES } from "../../core/config.ts";
import { INVOLVEMENT_KV } from "../../core/sources/involvement.ts";
import { localDateOf } from "../../core/time.ts";
import { finishTrace } from "../../core/trace/record.ts";
import type {
  AgentContext,
  Brain,
  Channel,
  ChannelId,
  Clock,
  Deadline,
  DialogAction,
  EnvReader,
  Fetcher,
  InboundHandler,
  InboundMessage,
  InboundResult,
  Task,
} from "../../core/types.ts";
import { testContext } from "../testing/context.ts";
import { checkTurn } from "./checks.ts";
import { scriptedBrain } from "./fakeBrain.ts";
import type { Handler, Scenario, ScenarioOutcome, Turn, TurnOutcome } from "./types.ts";

export const TELEGRAM_ID = "111";
export const WHATSAPP_ID = "919900000000";

/* ----------------------------------------------------------------- clock */

/** A mutable Clock: FixedClock's instant is private+readonly, so the harness needs its own. */
export class EvalClock implements Clock {
  readonly tz: string;
  private at: Date;
  constructor(iso: string, tz: string) {
    this.at = new Date(iso);
    this.tz = tz;
  }
  now(): Date {
    return new Date(this.at);
  }
  advance(ms: number): void {
    this.at = new Date(this.at.getTime() + ms);
  }
}

/* -------------------------------------------------------------- channels */

interface Sent {
  channel: ChannelId;
  peer: string;
  text: string;
}

/** Two of these (one per channel) share one ordered `log`, so cross-channel delivery order (D4's WA-closed
 * fallback to Telegram, batches of due reminders) is observable as a single timeline. */
class RecordingChannel implements Channel {
  readonly id: ChannelId;
  readonly typed: string[] = [];
  private readonly log: Sent[];
  private readonly allowlist: string[];
  constructor(id: ChannelId, log: Sent[], allowlist: string[]) {
    this.id = id;
    this.log = log;
    this.allowlist = allowlist;
  }
  async send(text: string): Promise<void> {
    for (const peer of this.allowlist) this.log.push({ channel: this.id, peer, text });
  }
  async sendTo(peer: string, text: string): Promise<void> {
    this.log.push({ channel: this.id, peer, text });
  }
  async typing(peer: string): Promise<void> {
    this.typed.push(peer);
  }
}

/* ------------------------------------------------------------------ seed */

function defaultTask(over: Partial<Task>, localDate: string): Task {
  const due = over.dueDate ?? localDate;
  return {
    id: over.id ?? `eval:task:${over.title ?? "untitled"}:${due}`,
    title: over.title ?? "untitled",
    status: over.status ?? "open",
    dueDate: due,
    createdDate: over.createdDate ?? due,
    firstDate: over.firstDate ?? due,
    rollCount: over.rollCount ?? 0,
    doneAt: over.doneAt ?? null,
    recurrence: over.recurrence ?? null,
    source: over.source ?? "chat",
    notePath: over.notePath ?? `Tasks/${due}.md`,
  };
}

function defaultDeadline(over: Partial<Deadline>): Deadline {
  if (!over.title || !over.dueAt) throw new Error("seed.deadlines[] needs at least title and dueAt");
  return {
    id: over.id ?? `eval:deadline:${over.title}:${over.dueAt}`,
    source: over.source ?? "manual",
    sourceRef: over.sourceRef ?? "eval",
    title: over.title,
    dueAt: over.dueAt,
    status: over.status ?? "open",
    confidence: over.confidence ?? 1,
    notePath: over.notePath ?? "",
    category: over.category,
    timed: over.timed,
    originChannel: over.originChannel ?? null,
    originPeer: over.originPeer ?? null,
  };
}

async function seed(ctx: AgentContext, s: Scenario): Promise<void> {
  const nowIso = ctx.clock.now().toISOString();
  const localToday = localDateOf(ctx.clock.now(), ctx.clock.tz);
  for (const t of s.seed?.tasks ?? []) await ctx.store.upsertTask(defaultTask(t, localToday));
  // Every production deadline write path materialises its reminder rows on write (chat create/confirm/snooze, and
  // the GitHub/manual/Gmail upserts via upsertAndMaterialise, PLAN_V3 B.10), so a seeded deadline goes through the
  // same helper; a raw upsertDeadline would leave it with no rows, which no production path can produce.
  await upsertAndMaterialise(ctx, (s.seed?.deadlines ?? []).map(defaultDeadline));
  for (const n of s.seed?.notes ?? []) await ctx.store.upsertNote(n);
  if (s.seed?.involvement !== undefined) await ctx.store.kvSet(INVOLVEMENT_KV, JSON.stringify(s.seed.involvement), nowIso);
  if (s.seed?.dialog !== undefined) {
    const d = s.seed.dialog;
    await ctx.store.putDialog(
      {
        channel: (d.channel as ChannelId) ?? "telegram",
        peer: (d.peer as string) ?? TELEGRAM_ID,
        intent: (d.intent as string) ?? "create_reminder",
        slots: (d.slots as Record<string, unknown>) ?? {},
        missing: (d.missing as string[]) ?? [],
        asked: (d.asked as string | null) ?? null,
        sources: (d.sources as string[]) ?? [],
        lastAction: (d.lastAction as DialogAction | null | undefined) ?? null,
        questions: (d.questions as number) ?? 0,
        expiresAt: (d.expiresAt as string) ?? new Date(new Date(nowIso).getTime() + 10 * 60_000).toISOString(),
        updatedAt: (d.updatedAt as string) ?? nowIso,
      },
      null,
    );
  }
}

/* --------------------------------------------------------------- runner */

function baseConfigPatch(extra?: Record<string, unknown>): Record<string, unknown> {
  const base = {
    chat: { engine: "v3" },
    channels: {
      telegram: { enabled: true, allowedChatIds: [TELEGRAM_ID] },
      whatsapp: { enabled: true, allowedWaIds: [WHATSAPP_ID] },
      defaultChannel: "telegram",
    },
  };
  return extra ? { ...base, ...extra } : base;
}

export interface RunOpts {
  handler: Handler;
  /** "fake" builds a scriptedBrain from each turn's script. A factory (live mode) is called once the
   * scenario's own ctx exists, since createBrain() needs ctx.store/clock/config/env. */
  brain: Brain | "fake" | ((ctx: AgentContext) => Brain);
  /** Exact in fake mode (undefined = no cap). In live mode, the REMAINING global budget for this scenario;
   * once this scenario's own calls reach it, its later turns are skipped and its status is "not-run". */
  maxCalls?: number;
  /** Live mode only: real fetch + the one env var it is allowed to read. Fake mode always uses offlineFetch. */
  fetch?: Fetcher;
  env?: EnvReader;
  runtime?: "cli" | "worker";
  configPatch?: Record<string, unknown>;
}

export async function runScenario(s: Scenario, o: RunOpts): Promise<ScenarioOutcome> {
  if (s.direct) return runDirect(s);

  const tz = s.tz ?? "Asia/Kolkata";
  const clock = new EvalClock(s.at, tz);
  const log: Sent[] = [];
  const telegram = new RecordingChannel("telegram", log, [TELEGRAM_ID]);
  const whatsapp = new RecordingChannel("whatsapp", log, [WHATSAPP_ID]);

  let current: Turn = s.turns[0] as Turn;
  const isFactory = typeof o.brain === "function" || (s.providerQuota !== undefined && o.brain === "fake");
  // providerQuota: the real chain + a fetch that only counts (see Scenario.providerQuota).
  let fetchAttempts = 0;
  const quotaGroq = DEFAULT_BRAIN_ENTRIES.find((e) => e.kind === "groq");
  const quotaFloor = DEFAULT_BRAIN_ENTRIES.find((e) => e.kind === "deterministic");
  const quotaMode = s.providerQuota !== undefined && o.brain === "fake" && quotaGroq !== undefined && quotaFloor !== undefined;
  let brain: Brain | ReturnType<typeof scriptedBrain> | undefined =
    quotaMode ? undefined : o.brain === "fake" ? scriptedBrain(() => current) : typeof o.brain === "function" ? undefined : o.brain;

  const ctx = testContext({
    at: s.at,
    tz,
    clock,
    brain,
    fetch: quotaMode
      ? async (url) => {
          fetchAttempts++;
          throw new Error(`network disabled in eval: ${String(url)}`);
        }
      : o.fetch,
    env: quotaMode ? (name: string) => (name === quotaGroq?.keyEnv ? "eval-fake-key" : undefined) : o.env,
    runtime: o.runtime,
    channels: [telegram, whatsapp],
    configPatch: baseConfigPatch({
      ...s.configPatch,
      ...o.configPatch,
      ...(quotaMode ? { brain: { entries: [quotaGroq, quotaFloor] } } : {}),
    }),
  });
  if (quotaMode && quotaGroq) {
    const q = s.providerQuota as NonNullable<Scenario["providerQuota"]>;
    const now = ctx.clock.now();
    for (const model of quotaGroq.models) {
      await ctx.store.bumpUsage({
        day: now.toISOString().slice(0, 10),
        provider: quotaGroq.name,
        model,
        requests: 1,
        tokensIn: 0,
        tokensOut: 0,
        rateLimited: 1,
        remainingReq: 0,
        resetAt: q.resetAt,
        atIso: now.toISOString(),
      });
    }
    const real = createBrain(ctx, { allowLocalGateway: false });
    // `.calls` is what the turn loop diffs for llmCalls: here it is the HTTP attempts, not complete() invocations.
    const counted: Brain = { complete: (req) => real.complete(req) };
    Object.defineProperty(counted, "calls", { get: () => new Array<unknown>(fetchAttempts), enumerable: true });
    ctx.brain = counted;
    brain = counted;
  } else if (isFactory) {
    ctx.brain = (o.brain as (ctx: AgentContext) => Brain)(ctx);
    brain = ctx.brain;
  }
  const b: Brain = brain as Brain;
  await seed(ctx, s);

  const turns: TurnOutcome[] = [];
  let scenarioCalls = 0;
  let stopped = false;

  for (let idx = 0; idx < s.turns.length; idx++) {
    const turn = s.turns[idx] as Turn;
    current = turn;

    if (stopped) continue;
    if (o.maxCalls !== undefined && scenarioCalls >= o.maxCalls) {
      stopped = true;
      continue;
    }

    // advanceMs = time that passes BEFORE this turn's message (R6 "11 min later", S3 "00:05"): the clock moves,
    // the every-minute cron's reminder job runs at the new instant exactly as the Worker's scheduled() ->
    // runDueJobs -> sweep:reminders would, and only then does the message arrive. Anything the sweep sends is
    // part of this turn's sentTo/delivered log (logBefore is taken first).
    const logBefore = log.length;
    if (turn.advanceMs) {
      clock.advance(turn.advanceMs);
      await sweepReminders.run(ctx);
    }
    const delivered = log.slice(logBefore).map((x) => x.text);

    const channel: ChannelId = turn.channel ?? "telegram";
    const from = channel === "telegram" ? TELEGRAM_ID : WHATSAPP_ID;
    const msgId = `${s.id}-${idx + 1}`;
    const msgKey = `${channel}:${msgId}`;
    const msg: InboundMessage = { channel, id: msgId, from, text: turn.text, at: clock.now().toISOString() };

    const before = { taskCount: (await ctx.store.listTasks()).length, deadlineCount: (await ctx.store.listDeadlines()).length };
    const callsBefore = "calls" in b ? (b as ReturnType<typeof scriptedBrain>).calls.length : 0;
    const failuresBefore = "failures" in b ? (b as ReturnType<typeof scriptedBrain>).failures.length : 0;

    const t0 = performance.now();
    let result: InboundResult | null = null;
    let threwMsg: string | null = null;
    try {
      result = await o.handler(ctx, msg);
    } catch (e) {
      threwMsg = e instanceof Error ? e.message : String(e);
    }
    const reply = result?.reply ?? null;
    if (reply !== null) {
      const target = channel === "telegram" ? telegram : whatsapp;
      await target.sendTo(from, reply);
    }
    // "then send the reply via sendTo like the worker, finishTrace" (brief, Harness step 3): the harness
    // plays the worker's part of adding delivery + latency, using the real architect-owned finisher.
    if (result) await finishTrace(ctx, { ...result.trace, t0 }, reply !== null ? "ok" : "skipped");

    const ms = Math.round(performance.now() - t0);

    const callsAfter = "calls" in b ? (b as ReturnType<typeof scriptedBrain>).calls.length : 0;
    const failuresAfter = "failures" in b ? (b as ReturnType<typeof scriptedBrain>).failures.length : 0;
    const scriptFailures = "failures" in b ? (b as ReturnType<typeof scriptedBrain>).failures.slice(failuresBefore, failuresAfter) : [];
    const toolsJson = result?.trace.toolsJson ?? null;
    let tools: string[] = [];
    if (toolsJson) {
      try {
        const parsed = JSON.parse(toolsJson) as { name: string; ok: boolean }[];
        tools = parsed.filter((t) => t.ok).map((t) => t.name);
      } catch {
        /* leave empty: malformed toolsJson is its own bug, not this check's job */
      }
    }
    const sentTo = log.slice(logBefore).map((x) => ({ channel: x.channel, peer: x.peer }));

    const outcome: TurnOutcome = {
      reply,
      route: result?.trace.route ?? "",
      llmCalls: callsAfter - callsBefore,
      tools,
      sentTo,
      delivered,
      ms,
      failures: [],
    };
    if (threwMsg) outcome.failures.push(`turn ${idx + 1}: handler threw: ${threwMsg}`);
    outcome.failures.push(...scriptFailures.map((f) => `turn ${idx + 1}: ${f}`));

    const checkFailures = await checkTurn({
      ctx,
      scenario: s,
      turn,
      turnIndex: idx,
      userTextsSoFar: s.turns.slice(0, idx + 1).map((t) => t.text),
      outcome,
      mode: o.brain === "fake" ? "fake" : "live",
      // (providerQuota scenarios run the real chain but are still offline + exact: mode stays "fake")
      before,
      threw: threwMsg !== null,
      msgKey,
    });
    outcome.failures.push(...checkFailures.map((f) => `turn ${idx + 1}: ${f}`));

    scenarioCalls += outcome.llmCalls;
    turns.push(outcome);
  }

  // A live-cap stop mid-scenario is reported as "not-run" (brief live.ts: "the current scenario is not-run
  // and the run stops"), not scored pass/fail on its partial turns.
  const status: ScenarioOutcome["status"] = stopped ? "not-run" : turns.some((t) => t.failures.length > 0) ? "fail" : "pass";
  return { id: s.id, status, turns, calls: scenarioCalls };
}

async function runDirect(s: Scenario): Promise<ScenarioOutcome> {
  const tz = s.tz ?? "Asia/Kolkata";
  const clock = new EvalClock(s.at, tz);
  const log: Sent[] = [];
  const telegram = new RecordingChannel("telegram", log, [TELEGRAM_ID]);
  const whatsapp = new RecordingChannel("whatsapp", log, [WHATSAPP_ID]);
  const ctx = testContext({
    at: s.at,
    tz,
    clock,
    channels: [telegram, whatsapp],
    configPatch: {
      chat: { engine: "v3" },
      channels: {
        telegram: { enabled: true, allowedChatIds: [TELEGRAM_ID] },
        whatsapp: { enabled: true, allowedWaIds: [WHATSAPP_ID] },
        defaultChannel: "telegram",
      },
    },
  });
  await seed(ctx, s);
  const t0 = Date.now();
  const { failures } = await (s.direct as NonNullable<Scenario["direct"]>)(ctx);
  const outcome: TurnOutcome = { reply: null, route: "job", llmCalls: 0, tools: [], sentTo: log.map((x) => ({ channel: x.channel, peer: x.peer })), delivered: log.map((x) => x.text), ms: Date.now() - t0, failures };
  return { id: s.id, status: failures.length ? "fail" : "pass", turns: [outcome], calls: 0 };
}

/* -------------------------------------------------------------- readiness */

export interface Readiness {
  "v3-2": boolean;
  "v3-3": boolean;
}

/** Detects whether each later phase has landed, by import, without hardcoding a path other builders might
 * still be shaping. Never throws: a missing/incomplete module just means "not ready yet". */
export async function readiness(): Promise<Readiness> {
  let v32 = false;
  try {
    const m = (await import("../../core/inbound/commands.ts")) as Record<string, unknown>;
    v32 = typeof m.handleInboundV3 === "function";
  } catch {
    v32 = false;
  }
  let v33 = false;
  try {
    await import("../../core/agent/degraded.ts");
    v33 = true;
  } catch {
    v33 = false;
  }
  return { "v3-2": v32, "v3-3": v33 };
}

/** The brief's default handler: handleInboundV3 (config chat.engine "v3"), once V3-2 exports it. */
export async function defaultHandler(): Promise<Handler | null> {
  const m = (await import("../../core/inbound/commands.ts")) as Record<string, unknown>;
  const fn = m.handleInboundV3;
  return typeof fn === "function" ? (fn as Handler) : null;
}

/** Wraps the CURRENT legacy handleInbound (string | null) in the Handler shape, so the harness seam is
 * provably exercised against real code today, ahead of V3-2. Route "legacy" always; llmCalls is unknown
 * from here (the legacy path does not report it), so callers must not assert llmCalls against it. */
export function legacyHandlerAdapter(legacy: InboundHandler): Handler {
  return async (ctx, msg) => {
    const reply = await legacy(ctx, msg);
    const at = ctx.clock.now().toISOString();
    return {
      reply,
      trace: {
        at,
        localDate: localDateOf(new Date(at), ctx.clock.tz),
        kind: "inbound",
        channel: msg.channel,
        peer: msg.from,
        msgKey: `${msg.channel}:${msg.id}`,
        route: "legacy",
        intent: null,
        toolsJson: null,
        llmCalls: 0,
        model: null,
        provider: null,
        replyChars: reply?.length ?? 0,
        replyPreview: reply?.slice(0, 160) ?? null,
        flags: null,
        error: null,
        stagesJson: null,
        stages: {},
      },
    };
  };
}
