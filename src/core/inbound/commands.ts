// Inbound chat commands. The handler is the single gate: allowlist, then idempotency,
// then any store write or LLM call.
import { formatStatus, persistListing } from "../channels/format.ts";
import { respond } from "../chat/index.ts";
import { ask } from "../qa/ask.ts";
import { completePending, proposeReminder, type PendingWhen, type RemindProposal } from "../reminders/categorise.ts";
import type { Target } from "../agent/contract.ts";
import { runAgent } from "../agent/handle.ts";
import { createReminder } from "../reminders/create.ts";
import { closeReminder, lastDelivered, parseSnoozeDuration, snoozeReminder } from "../reminders/snooze.ts";
import { renderTrace } from "../trace/render.ts";
import { materialise } from "../reminders/engine.ts";
import { parseReminderRequest } from "../reminders/request.ts";
import { loadRules } from "../reminders/rules.ts";
import {
  parseTaskCommand,
  replyAddTask,
  replyDoneNamed,
  replyDrop,
  replyTasks,
  resolveDoneIndex,
  resolveListRef,
} from "../tasks/index.ts";
import { dueAtFromLocalDate, localDateOf, localTimeOf, parseLooseDate } from "../time.ts";
import type { AgentContext, Command, InboundHandler, InboundMessage, InboundResult } from "../types.ts";

const HELP = [
  "Commands:",
  "status - open deadlines and the next reminder",
  "remind me to <thing> on <date> [time] - or just say it: I have a flight tomorrow 6pm",
  "confirm <n> - activate a proposed deadline",
  "add task <title> [every day|weekday|monday] | tasks | done <n> | drop <n>",
  "done <n> - mark a deadline or task finished (numbering follows your last list)",
  "rules - how far ahead each kind of reminder fires",
  "anything else - ask a question",
].join("\n");

const REMIND_RE = /^remind me to\s+([\s\S]+)\s+on\s+([\s\S]+)$/i;
const CONFIRM_RE = /^confirm\s+#?(\d{1,4})$/i;

export function parseCommand(text: string, ctx: AgentContext): Command {
  const t = text.trim().replace(/^\/(?=[a-z])/i, "");
  const lower = t.toLowerCase();
  if (lower === "status") return { kind: "status" };
  if (lower === "help" || lower === "start") return { kind: "help" };
  if (lower === "rules") return { kind: "rules" };
  const confirm = CONFIRM_RE.exec(t);
  if (confirm) return { kind: "confirm", index: Number(confirm[1]) };
  if (/^remind me to\b/i.test(t)) {
    const m = REMIND_RE.exec(t);
    const date = m ? parseLooseDate(m[2]!) : null;
    const title = m ? m[1]!.replace(/\s+/g, " ").trim().slice(0, 200) : "";
    if (!m || !date || !title) return { kind: "help" };
    return { kind: "remind", title, dueAt: dueAtFromLocalDate(date, ctx.clock.tz, ctx.config.reminders.dueHourLocal), category: "default", timed: false };
  }
  const task = parseTaskCommand(t); // add task / tasks / done <n> / done <title> / drop <n>
  if (task) return task;
  if (t === "") return { kind: "help" };
  return { kind: "ask", question: t };
}

function allowed(ctx: AgentContext, channel: string, from: string): boolean {
  const c = ctx.config.channels;
  const list = channel === "telegram" ? c.telegram.allowedChatIds : channel === "whatsapp" ? c.whatsapp.allowedWaIds : [];
  return list.map(String).includes(from);
}

const who = (msg: InboundMessage): Target => ({ channel: msg.channel, peer: msg.from });

/* ------------------------------------------------------ natural-language reminders */

const PENDING_TTL_MS = 15 * 60_000;
// "remind me ..." / "set a reminder ..." (with polite prefixes). Deciding whether a message is an explicit request
// is separate from parsing its time: an explicit request with no usable time must ASK, never fall through to a guess.
const REMIND_LEAD = /^\s*(?:please\s+)?(?:(?:can|could|would)\s+you\s+)?(?:set\s+(?:me\s+)?(?:a\s+)?reminder|remind\s+me)\b/i;
const ASK_WHEN = "When should I remind you? For example: in 10 minutes, tonight at 8, or tomorrow 6pm.";
const titleKey = (msg: InboundMessage): string => `pending:title:${msg.channel}:${msg.from}`;

