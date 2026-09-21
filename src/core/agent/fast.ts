// Exact short commands (PLAN_V3 B.1): whole-message grammar only, no LLM. Everything else goes to PLAN.
import { formatStatus } from "../channels/format.ts";
import { materialise } from "../reminders/engine.ts";
import { loadRules } from "../reminders/rules.ts";
import { closeReminder, lastDelivered, snoozeReminder } from "../reminders/snooze.ts";
import { replyDrop, replyTasks, resolveDoneIndex, resolveListRef } from "../tasks/service.ts";
import { renderTrace } from "../trace/render.ts";
import { localTimeOf } from "../time.ts";
import type { AgentContext, DialogState } from "../types.ts";
import type { Target } from "./contract.ts";
import { agendaText } from "./agenda.ts";
import { replyLanguage } from "./lang.ts";
import { norm } from "./provenance.ts";
import { greetReply, HELP_TEXT } from "./render.ts";
import { listReminders } from "./tools/reminders.ts";

export type FastCmd =
  | { kind: "status" | "tasks" | "rules" | "help" }
  | { kind: "done"; index?: number }
  | { kind: "drop" | "confirm"; index: number }
  /** `bare`: "snooze 90" — the number is a list index only if that item exists, else it means minutes (audit 9). */
  | { kind: "snooze"; index?: number; minutes: number; bare?: true }
  | { kind: "cancel"; index?: number }
  | { kind: "trace"; n: number }
  | { kind: "greet" | "thanks" | "ack" | "agenda" | "reminders" };

// audit 15: greetings, thanks and acks are whole messages with no content; they must never cost a PLAN call.
const GREET = new Set([
  "hi", "hii", "hiii", "hello", "helo", "hey", "heyy", "yo", "hola", "namaste", "namaskar", "salaam", "hi there",
  "hello there", "hey there", "good morning", "good afternoon", "good evening", "gm", "ge", "sup", "whats up",
  "what's up", "kya haal hai", "kaise ho", "hi brain", "hey brain",
]);
const THANKS = new Set([
  "thanks", "thank you", "thanku", "thankyou", "thx", "tnx", "ty", "thanks a lot", "thanks man", "thanks yaar",
  "shukriya", "dhanyavaad", "dhanyawad", "🙏", "thank u",
]);
const ACK = new Set([
  "ok", "okay", "oky", "k", "kk", "okey", "okie", "cool", "nice", "great", "got it", "fine", "alright",
  "theek hai", "thik hai", "acha", "accha", "hmm", "hm", "a", "👍", "👌", "✅", "😊", "😄",
]);
const AGENDA = new Set([
  "what's next", "whats next", "what next", "agenda", "my agenda", "my day", "today's agenda", "todays agenda",
  "what's on today", "whats on today", "aaj kya hai", "plan for today", "what do i have today",
]);
const REMINDERS = new Set([
  "reminders", "my reminders", "reminder list", "list reminders", "show reminders", "upcoming reminders",
  "what reminders do i have", "mere reminders",
]);

const DUR = "(\\d{1,4})\\s?(m|min|mins|minutes?|h|hr|hrs|hours?)";
const SNOOZE_RE = new RegExp(`^snooze(?:\\s+#?(\\d{1,3}))?(?:\\s+(?:for\\s+)?${DUR})?$`);

