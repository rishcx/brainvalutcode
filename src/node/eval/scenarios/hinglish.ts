// H1-H10: PLAN_V3 C.3 "Typos, Hinglish, informal". All need the real V3-2 handler.
import type { Scenario, Turn } from "../types.ts";

const AT = "2026-09-21T09:30:00Z"; // 15:00 IST
const REQUIRES = "v3-2" as const;
const one = (t: Turn): Scenario["turns"] => [t];
const cr = (what: string | null, when_text: string | null) => ({ intent: "create_reminder", tools: [{ name: "create_reminder", args: { what, when_text, at_local: null } }], say: "", compose: false });

export const HINGLISH: Scenario[] = [
  {
    id: "H1",
    tags: ["hinglish", "reminder"],
    requires: REQUIRES,
    at: AT,
    turns: one({ text: "remnd me in 10 min to cal mom", plan: cr("cal mom", "10 min"), expect: { llmCalls: 1, db: { reminders: [{ title: "cal mom", dueLocal: "15:10", channel: "telegram" }] } } }),
  },
  {
    id: "H2",
    tags: ["hinglish", "reminder", "live"],
    requires: REQUIRES,
    at: AT,
    turns: one({
      text: "kal subah 9 baje yaad dila dena doctor ko call karna hai",
      plan: cr("doctor ko call karna", "kal subah 9 baje"),
      expect: { llmCalls: 1, db: { reminders: [{ title: "doctor ko call karna", dueLocal: "2026-09-22 09:00", channel: "telegram" }] } },
    }),
  },
  {
    id: "H3",
    tags: ["hinglish", "tasks", "live"],
    requires: REQUIRES,
    at: AT,
    seed: { tasks: [{ title: "milk" }] },
    turns: one({ text: "aaj ke tasks kya hai", plan: { intent: "list_tasks", tools: [{ name: "list_tasks", args: { day: "today", include_done: false } }], say: "", compose: false }, expect: { llmCalls: 1, reply: { includes: ["milk"] } } }),
  },
  {
    id: "H4",
    tags: ["hinglish", "reminder"],
    requires: REQUIRES,
    at: AT,
    turns: one({ text: "10 min baad reminder lagao chai", plan: cr("chai", "10 min baad"), expect: { llmCalls: 1, db: { reminders: [{ title: "chai", dueLocal: "15:10", channel: "telegram" }] } } }),
  },
  {
    id: "H5",
    tags: ["hinglish", "tasks"],
    requires: REQUIRES,
    at: AT,
    turns: one({
      text: "task add karo: dudh lana, gym jana",
      plan: { intent: "add_tasks", tools: [{ name: "add_tasks", args: { items: [{ text: "dudh lana", every: null }, { text: "gym jana", every: null }] } }], say: "", compose: false },
      expect: { llmCalls: 1, db: { tasks: ["dudh lana", "gym jana"] } },
    }),
  },
  {
    id: "H6",
    tags: ["hinglish", "reminder"],
    requires: REQUIRES,
    at: AT,
    turns: one({ text: "shaam ko 6 baje remind karna meeting", plan: cr("meeting", "shaam ko 6 baje"), expect: { llmCalls: 1, db: { reminders: [{ title: "meeting", dueLocal: "18:00", channel: "telegram" }] } } }),
  },
  {
    id: "H7",
    tags: ["hinglish", "smalltalk"],
    requires: REQUIRES,
    at: AT,
    // audit 15: "thx" is a thanks ack on the fast path now (0 PLAN calls)
    turns: one({ text: "thx", expect: { route: "fast", llmCalls: 0, reply: { includes: ["Anytime"] } } }),
  },
  {
    id: "H8",
    tags: ["hinglish", "smalltalk"],
    requires: REQUIRES,
    at: AT,
    seed: { deadlines: [{ id: "eval:h8", title: "call mom", dueAt: "2026-09-21T10:00:00Z", source: "chat", sourceRef: "x", confidence: 1, originChannel: "telegram", originPeer: "111" }] },
    turns: one({ text: "ok", expect: { route: "fast", llmCalls: 0, reply: { maxChars: 50 } } }), // audit 15
  },
  {
    id: "H9",
    tags: ["hinglish", "tasks"],
    requires: REQUIRES,
    at: AT,
    seed: { tasks: [{ title: "milk" }] },
    turns: one({ text: "wat r my tasks 2day", plan: { intent: "list_tasks", tools: [{ name: "list_tasks", args: { day: "today", include_done: false } }], say: "", compose: false }, expect: { llmCalls: 1, reply: { includes: ["milk"] } } }),
  },
  {
    id: "H10",
    tags: ["hinglish", "reminder", "live"],
    requires: REQUIRES,
    at: AT,
    turns: one({
      text: "plz remind me abt the dentist tmrw 5pm",
      plan: cr("the dentist", "tmrw 5pm"),
      expect: { llmCalls: 1, db: { reminders: [{ title: "the dentist", dueLocal: "2026-09-22 17:00", channel: "telegram" }] } },
    }),
  },
];
