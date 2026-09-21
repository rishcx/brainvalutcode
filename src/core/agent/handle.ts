// V3-2 agent entry point: fast path -> dialog (code) -> ONE PLAN call -> tools (code) -> optional COMPOSE.
// Never throws, never returns "", raw JSON or an error string. The caller (integrator) does allowlist + markProcessed,
// sends `reply` to msg.channel/msg.from and calls finishTrace(ctx, { ...trace, t0 }, delivery).
import { quotaStatus } from "../brain/usage.ts";
import { formatChat } from "../chat/format.ts";
import { recordTurn, summaryKey } from "../chat/memory.ts";
import { cap, cut, redactSecrets } from "../chat/text.ts";
import { beginTrace, instrumentBrain, preview, timed } from "../trace/record.ts";
import { localDate, localTimeOf } from "../time.ts";
import type { AgentContext, Brain, ChatTurn, DialogState, InboundMessage, InboundResult, TraceDraft } from "../types.ts";
import { MUTATING, type DegradedReason, type Plan, type Route, type Target, type ToolName, type ToolResult } from "./contract.ts";
import { compose } from "./compose.ts";
import { degradedReply } from "./degraded.ts";
import { clearDialog, loadDialog, pureTimeAnswer, saveDialog } from "./dialog.ts";
import { isCancelWords, parseFast, runFast } from "./fast.ts";
import { memoryBlock, refreshSummary } from "./memory.ts";
import { parsePlan } from "./parse.ts";
import { planPrompt } from "./plan.ts";
import { DIDNT_GET, GREETING, HELP_TEXT, MAX_REPLY, UNSUPPORTED } from "./render.ts";
import { TOOLS, type MissingData, type ToolEnv } from "./tools/index.ts";

type Degraded = (ctx: AgentContext, msg: InboundMessage, reason: DegradedReason) => Promise<string>;

