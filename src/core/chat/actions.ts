// Model output parsing, provenance checking and deterministic execution of the small validated action set.
import { parseReminderRequest } from "../reminders/request.ts";
import { createReminder } from "../reminders/create.ts";
import { loadRules } from "../reminders/rules.ts";
import { addTask, completeByName, dropTask } from "../tasks/index.ts";
import { normaliseTitle } from "../tasks/text.ts";
import { localDateOf, localTimeOf } from "../time.ts";
import type { AgentContext, InboundMessage } from "../types.ts";

export type Action =
  | { type: "reminder"; text: string; when: string }
  | { type: "add_task"; title: string; every: string | null }
  | { type: "done_task"; title: string }
  | { type: "drop_task"; title: string };

export const MAX_ACTIONS = 3;
const MAX_REPLY_IN = 6000;
const MAX_FIELD = 200;

const str = (v: unknown, max = MAX_FIELD): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

function validate(a: unknown): Action | null {
  if (!a || typeof a !== "object") return null;
  const o = a as Record<string, unknown>;
  switch (o.type) {
    case "reminder": {
      const text = str(o.text);
      const when = str(o.when, 80);
      return text && when ? { type: "reminder", text, when } : null;
    }
    case "add_task": {
      const title = str(o.title);
      if (!title) return null;
      const every = str(o.every, 60);
      return { type: "add_task", title, every: every && every.toLowerCase() !== "null" ? every : null };
    }
    case "done_task":
    case "drop_task": {
      const title = str(o.title);
      return title ? { type: o.type, title } : null;
    }
    default:
      return null;
  }
}

/** Every balanced top-level {...} span in `s` (string-aware). */
function objectSpans(s: string): string[] {
  const spans: string[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "{") continue;
    let depth = 0;
    let inStr = false;
    for (let j = i; j < s.length; j++) {
      const c = s[j];
      if (inStr) {
        if (c === "\\") j++;
        else if (c === "\"") inStr = false;
      } else if (c === "\"") inStr = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        spans.push(s.slice(i, j + 1));
        i = j;
        break;
      }
    }
  }
  return spans;
}

function tryJson(s: string): unknown {
  for (const candidate of [s, s.replace(/,\s*([}\]])/g, "$1")]) {
    try {
      return JSON.parse(candidate);
    } catch {
      /* try the next repair */
    }
  }
  return undefined;
}

