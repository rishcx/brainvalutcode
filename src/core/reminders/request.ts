// Natural-language reminder requests: "remind me after 2 mins to drink water", "set a timer for 5 minutes",
// "I have a flight tomorrow 6pm". Pure and total: never throws, null when no usable future time is found.
import { sanitiseTitle } from "../tasks/text.ts";
import type { CategoryId, ReminderRule } from "../types.ts";
import { extractHashtag, proposeReminder } from "./categorise.ts";
import { parseRelativeWhen } from "./relative.ts";
import { categorise } from "./rules.ts";

export interface ReminderRequest {
  title: string;
  dueAt: string; // ISO UTC, strictly in the future
  timed: boolean; // a real clock time / duration, not the dueHourLocal default
  category: CategoryId;
  explicit: boolean; // an imperative "remind me ..." request: active at once, no confirm step
  relative: boolean;
}

const PRE = "^\\s*(?:(?:hey|hi|hello|ok(?:ay)?|yo)[\\s,!.]+)?(?:(?:please|pls|plz|kindly)[\\s,]+)?(?:(?:can|could|would|will)\\s+you\\s+(?:please\\s+|pls\\s+)?)?";
const NOUN = "(reminder|remaining|remainder|remainer|reminer|timer|alarm)s?";
// The offline path must survive the typos the model would otherwise absorb: "remaind me", "remnd me" (audit 17).
const REMIND = "rem[ai]{0,2}nde?"; // remind, remaind, remnd, reminde
const IMPERATIVE = new RegExp(
  `${PRE}(?:${REMIND}\\s+me\\b|(?:set|add|create|make|put|schedule)\\s+(?:me\\s+)?(?:up\\s+)?(?:an?\\s+|the\\s+|my\\s+|another\\s+|one\\s+)?(?:new\\s+)?${NOUN}\\b|${NOUN}\\s*[:\\-\\u2013]|(?:timer|alarm)\\s+(?:for|of)\\b)`,
  "i",
);

// Same conservative gate the chat handler uses: a QUESTION that mentions a date must never become a proposal.
const QUESTION_START = /^(what|when|which|who|whom|where|why|how|show|list|tell|give|do|does|did|is|are|was|were|can|could|will|would|any|anything)\b/i;
const EVENT_STATEMENT = /\b(i have|i've got|i got|i'm flying|i am flying|my)\b/i;
const STATEMENT_LEAD = /^\s*(?:i have (?:a|an)|i've got (?:a|an)|i have|i've got)\s+/i;

const MD_CHARS = /[\\`*_~[\]<>|]/g;

function tidy(raw: string, fallback: string): string {
  let t = raw.replace(MD_CHARS, " ").replace(/\s+/g, " ").trim();
  for (;;) {
    const n = t
      .replace(/^[\s,.\-–:;!?]+|[\s,.\-–:;!?]+$/g, "")
      .replace(/^(?:me\s+)?(?:to|about|that|of|for|regarding)\s+/i, "")
      .replace(/\s+(?:please|pls|plz|thanks|thank you|thx)$/i, "")
      .replace(/^(?:please|pls|plz)\s+/i, "")
      .replace(/^(?:to|of|for|about|that|on|at|by|in|after|within)$/i, "");
    if (n === t) break;
    t = n;
  }
  const title = sanitiseTitle(t.replace(MD_CHARS, ""));
  return title || fallback;
}

/**
 * `explicit` is true only for imperatives. A statement ("I have a flight tomorrow 6pm") comes back explicit:false
 * so the caller keeps the proposal/confirm flow. A date without the clock time a category needs (a flight) returns
 * null: the caller's existing ask-for-a-time route handles it.
 */
export function parseReminderRequest(
  text: string,
  rules: ReminderRule[],
  tz: string,
  now: Date,
  dueHourLocal: number,
): ReminderRequest | null {
  try {
    if (typeof text !== "string") return null;
    const raw = text.normalize("NFKC").replace(/\s+/g, " ").trim();
    if (raw.length === 0 || raw.length > 600) return null;

    const lead = IMPERATIVE.exec(raw);
    const explicit = lead !== null;
    const body = explicit ? raw.slice(lead[0].length).replace(/^\s*(?:for|of)\s+(?=\d)/i, "") : raw; // "set a timer for 5 min"
    if (!explicit && (raw.includes("?") || QUESTION_START.test(raw) || !EVENT_STATEMENT.test(raw) || raw.length > 240)) return null;

    const fallback = explicit
      ? /timer/i.test(lead[0]) ? "Timer" : /alarm/i.test(lead[0]) ? "Alarm" : "Reminder"
      : "Reminder";
    const tag = extractHashtag(body, rules); // "#flight" survives in `body` for proposeReminder, which reads it itself
    const nowMs = now.getTime();
    const finish = (title: string, dueAt: string, timed: boolean, relative: boolean): ReminderRequest | null => {
      const t = tidy(title, fallback);
      const due = new Date(dueAt).getTime();
      if (!Number.isFinite(due) || due <= nowMs) return null;
      const category = categorise({ title: t, sourceRef: "", source: "chat", category: tag.category ?? undefined }, rules);
      return { title: t, dueAt: new Date(due).toISOString(), timed, category, explicit, relative };
    };

    const rel = parseRelativeWhen(tag.text, tz, now);
    if (rel) {
      const at = tag.text.indexOf(rel.matched);
      const rest = at < 0 ? tag.text : `${tag.text.slice(0, at)} ${tag.text.slice(at + rel.matched.length)}`;
      return finish(rest.replace(STATEMENT_LEAD, ""), rel.dueAt, true, true);
    }

    const p = proposeReminder(body, rules, tz, now, dueHourLocal);
    if (!p.ok) return null;
    return finish(p.title, p.dueAt, p.timed, p.relative);
  } catch {
    return null;
  }
}