const MAX_TEXT = 1000;
const MAX_QUESTIONS = 3;
const RETRY_WITHIN_MS = 3000;
const CANCELLED = "OK, cancelled. Nothing was set.";
const LIST_TOOLS = new Set<ToolName>(["list_tasks", "list_deadlines", "list_reminders"]);
const CLAIM = /\b(?:i(?:'ve| have)?\s+(?:set|added|created|scheduled|marked|cancel+ed|moved|snoozed|deleted|completed)|(?:has|have) been (?:set|added|created|scheduled)|all set|done!)/i;

interface Run {
  ctx: AgentContext;
  msg: InboundMessage;
  who: Target;
  text: string;
  dialog: DialogState | null;
  trace: TraceDraft & { t0: number };
  flags: string[];
  tools: { name: string; ok: boolean; note: string }[];
  route: Route;
  intent: string | null;
}

const active = (d: DialogState | null): d is DialogState => d !== null && d.intent !== "idle" && d.missing.length > 0;

export async function runAgent(
  ctx: AgentContext,
  msg: InboundMessage,
  opts?: { degraded?: Degraded; onTrace?: (t: TraceDraft) => void; deferAfter?: boolean },
): Promise<InboundResult> {
  const who: Target = { channel: msg.channel, peer: msg.from };
  const trace = beginTrace(ctx, who, "inbound", `${msg.channel}:${msg.id}`);
  opts?.onTrace?.(trace); // lets the Worker watchdog see live stage timings if this run hangs
  const text = typeof msg.text === "string" ? cut(msg.text.trim(), 10_000) : "";
  const r: Run = { ctx, msg, who, text, dialog: null, trace, flags: [], tools: [], route: "plan", intent: null };
  const date = localDate(ctx.clock);
  let turns: ChatTurn[] = [];
  let summary = "";
  let reply = "";
  try {
    const [dialog, t, s] = await timed(trace, "load", () =>
      Promise.all([
        loadDialog(ctx, who),
        ctx.store.turnsForDay(msg.channel, msg.from, date).catch(() => [] as ChatTurn[]),
        ctx.store.kvGet(summaryKey(msg.channel, msg.from, date)).catch(() => null),
      ]),
    );
    r.dialog = dialog;
    turns = t;
    summary = s ?? "";
    reply = await route(r, turns, summary, opts?.degraded ?? degradedReply);
  } catch (e) {
    trace.error = e instanceof Error ? e.message : String(e);
    reply = DIDNT_GET;
  }
  reply = finalReply(reply, msg);

  trace.route = r.route;
  trace.intent = r.intent;
  trace.toolsJson = r.tools.length ? JSON.stringify(r.tools) : null;
  trace.flags = r.flags.length ? [...new Set(r.flags)].join(",") : null;
  trace.replyChars = reply.length;
  trace.replyPreview = preview(reply);

  // Bookkeeping the user never sees (saving the turns, refreshing the day summary: an LLM call of up to several
  // seconds). The Worker runs it AFTER the reply has been sent; other callers get it inline, as before.
  const after = async (): Promise<void> => {
    try {
      await timed(trace, "persist", async () => {
        if (text) await recordTurn(ctx, msg, "user", text);
        await recordTurn(ctx, msg, "assistant", reply);
      });
      if (r.route === "plan" || r.route === "plan+compose") {
        await timed(trace, "summary", () => refreshSummary(ctx, who, date, turns, summary, performance.now() - trace.t0));
      }
    } catch (e) {
      trace.flags = [trace.flags, "after_failed"].filter(Boolean).join(",");
      console.error("after-reply bookkeeping failed:", e instanceof Error ? e.message : "unknown");
    }
  };
  if (opts?.deferAfter) return { reply, trace, after };
  await after();
  return { reply, trace };
}

function finalReply(text: string, msg: InboundMessage): string {
  const out = cap(redactSecrets(formatChat(text, msg.channel)), MAX_REPLY).trim();
  return out || DIDNT_GET;
}

async function route(r: Run, turns: ChatTurn[], summary: string, degraded: Degraded): Promise<string> {
  const { ctx, text } = r;
  if (!text) {
    r.route = "fast";
    r.intent = "help";
    return HELP_TEXT;
  }

  const fast = await timed(r.trace, "fast", () => fastPath(r));
  if (fast !== null) return fast;

  const viaDialog = await timed(r.trace, "dialog", () => dialogPath(r));
  if (viaDialog !== null) return viaDialog;

  if (!ctx.brain) return degrade(r, degraded, "no-brain");
  const brain = instrumentBrain(ctx.brain, r.trace);
  const planned = await timed(r.trace, "plan", () => plan(r, brain, turns, summary));
  if (typeof planned === "string") return degrade(r, degraded, planned);
  return execute(r, planned, brain, turns);
}

/* ------------------------------------------------------------------ fast + dialog */

async function fastPath(r: Run): Promise<string | null> {
  const { ctx, text, who, dialog } = r;
  const done = (intent: string, reply: string): string => {
    r.route = active(dialog) && intent === "cancel_dialog" ? "dialog" : "fast";
    r.intent = intent;
    return reply;
  };
  if (isCancelWords(text)) {
    if (active(dialog)) {
      await clearDialog(ctx, who);
      return done("cancel_dialog", CANCELLED);
    }
    const la = r.dialog?.lastAction;
    if (la && /reminder/.test(la.tool) && !/^\/?cancel$/i.test(text.trim())) {
      r.route = "dialog";
      r.intent = "cancel_offer";
      return `Cancel the reminder to ${la.title}? Reply 'cancel'.`;
    }
  }
  const cmd = parseFast(text);
  if (!cmd) return null;
  // An open question owns short words like "ok" or "a": they are answers, not greetings (audit 15).
  if (active(dialog) && (cmd.kind === "greet" || cmd.kind === "thanks" || cmd.kind === "ack")) return null;
  const out = await runFast(ctx, cmd, who, dialog, text);
  return out === null ? null : done(cmd.kind, out);
}

/** Code-only answers to an open question: a pure time for "when", a bare number for "which". */
async function dialogPath(r: Run): Promise<string | null> {
  const d = r.dialog;
  if (!active(d) || !(d.intent in TOOLS)) return null;
  let args: Record<string, unknown> | null = null;
  if (d.asked === "when") {
    const t = pureTimeAnswer(r.text, r.ctx.clock.tz, r.ctx.clock.now(), r.ctx.config.reminders.dueHourLocal);
    if (t) args = { ...d.slots, when_text: t.whenText, at_local: null };
  } else if (d.asked === "which") {
    const m = /^\s*#?(\d{1,2})\s*\.?\s*$/.exec(r.text);
    if (m) args = { ...d.slots, ref: { index: Number(m[1]) } };
  }
  if (!args) return null;
  delete args.candidates;
  r.route = "dialog";
  r.intent = d.intent;
  return (await runTools(r, [{ name: d.intent as ToolName, args }])).join("\n");
}

/* ------------------------------------------------------------------ plan */

async function plan(r: Run, brain: Brain, turns: ChatTurn[], summary: string): Promise<Plan | DegradedReason> {
  const { ctx } = r;
  const now = ctx.clock.now();
  const tz = ctx.clock.tz;
  const p = planPrompt({
    persona: ctx.config.chat.persona,
    nowLocal: `${localDate(ctx.clock)} ${localTimeOf(now, tz)}`,
    weekday: new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "long" }).format(now),
    tz,
    memory: memoryBlock(turns, summary),
    dialog: r.dialog,
    message: cut(r.text, MAX_TEXT),
  });
  const t0 = performance.now();
  // The retry must differ from the first attempt or it is a no-op at temperature 0 (audit 14).
  const RETRY = "\n\nYour previous output was not valid JSON. Output ONLY the JSON object.";
  for (let attempt = 0; attempt < 2; attempt++) {
    let raw: string;
    try {
      const q = attempt === 0 ? p : { ...p, prompt: p.prompt + RETRY };
      const res = await brain.complete({ ...q, responseFormat: "json_object", maxTokens: 350, temperature: attempt === 0 ? 0 : 0.3, cacheTtlMs: 0, purpose: "plan", timeoutMs: ctx.config.chat.perAttemptMs });
      if (res.entry === "deterministic") return (await quotaStatus(ctx)).exhausted ? "quota" : "unreachable";
      raw = res.text;
    } catch {
      return (await quotaStatus(ctx)).exhausted ? "quota" : "unreachable";
    }
    const parsed = parsePlan(raw);
    r.flags.push(...parsed.flags);
    if (parsed.plan) return parsed.plan;
    if (performance.now() - t0 >= RETRY_WITHIN_MS) break;
  }
  return "unparseable";
}