function leadTitle(text: string): string {
  return text
    .replace(REMIND_LEAD, "")
    .replace(/^\s*(?:of|about|to|that|:)\s+/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}
const pendingKey = (msg: InboundMessage): string => `pending:when:${msg.channel}:${msg.from}`;

// Deliberately conservative. A QUESTION that mentions a date ("what is due tomorrow?") must never become a
// reminder, so free text is only treated as one when it is a statement about an upcoming event.
const QUESTION_START = /^(what|when|which|who|whom|where|why|how|show|list|tell|give|do|does|did|is|are|was|were|can|could|will|would|any|anything)\b/i;
const EVENT_STATEMENT = /\b(i have|i've got|i got|i'm flying|i am flying|my)\b/i;

function looksLikeReminder(text: string): boolean {
  const t = text.trim();
  if (/^remind me\b/i.test(t)) return true;
  return !t.includes("?") && !QUESTION_START.test(t) && EVENT_STATEMENT.test(t) && t.length <= 240;
}

function when(ctx: AgentContext, dueAt: string, timed: boolean): string {
  const at = new Date(dueAt);
  const day = new Intl.DateTimeFormat("en-GB", { timeZone: ctx.clock.tz, weekday: "short", day: "numeric", month: "short" }).format(at);
  return timed ? `${day} ${localTimeOf(at, ctx.clock.tz)}` : localDateOf(at, ctx.clock.tz);
}

async function propose(
  ctx: AgentContext,
  msg: InboundMessage,
  p: Extract<RemindProposal, { ok: true }> | { title: string; dueAt: string; category: string; timed: boolean; relative?: boolean },
): Promise<string> {
  const id = `chat:${msg.id}`;
  await ctx.store.upsertDeadline({
    id,
    source: "chat",
    sourceRef: `${msg.channel}:${msg.id}`,
    title: p.title,
    dueAt: p.dueAt,
    status: "proposed",
    confidence: 0.9,
    notePath: "Deadlines/index.md",
    category: p.category as never,
    timed: p.timed,
  });
  const d = await ctx.store.getDeadline(id);
  if (d) await persistListing(ctx, [d], who(msg));
  const kind = p.category === "default" ? "" : ` (${p.category})`;
  return `Proposed: "${p.title}"${kind} due ${when(ctx, p.dueAt, p.timed)}. Reply 'confirm 1' to activate reminders.`;
}

/** Returns a reply when the message was a reminder (or the answer to "what time?"); null to route normally. */
async function naturalReminder(ctx: AgentContext, msg: InboundMessage): Promise<string | null> {
  const now = ctx.clock.now();
  const key = pendingKey(msg);
  const rules = await loadRules(ctx);

  // -1. The user was asked "when?" for a titled reminder and is now answering ("in 10 minutes").
  const rawTitle = await ctx.store.kvGet(titleKey(msg));
  if (rawTitle) {
    try {
      const pt = JSON.parse(rawTitle) as { title?: string; exp?: number };
      if (pt.title && typeof pt.exp === "number" && pt.exp > now.getTime()) {
        const answered = parseReminderRequest(`remind me ${msg.text} to ${pt.title}`, rules, ctx.clock.tz, now, ctx.config.reminders.dueHourLocal);
        if (answered?.explicit) {
          await ctx.store.kvSet(titleKey(msg), "", now.toISOString());
          const r = await createReminder(ctx, { ...answered, id: `chat:${msg.id}`, sourceRef: `${msg.channel}:${msg.id}`, origin: who(msg) });
          return `Reminder set for ${when(ctx, r.dueAt, answered.timed)}: ${answered.title}`;
        }
      }
    } catch {
      /* a corrupt or unanswerable pending question is simply dropped */
    }
  }

  // 0. An EXPLICIT request ("remind me in 2 minutes to drink water", "set a reminder for 5pm ...") is active at
  //    once: no confirm step. Statements ("I have a flight tomorrow 6pm") still fall through to the proposal flow.
  const req = parseReminderRequest(msg.text, rules, ctx.clock.tz, now, ctx.config.reminders.dueHourLocal);
  if (req?.explicit) {
    try {
      const r = await createReminder(ctx, { ...req, id: `chat:${msg.id}`, sourceRef: `${msg.channel}:${msg.id}`, origin: who(msg) });
      return `Reminder set for ${when(ctx, r.dueAt, req.timed)}: ${req.title}`;
    } catch (e) {
      return e instanceof RangeError
        ? "That time has already passed. When should I remind you?"
        : "I couldn't set that reminder. Try: remind me in 10 minutes to stretch";
    }
  }

  if (REMIND_LEAD.test(msg.text)) {
    const title = leadTitle(msg.text);
    if (title) await ctx.store.kvSet(titleKey(msg), JSON.stringify({ title, exp: now.getTime() + PENDING_TTL_MS }), now.toISOString());
    return title ? `When should I remind you about "${title}"? For example: in 10 minutes, tonight at 8, or tomorrow 6pm.` : ASK_WHEN;
  }

  // 1. An earlier message was missing a clock time; this one may be the answer ("6pm").
  const raw = await ctx.store.kvGet(key);
  if (raw) {
    try {
      const pending = JSON.parse(raw) as PendingWhen & { exp?: number };
      if (typeof pending.exp === "number" && pending.exp > now.getTime()) {
        const done = completePending(pending, msg.text, rules, ctx.clock.tz, now, ctx.config.reminders.dueHourLocal);
        if (done) {
          await ctx.store.kvSet(key, "", now.toISOString());
          return propose(ctx, msg, done);
        }
      }
    } catch {
      /* corrupt pending state is dropped */
    }
  }

  // 2. A fresh statement.
  if (!looksLikeReminder(msg.text)) return null;
  const p = proposeReminder(msg.text, rules, ctx.clock.tz, now, ctx.config.reminders.dueHourLocal);
  if (p.ok) {
    if (Date.parse(p.dueAt) <= now.getTime()) return "That time has already passed. When should it be?";
    return propose(ctx, msg, p);
  }
  if (p.reason === "needs-time") {
    await ctx.store.kvSet(key, JSON.stringify({ ...p.pending, exp: now.getTime() + PENDING_TTL_MS }), now.toISOString());
    return p.ask;
  }
  return null; // no date found: fall through to the normal routing
}

/* --------------------------------------------- replies to a delivered reminder + trace */

const SNOOZE_RE = /^snooze(?:\s+(?:for\s+)?(.+))?$/i;

/** "snooze [10m]" / "done" / "cancel" act on the reminder just delivered to THIS chat; "trace [n]" shows recent traces. */
async function reminderReply(ctx: AgentContext, msg: InboundMessage): Promise<string | null> {
  const t = msg.text.trim().replace(/^\//, "").toLowerCase();
  const tr = /^trace(?:\s+(\d{1,2}))?$/.exec(t);
  if (tr) {
    const n = Math.min(10, Math.max(1, Number(tr[1] ?? 5)));
    return renderTrace(await ctx.store.listTrace(n), ctx.clock.tz);
  }
  const sn = SNOOZE_RE.exec(t);
  const isDone = t === "done" || t === "done!" || t === "did it";
  const isCancel = t === "cancel" || t === "cancel reminder" || t === "stop";
  if (!sn && !isDone && !isCancel) return null;
  const ids = await lastDelivered(ctx, who(msg));
  if (ids.length === 0) return sn ? "There is no recent reminder to snooze." : null; // bare "done"/"cancel" fall through
  const id = ids[0]!;
  if (sn) {
    const minutes = sn[1] ? parseSnoozeDuration(sn[1]) : 10;
    if (minutes === null) return "How long should I snooze it? For example: snooze 10m, snooze 1h.";
    const r = await snoozeReminder(ctx, id, minutes);
    return r.ok ? `Snoozed: ${r.title}. I'll remind you again at ${localTimeOf(new Date(r.fireAt), ctx.clock.tz)}.` : "I couldn't find that reminder anymore.";
  }
  const d = await closeReminder(ctx, id, isDone ? "done" : "dismissed");
  if (!d) return "I couldn't find that reminder anymore.";
  return isDone ? `Marked done: ${d.title}` : `Cancelled: ${d.title}`;
}

/* ------------------------------------------------------------------------ handler */

export const handleInbound: InboundHandler = async (ctx, msg) => {
  if (!allowed(ctx, msg.channel, msg.from)) return null;
  if (!(await ctx.store.markProcessed(`${msg.channel}:${msg.id}`, ctx.clock.now().toISOString()))) return null;

  const quick = await reminderReply(ctx, msg);
  if (quick !== null) return quick;

  const natural = await naturalReminder(ctx, msg);
  if (natural !== null) return natural;

  const cmd = parseCommand(msg.text, ctx);
  switch (cmd.kind) {
    case "help":
      return HELP;
    case "status":
      return formatStatus(ctx, who(msg));
    case "tasks":
      return replyTasks(ctx, who(msg));
    case "addTask":
      return replyAddTask(ctx, { title: cmd.title, recurrence: cmd.recurrence }, who(msg));
    case "doneNamed":
      return replyDoneNamed(ctx, cmd.title);
    case "drop":
      return replyDrop(ctx, cmd.index, who(msg));
    case "rules": {
      const rules = await loadRules(ctx);
      const fallback = ctx.config.reminders.offsets.join(", ");
      return [
        "Reminder rules (how long before the due time):",
        ...rules.filter((r) => r.id !== "default").map((r) => `${r.id}: ${r.offsets.length ? r.offsets.join(", ") : fallback}`),
        `everything else: ${fallback}`,
        "Edit Meta/rules.json in your vault to change them.",
      ].join("\n");
    }
    case "remind":
      return propose(ctx, msg, cmd);
    case "done": {
      const r = await resolveDoneIndex(ctx, cmd.index, who(msg)); // unified numbering across tasks and deadlines
      if (r.kind === "reply") return r.text;
      const d = await ctx.store.getDeadline(r.id);
      if (!d) return `Item ${cmd.index} no longer exists. Send 'status' for a fresh list.`;
      await ctx.store.setDeadlineStatus(r.id, "done");
      await ctx.store.deleteUnsentReminders(r.id);
      return `Marked done: ${d.title}`;
    }
    case "confirm": {
      const ref = await resolveListRef(ctx, cmd.index, who(msg));
      if (!ref) return `No item ${cmd.index} in the last list. Send 'status' to see the current numbering.`;
      if (ref.k !== "d") return `Item ${cmd.index} is a task. Use 'done ${cmd.index}'.`;
      const d = await ctx.store.getDeadline(ref.id);
      if (!d) return `Item ${cmd.index} no longer exists. Send 'status' for a fresh list.`;
      if (d.status !== "proposed") return `"${d.title}" is already ${d.status}; nothing to confirm.`;
      await ctx.store.setDeadlineStatus(ref.id, "open");
      const n = await materialise(ctx, { ...d, status: "open" });
      return `Confirmed: ${d.title} (${n} reminders scheduled)`;
    }
    case "ask": {
      if (ctx.config.chat.enabled) {
        try {
          return await respond(ctx, msg, cmd.question); // never throws; degrades to facts on its own
        } catch {
          /* fall through to the v1 route */
        }
      }
      if (!ctx.brain) return formatStatus(ctx);
      try {
        return (await ask(ctx, cmd.question)).answer;
      } catch {
        return formatStatus(ctx);
      }
    }
  }
};

/**
 * v3 entry point (config chat.engine = "v3"): same gate as the legacy handler (allowlist, then idempotency), then the
 * agent core. Returns null when the message must be ignored. The agent owns its trace draft; the Worker finishes it.
 */
export async function handleInboundV3(
  ctx: AgentContext,
  msg: InboundMessage,
  opts?: { onTrace?: (t: InboundResult["trace"]) => void; deferAfter?: boolean },
): Promise<InboundResult | null> {
  if (!allowed(ctx, msg.channel, msg.from)) return null;
  if (!(await ctx.store.markProcessed(`${msg.channel}:${msg.id}`, ctx.clock.now().toISOString()))) return null;
  return runAgent(ctx, msg, opts);
}
