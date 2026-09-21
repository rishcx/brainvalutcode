// PLAN output tolerance + validation (PLAN_V3 B.3). Takes the LAST complete JSON object that has "intent"
// (models that think in JSON emit drafts first), drops unknown tools, coerces/clamps args. Never throws.
import { cleanText } from "../chat/text.ts";
import { INTENTS, MAX_ITEMS, MAX_NOTE, MAX_QUERY, MAX_SPAN, MAX_TOOLS, TOOL_NAMES, type Intent, type Plan, type Ref, type ToolCall, type ToolName } from "./contract.ts";

const MAX_SAY = 200;
const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

/** Top-level {...} blocks, string-aware. */
function objects(raw: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = depth > 0;
    else if (c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}" && depth > 0) {
      depth--;
      if (depth === 0) out.push(raw.slice(start, i + 1));
    }
  }
  return out;
}

function tryJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    try {
      return JSON.parse(s.replace(/,\s*([}\]])/g, "$1"));
    } catch {
      return undefined;
    }
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function str(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = cleanText(v).replace(/\s+/g, " ").trim();
  return t ? t.slice(0, max) : null;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], dflt: T): T {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  return (allowed as readonly string[]).includes(s) ? (s as T) : dflt;
}

function ref(v: unknown): Ref | null {
  if (typeof v === "number") return Number.isInteger(v) && v >= 1 ? { index: v } : null;
  if (typeof v === "string") {
    if (v.trim().toLowerCase() === "last") return { last: true };
    const t = str(v, MAX_SPAN);
    return t ? { text: t } : null;
  }
  if (!isObj(v)) return null;
  const r: Ref = {};
  if (typeof v.index === "number" && Number.isInteger(v.index) && v.index >= 1) r.index = v.index;
  else if (typeof v.index === "string" && /^\d{1,3}$/.test(v.index.trim()) && Number(v.index) >= 1) r.index = Number(v.index);
  const text = str(v.text, MAX_SPAN);
  if (text) r.text = text;
  if (v.last === true || v.last === "true") r.last = true;
  return r.index !== undefined || r.text !== undefined || r.last ? r : null;
}

function every(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase().replace(/^every\s+/, "");
  if (s === "day" || s === "daily") return "day";
  if (s === "weekday" || s === "weekdays") return "weekday";
  return WEEKDAYS.includes(s) ? s : null;
}

function atLocal(v: unknown): string | null {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v.trim()) ? v.trim().slice(0, 16) : null;
}

function args(name: ToolName, a: Record<string, unknown>, flags: string[]): Record<string, unknown> {
  switch (name) {
    case "create_reminder":
      return { what: str(a.what, MAX_SPAN), when_text: str(a.when_text, MAX_SPAN), at_local: atLocal(a.at_local) };
    case "reschedule_reminder":
      return { ref: ref(a.ref), when_text: str(a.when_text, MAX_SPAN), at_local: atLocal(a.at_local) };
    case "cancel_reminder":
    case "complete_task":
    case "drop_task":
      return { ref: ref(a.ref) };
    case "snooze_reminder": {
      const m = typeof a.minutes === "number" ? a.minutes : typeof a.minutes === "string" ? Number(a.minutes) : NaN;
      return { ref: ref(a.ref), minutes: Number.isFinite(m) && m >= 1 && m <= 1440 ? Math.round(m) : null };
    }
    case "list_reminders":
      return { range: oneOf(a.range, ["today", "upcoming", "recent", "fired", "past"], "upcoming") };
    case "add_tasks": {
      const raw = Array.isArray(a.items) ? a.items : [];
      if (raw.length > MAX_ITEMS) flags.push("too_many_items");
      const items = raw.slice(0, MAX_ITEMS).flatMap((it) => {
        const text = typeof it === "string" ? str(it, MAX_SPAN) : isObj(it) ? str(it.text, MAX_SPAN) : null;
        return text ? [{ text, every: isObj(it) ? every(it.every) : null }] : [];
      });
      return { items, truncated: raw.length > MAX_ITEMS };
    }
    case "list_tasks": {
      const d = typeof a.day === "string" ? a.day.trim().toLowerCase() : "";
      const day = d === "tomorrow" || /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : "today";
      return { day, include_done: a.include_done === true };
    }
    case "list_deadlines":
      return { range: oneOf(a.range, ["today", "tomorrow", "week", "overdue", "upcoming"], "upcoming") };
    case "github_involvement":
      return { bucket: oneOf(a.bucket, ["assigned", "prs", "reviews", "mentions", "all"], "all") };
    case "search_notes":
      return { query: str(a.query, MAX_QUERY) };
    case "add_note":
      return { text: str(a.text ?? a.note ?? a.content, MAX_NOTE) };
  }
}

function validate(o: Record<string, unknown>, flags: string[]): Plan | null {
  const rawTools = Array.isArray(o.tools) ? o.tools : [];
  const tools: ToolCall[] = [];
  for (const t of rawTools) {
    const name = isObj(t) ? t.name : undefined;
    if (typeof name !== "string" || !(TOOL_NAMES as readonly string[]).includes(name)) {
      flags.push("bad_tool");
      continue;
    }
    const a = isObj(t) && isObj(t.args) ? t.args : {};
    tools.push({ name: name as ToolName, args: args(name as ToolName, a, flags) });
  }
  if (tools.length > MAX_TOOLS) {
    flags.push("too_many_tools");
    tools.length = MAX_TOOLS;
  }
  // Every tool the model asked for was unknown: the request is genuinely unsupported. Synthesising the intent's
  // tool with empty args would ask for slots the user never mentioned ("note that..." -> "Which tasks?", audit 10).
  if (rawTools.length > 0 && tools.length === 0) {
    flags.push("all_tools_dropped");
    return { intent: "unsupported", tools: [], say: str(o.say, MAX_SAY) ?? "", compose: false };
  }
  let intent = typeof o.intent === "string" ? o.intent.trim().toLowerCase() : "";
  if (!(INTENTS as readonly string[]).includes(intent)) {
    if (tools.length === 0) return null;
    flags.push("bad_intent");
    intent = tools[0]!.name;
  }
  // An action intent with no tool call: run that tool with empty args so code asks for the slots.
  if (tools.length === 0 && (TOOL_NAMES as readonly string[]).includes(intent)) {
    tools.push({ name: intent as ToolName, args: args(intent as ToolName, {}, flags) });
  }
  return { intent: intent as Intent, tools, say: str(o.say, MAX_SAY) ?? "", compose: o.compose === true };
}

export function parsePlan(raw: string): { plan: Plan | null; flags: string[] } {
  const flags: string[] = [];
  if (typeof raw !== "string" || !raw.trim()) return { plan: null, flags: ["empty"] };
  const text = raw.replace(/<think>[\s\S]*?<\/think>/gi, "");
  const candidates = objects(text)
    .map(tryJson)
    .filter((v): v is Record<string, unknown> => isObj(v) && "intent" in v);
  for (let i = candidates.length - 1; i >= 0; i--) {
    const f: string[] = [];
    const plan = validate(candidates[i]!, f);
    if (plan) return { plan, flags: [...new Set(f)] };
    flags.push(...f);
  }
  flags.push("unparseable");
  return { plan: null, flags: [...new Set(flags)] };
}