async function degrade(r: Run, degraded: Degraded, reason: DegradedReason): Promise<string> {
  r.route = "degraded";
  r.flags.push(`degraded:${reason}`);
  let out: string;
  try {
    out = await degraded(r.ctx, r.msg, reason);
  } catch {
    out = "";
  }
  // The generic "couldn't reach" line is wrong when the model answered but made no sense (PLAN_V3 B.3).
  if (reason === "unparseable" && (!out || out.startsWith("I couldn't reach my language model"))) return DIDNT_GET;
  return out || DIDNT_GET;
}

/* ------------------------------------------------------------------ execute */

/**
 * A smalltalk reply may not invent data. Digits are the tell, but only digits the user did not write themselves
 * ("at 6?" echoing "remind me at 6" is fine) — the old blanket ban dropped every such reply (audit 12).
 */
function sayOr(p: Plan, fallback: string, userText: string | null): string {
  const s = p.say.trim();
  if (!s || CLAIM.test(s)) return fallback;
  if (userText !== null && (s.match(/\d+/g) ?? []).some((n) => !userText.includes(n))) return fallback;
  return s;
}

async function execute(r: Run, p: Plan, brain: Brain, turns: ChatTurn[] = []): Promise<string> {
  r.intent = p.intent;
  if (p.tools.length === 0) {
    const base = p.intent === "help" ? sayOr(p, HELP_TEXT, null) : p.intent === "unsupported" ? sayOr(p, UNSUPPORTED, null) : sayOr(p, GREETING, r.text);
    return base + (await nudge(r, null));
  }
  const d = r.dialog;
  const calls = p.tools.map((c) => {
    if (!active(d) || c.name !== d.intent) return c;
    const merged: Record<string, unknown> = { ...c.args };
    for (const [k, v] of Object.entries(d.slots)) if (k !== "candidates" && (merged[k] === null || merged[k] === undefined)) merged[k] = v;
    return { name: c.name, args: merged };
  });
  const results: { name: ToolName; res: ToolResult }[] = [];
  const renders = await timed(r.trace, "tools", () => runTools(r, calls, results));

  // runTools pushes one result per call, so results[i] is calls[i]: the args must be carried, never re-indexed
  // after filtering (audit 3 — a mutating tool first made every read line up with the wrong call).
  const reads = results.map((x, i) => ({ ...x, args: calls[i]?.args ?? {} })).filter((x) => !MUTATING.has(x.name) && x.res.ok && x.res.data);
  // Notes always need synthesis; GitHub only for a qualified question or "all"; lists only when the plan asks.
  const wantCompose = reads.some(
    (x) =>
      x.name === "search_notes" ||
      (x.name === "github_involvement" && (p.compose || x.args.bucket === "all")) ||
      (p.compose && LIST_TOOLS.has(x.name)),
  );
  let body = renders.join("\n");
  if (wantCompose) {
    r.route = "plan+compose";
    const text = await timed(r.trace, "compose", () => compose(
      { ...r.ctx, brain },
      r.text,
      results.filter((x) => !MUTATING.has(x.name)).map((x) => x.res),
      [...turns].reverse().find((t) => t.role === "assistant")?.text ?? "",
    ));
    const mutRenders = results.filter((x) => MUTATING.has(x.name)).map((x) => x.res.render);
    if (text) body = [...mutRenders, text].filter(Boolean).join("\n");
    else r.flags.push("compose_failed");
  }
  return body + (await nudge(r, calls.map((c) => c.name)));
}