/** Tolerant: code fences, prose around the JSON, trailing commas. Plain text becomes a reply with no actions. */
export function parseModelOutput(raw: string): { reply: string; actions: Action[] } {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return { reply: "", actions: [] };
  const unfenced = text.replace(/```(?:json|JSON)?\s*([\s\S]*?)```/g, "$1");
  for (const span of objectSpans(unfenced)) {
    const v = tryJson(span);
    if (v && typeof v === "object" && !Array.isArray(v) && ("reply" in v || "actions" in v)) {
      const o = v as { reply?: unknown; actions?: unknown };
      const list = Array.isArray(o.actions) ? o.actions : [];
      const actions = list.map(validate).filter((a): a is Action => a !== null).slice(0, MAX_ACTIONS);
      return { reply: typeof o.reply === "string" ? o.reply.trim().slice(0, MAX_REPLY_IN) : "", actions };
    }
  }
  // Truncated/garbled JSON: never show raw JSON to the user.
  if (/^\s*[{[]/.test(unfenced) && /"reply"\s*:/.test(unfenced)) {
    const m = /"reply"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(unfenced);
    if (m) {
      const r = tryJson(`"${m[1]}"`);
      return { reply: typeof r === "string" ? r.trim() : "", actions: [] };
    }
    return { reply: "", actions: [] };
  }
  return { reply: text.slice(0, MAX_REPLY_IN), actions: [] };
}

/* ------------------------------------------------------------ provenance */

const norm = (s: string): string => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const STOP = new Set(["the", "and", "for", "you", "your", "with", "that", "this", "please", "remind", "task", "add", "set", "reminder", "from", "into", "about"]);

function significant(s: string): string[] {
  const all = norm(s).split(" ").filter(Boolean);
  const sig = all.filter((w) => w.length >= 3 && !STOP.has(w));
  return sig.length ? sig : all.filter((w) => !STOP.has(w));
}

function wordsCovered(text: string, userNorm: string): boolean {
  const words = significant(text);
  if (words.length === 0) return false;
  const user = new Set(userNorm.split(" "));
  const hit = words.filter((w) => user.has(w) || (w.length >= 4 && userNorm.includes(w))).length;
  return hit / words.length >= 0.6;
}

/**
 * An action runs only when it derives from the user's CURRENT message: the `when` phrase must appear in it and the
 * subject text must share >= 60% of its significant words with it. Text injected via notes/emails/issues cannot.
 */
export function derivesFromUser(a: Action, userText: string): boolean {
  const u = norm(userText);
  if (!u) return false;
  if (a.type === "reminder") {
    const w = norm(a.when);
    return w !== "" && (` ${u} `).includes(` ${w} `) && wordsCovered(a.text, u);
  }
  return wordsCovered(a.title, u);
}

/* ------------------------------------------------------------ execution */

const EVERY: Record<string, string> = { day: "every day", daily: "daily", weekday: "every weekday", weekdays: "weekdays" };
function recurrenceInput(every: string | null): string | null {
  if (!every) return null;
  const e = every.trim().toLowerCase();
  return EVERY[e] ?? (/^(every|weekly)\b/.test(e) ? e : `every ${e}`);
}

const WEEKDAY = (at: Date, tz: string): string => new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short" }).format(at);

async function doReminder(ctx: AgentContext, msg: InboundMessage, userText: string, a: Extract<Action, { type: "reminder" }>, index: number): Promise<string> {
  const ask = (why: string): string => `⚠️ I couldn't set that: ${why}. What time should it be?`;
  const now = ctx.clock.now();
  const tz = ctx.clock.tz;
  const hour = ctx.config.reminders.dueHourLocal;
  const rules = await loadRules(ctx);
  const req =
    [userText, `remind me ${a.when} to ${a.text}`]
      .map((t) => parseReminderRequest(t, rules, tz, now, hour))
      .find((r) => r !== null && r.explicit) ?? null;
  if (!req) return ask("I could not work out the time");
  try {
    const made = await createReminder(ctx, { ...req, id: `chat:${msg.id}:${index}`, sourceRef: `chat:${msg.id}` });
    const at = new Date(made.dueAt);
    return `✅ Reminder set: ${req.title}, ${a.when} (${WEEKDAY(at, tz)} ${localTimeOf(at, tz)}${localDateOf(at, tz) === localDateOf(now, tz) ? "" : ` on ${localDateOf(at, tz)}`})`;
  } catch (e) {
    return ask(e instanceof RangeError ? "that time is in the past" : "something went wrong saving it");
  }
}

async function one(ctx: AgentContext, msg: InboundMessage, userText: string, a: Action, index: number): Promise<string> {
  switch (a.type) {
    case "reminder":
      return doReminder(ctx, msg, userText, a, index);
    case "add_task": {
      const r = await addTask(ctx, { title: a.title, recurrence: recurrenceInput(a.every) });
      if (!r.ok) {
        return r.reason === "limit" ? "⚠️ Your task list is full for today." : r.reason === "bad-recurrence" ? "⚠️ I couldn't read that repeat rule." : "⚠️ I couldn't add that task.";
      }
      const rec = r.template ? ` (repeats: ${r.template.recurrence})` : "";
      return r.created || r.template ? `✅ Task added: ${r.task.title}${rec}` : `Already on your list: ${r.task.title}`;
    }
    case "done_task": {
      const r = await completeByName(ctx, a.title);
      if (r.kind === "done") return `✅ Marked done: ${r.task.title}`;
      return r.kind === "none" ? `⚠️ No open task matching "${a.title}".` : `⚠️ Several tasks match "${a.title}". Which one?`;
    }
    case "drop_task": {
      const q = normaliseTitle(a.title);
      const open = await ctx.store.listTasks({ status: ["open"] });
      const hits = open.filter((t) => normaliseTitle(t.title) === q);
      const cand = hits.length ? hits : open.filter((t) => q && normaliseTitle(t.title).includes(q));
      if (cand.length === 0) return `⚠️ No open task matching "${a.title}".`;
      if (cand.length > 1) return `⚠️ Several tasks match "${a.title}". Which one?`;
      await dropTask(ctx, cand[0]!.id);
      return `✅ Dropped: ${cand[0]!.title}`;
    }
  }
}

/** Runs the provenance-checked actions in order. Confirmation lines come from code, never the model. Never throws. */
export async function executeActions(ctx: AgentContext, msg: InboundMessage, userText: string, actions: Action[]): Promise<string[]> {
  const lines: string[] = [];
  const checked = actions.slice(0, MAX_ACTIONS);
  for (let i = 0; i < checked.length; i++) {
    const a = checked[i]!;
    if (!derivesFromUser(a, userText)) continue;
    try {
      lines.push(await one(ctx, msg, userText, a, i));
    } catch {
      lines.push("⚠️ I couldn't do that one.");
    }
  }
  return lines;
}