/** trim, lowercase, strip a leading "/", trailing .!?, a leading/trailing please|pls. */
function clean(text: string): string {
  let t = text.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
  t = t.replace(/^\//, "").replace(/[.!?]+$/, "").trim();
  t = t.replace(/^(?:please|pls|plz)\s+/, "").replace(/\s+(?:please|pls|plz)$/, "").replace(/[,.!?]+$/, "");
  return t.trim();
}

const toMinutes = (n: string, unit: string): number => (unit.startsWith("h") ? Number(n) * 60 : Number(n));

export function parseFast(text: string): FastCmd | null {
  if (typeof text !== "string" || text.length > 60) return null;
  const t = clean(text);
  if (t === "status") return { kind: "status" };
  if (t === "tasks" || t === "today") return { kind: "tasks" };
  if (t === "rules") return { kind: "rules" };
  if (t === "help" || t === "start") return { kind: "help" };
  if (t === "done") return { kind: "done" };
  if (t === "cancel") return { kind: "cancel" };

  const idx = /^(done|drop|confirm|cancel) #?(\d{1,3})$/.exec(t);
  if (idx) {
    const index = Number(idx[2]);
    if (index < 1) return null;
    return { kind: idx[1] as "done" | "drop" | "confirm" | "cancel", index } as FastCmd;
  }

  const sn = SNOOZE_RE.exec(t);
  if (sn) {
    const minutes = sn[2] ? toMinutes(sn[2], sn[3]!) : 10;
    if (!(minutes >= 1 && minutes <= 1440)) return null;
    if (!sn[1]) return { kind: "snooze", minutes };
    return sn[2] ? { kind: "snooze", index: Number(sn[1]), minutes } : { kind: "snooze", index: Number(sn[1]), minutes, bare: true };
  }

  const tr = /^trace(?: (\d{1,3}))?$/.exec(t);
  if (tr) return { kind: "trace", n: Math.min(10, Math.max(1, Number(tr[1] ?? 5))) };

  // Whole-message greetings/acks and the two code-rendered questions (audit 15 + D).
  const w = t.replace(/[^\p{L}\p{N}'\s\u{1F300}-\u{1FAFF}✅\u{1F44D}\u{1F44C}\u{1F64F}]/gu, "").replace(/\s+/g, " ").trim();
  if (GREET.has(w)) return { kind: "greet" };
  if (THANKS.has(w)) return { kind: "thanks" };
  if (ACK.has(w)) return { kind: "ack" };
  if (AGENDA.has(w)) return { kind: "agenda" };
  if (REMINDERS.has(w)) return { kind: "reminders" };
  return null;
}

const CANCEL = new Set([
  "cancel", "cancel it", "never mind", "nevermind", "nvm", "forget it", "forget about it", "stop", "no need",
  "leave it", "skip", "skip it", "rehne do", "rehne de", "rahne do", "chhodo", "chodo", "chhod do", "chod do",
  "jane do", "jaane do", "mat karo", "nahi chahiye",
]);

/** Whole-message cancel words (PLAN_V3 B.2), English and Hinglish. */
export function isCancelWords(text: string): boolean {
  if (typeof text !== "string" || text.length > 40) return false;
  const t = norm(text).replace(/\s+(?:please|pls|thanks|yaar)$/, "");
  return CANCEL.has(t) || CANCEL.has(t.replace(/^(?:ok|okay|no|nah|actually)\s+/, ""));
}

/* ------------------------------------------------------------------ execution */

const NO_ITEM = (n: number): string => `No item ${n} in the last list. Send 'tasks' or 'status'.`;

async function rulesText(ctx: AgentContext): Promise<string> {
  const rules = await loadRules(ctx);
  const fallback = ctx.config.reminders.offsets.join(", ");
  return [
    "Reminder rules (how long before the due time):",
    ...rules.filter((r) => r.id !== "default").map((r) => `${r.id}: ${r.offsets.length ? r.offsets.join(", ") : fallback}`),
    `everything else: ${fallback}`,
    "Edit Meta/rules.json in your vault to change them.",
  ].join("\n");
}

/** The reminder a bare "cancel" means: the last action in this chat (< dialog TTL), else the last delivered one. */
async function lastReminderId(ctx: AgentContext, who: Target, dialog: DialogState | null): Promise<string | null> {
  const la = dialog?.lastAction;
  if (la && /reminder/.test(la.tool) && la.id) return la.id;
  return (await lastDelivered(ctx, who))[0] ?? null;
}

/** Runs a fast command. null = nothing to act on: the message falls through to PLAN (bare done/cancel only). */
export async function runFast(ctx: AgentContext, cmd: FastCmd, who: Target, dialog: DialogState | null, text = ""): Promise<string | null> {
  const tz = ctx.clock.tz;
  const EMPTY_MSG = { channel: who.channel, id: "fast", from: who.peer, text, at: ctx.clock.now().toISOString() };
  switch (cmd.kind) {
    case "status":
      return formatStatus(ctx, who);
    case "tasks":
      return replyTasks(ctx, who);
    case "rules":
      return rulesText(ctx);
    case "help":
      return HELP_TEXT;
    case "trace":
      return renderTrace(await ctx.store.listTrace(cmd.n), tz);
    case "greet":
    case "thanks":
    case "ack":
      return greetReply(cmd.kind, ctx.clock.now(), tz, replyLanguage(text));
    case "agenda":
      return agendaText(ctx, who);
    case "reminders":
      return (await listReminders(ctx, { range: "upcoming" }, { msg: EMPTY_MSG, who, sources: [], dialog, now: ctx.clock.now() })).render;
    case "drop":
      return replyDrop(ctx, cmd.index, who);
    case "done": {
      if (cmd.index === undefined) {
        const id = (await lastDelivered(ctx, who))[0];
        const d = id ? await closeReminder(ctx, id, "done") : null;
        return d ? `Marked done: ${d.title}` : null;
      }
      const r = await resolveDoneIndex(ctx, cmd.index, who);
      if (r.kind === "reply") return r.text;
      const d = await closeReminder(ctx, r.id, "done");
      return d ? `Marked done: ${d.title}` : `Item ${cmd.index} no longer exists. Send 'status' for a fresh list.`;
    }
    case "confirm": {
      const ref = await resolveListRef(ctx, cmd.index, who);
      if (!ref) return NO_ITEM(cmd.index);
      if (ref.k !== "d") return `Item ${cmd.index} is a task. Use 'done ${cmd.index}'.`;
      const d = await ctx.store.getDeadline(ref.id);
      if (!d) return `Item ${cmd.index} no longer exists. Send 'status' for a fresh list.`;
      if (d.status !== "proposed") return `"${d.title}" is already ${d.status}; nothing to confirm.`;
      await ctx.store.setDeadlineStatus(ref.id, "open");
      const n = await materialise(ctx, { ...d, status: "open" });
      return `Confirmed: ${d.title} (${n} reminders scheduled)`;
    }
    case "snooze": {
      let minutes = cmd.minutes;
      let id: string | null = null;
      if (cmd.index === undefined) id = await lastReminderId(ctx, who, dialog); // "snooze 90m" right after setting one
      else {
        const at = await resolveListRef(ctx, cmd.index, who);
        if (at?.k === "d") id = at.id;
        else if (!cmd.bare) return `Item ${cmd.index} is not a reminder in your last list.`;
        else {
          // "snooze 90" with no item 90 in the last list: the number is minutes (audit 9).
          if (!(cmd.index >= 1 && cmd.index <= 1440)) return "For how long? For example: 10 minutes or 1 hour.";
          minutes = cmd.index;
          id = await lastReminderId(ctx, who, dialog);
        }
      }
      if (!id) return "There is no recent reminder to snooze.";
      const r = await snoozeReminder(ctx, id, minutes);
      return r.ok ? `Snoozed: ${r.title} until ${localTimeOf(new Date(r.fireAt), tz)}.` : "I couldn't find that reminder anymore.";
    }
    case "cancel": {
      if (cmd.index !== undefined) {
        const ref = await resolveListRef(ctx, cmd.index, who);
        if (!ref) return NO_ITEM(cmd.index);
        if (ref.k === "t") return `Item ${cmd.index} is a task. Use 'drop ${cmd.index}'.`;
        const d = await closeReminder(ctx, ref.id, "dismissed");
        return d ? `Cancelled: ${d.title}.` : `Item ${cmd.index} no longer exists.`;
      }
      const id = await lastReminderId(ctx, who, dialog);
      const d = id ? await closeReminder(ctx, id, "dismissed") : null;
      return d ? `Cancelled: ${d.title}.` : null;
    }
  }
}