/** Topic switch: the open dialog is kept; one reminder line, once. */
async function nudge(r: Run, ran: ToolName[] | null): Promise<string> {
  const d = r.dialog;
  if (!active(d) || d.slots._nudged === true || (ran ?? []).some((n) => n === d.intent || MUTATING.has(n))) return "";
  await saveDialog(r.ctx, r.who, d, { ...d, slots: { ...d.slots, _nudged: true } });
  const what = typeof d.slots.what === "string" ? d.slots.what : null;
  if (d.intent === "create_reminder") {
    return what ? `\nStill want the reminder to ${what}? Tell me when.` : "\nStill want that reminder? Tell me what it's for, or say never mind.";
  }
  return "\nI'm still waiting on your earlier request. Answer it, or say never mind.";
}

/** Runs calls in order; saves the dialog for the first missing slot, or the idle row after a completed mutation. */
async function runTools(r: Run, calls: { name: ToolName; args: Record<string, unknown> }[], out: { name: ToolName; res: ToolResult }[] = []): Promise<string[]> {
  const { ctx, who, msg } = r;
  const d = r.dialog;
  const sources = [...(d?.sources ?? []), cut(r.text, MAX_TEXT)];
  const renders: string[] = [];
  let asked = false;
  for (let i = 0; i < calls.length; i++) {
    const c = calls[i]!;
    const env: ToolEnv = { msg, who, sources: MUTATING.has(c.name) ? sources : [cut(r.text, MAX_TEXT)], dialog: d, now: ctx.clock.now(), index: i };
    const res = await TOOLS[c.name](ctx, c.args, env);
    out.push({ name: c.name, res });
    r.flags.push(...(res.flags ?? []));
    r.tools.push({ name: c.name, ok: res.ok, note: res.missing?.length ? `missing:${res.missing.join("+")}` : res.ok ? "ok" : cut(res.render, 60) });

    if (res.missing?.length && !asked) {
      asked = true;
      const questions = (active(d) && d.intent === c.name ? d.questions : 0) + 1;
      if (questions > MAX_QUESTIONS) {
        await clearDialog(ctx, who);
        r.flags.push("dialog_gave_up");
        renders.push(`I still need ${res.missing[0] === "when" ? "a time" : res.missing[0] === "what" ? "what it's for" : "a bit more"}. Try: remind me at 6pm to call mom.`);
        continue;
      }
      const slots = { ...((res.data as MissingData | undefined)?.slots ?? {}) };
      const saved = await saveDialog(ctx, who, d, {
        intent: c.name, slots, missing: res.missing, asked: res.missing[0] ?? null, sources, lastAction: d?.lastAction ?? null, questions,
      });
      if (!saved) r.flags.push("dialog_conflict");
    } else if (res.ok && MUTATING.has(c.name) && !asked) {
      const lastAction = res.entityId ? { tool: c.name, id: res.entityId, title: res.title ?? "", at: ctx.clock.now().toISOString() } : (d?.lastAction ?? null);
      if (!(await saveDialog(ctx, who, d, { intent: "idle", slots: {}, missing: [], asked: null, sources: [cut(r.text, 300)], lastAction, questions: 0 }))) {
        r.flags.push("dialog_conflict");
      }
    }
    if (res.render) renders.push(res.render);
  }
  return renders;
}
