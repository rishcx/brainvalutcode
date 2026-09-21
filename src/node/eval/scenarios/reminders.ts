// R1-R18: PLAN_V3 C.3 "Reminders, slot filling, corrections, cancellation". All need the real V3-2 handler
// (dialog/PLAN); R15-R18 also need V3-1's delivery mechanics, reusing the same gate (the harness only
// detects readiness by phase, not by finer file-level dependency).
import type { Scenario, Turn } from "../types.ts";

const AT = "2026-09-21T09:30:00Z"; // 15:00 IST
const REQUIRES = "v3-2" as const;

/** A create_reminder PLAN, terse. */
const cr = (what: string | null, when_text: string | null, at_local: string | null = null) => ({
  intent: "create_reminder",
  tools: [{ name: "create_reminder", args: { what, when_text, at_local } }],
  say: "",
  compose: false,
});
const smalltalk = (say: string) => ({ intent: "smalltalk", tools: [], say, compose: false });
const one = (t: Turn): Scenario["turns"] => [t];

export const REMINDERS: Scenario[] = [
  {
    id: "R1",
    tags: ["reminder", "dialog", "live"],
    requires: REQUIRES,
    at: AT,
    turns: [
      { channel: "whatsapp", text: "set a reminder", plan: cr(null, null), expect: { route: "plan", llmCalls: 1, reply: { includes: ["What should I remind you about?"] }, dialog: { missing: ["what", "when"] } } },
      { channel: "whatsapp", text: "call mom", plan: cr("call mom", null), expect: { llmCalls: 1, reply: { includes: ["When should I remind you to call mom"] }, dialog: { missing: ["when"] } } },
      { channel: "whatsapp", text: "in 10 minutes", expect: { route: "dialog", llmCalls: 0, reply: { includes: ["call mom", "15:10"] }, db: { reminders: [{ title: "call mom", dueLocal: "15:10", channel: "whatsapp" }] }, dialog: { cleared: true } } },
    ],
  },
  {
    id: "R2",
    tags: ["reminder", "dialog"],
    requires: REQUIRES,
    at: AT,
    turns: one({ text: "remind me in 5 minutes", plan: cr(null, "5 minutes"), expect: { route: "plan", llmCalls: 1, reply: { includes: ["What should I remind you about?"] }, dialog: { missing: ["what"] }, db: { noNewRows: true } } }),
  },
  {
    id: "R3",
    tags: ["reminder", "dialog"],
    requires: REQUIRES,
    at: AT,
    turns: [
      { text: "remind me to call mom", plan: cr("call mom", null), expect: { route: "plan", llmCalls: 1, reply: { includes: ["When should I remind you to call mom"] }, dialog: { missing: ["when"] } } },
      { text: "6pm", expect: { route: "dialog", llmCalls: 0, reply: { includes: ["call mom", "18:00"] }, db: { reminders: [{ title: "call mom", dueLocal: "18:00", channel: "telegram" }] }, dialog: { cleared: true } } },
    ],
  },
  {
    id: "R4",
    tags: ["reminder", "dialog", "live"],
    requires: REQUIRES,
    at: AT,
    turns: [
      { text: "remind me to call mom", plan: cr("call mom", null), expect: { llmCalls: 1, dialog: { missing: ["when"] } } },
      { text: "6pm", expect: { llmCalls: 0, db: { reminders: [{ title: "call mom", dueLocal: "18:00", channel: "telegram" }] } } },
      { text: "no, make it 7pm", plan: { intent: "reschedule_reminder", tools: [{ name: "reschedule_reminder", args: { ref: { last: true }, when_text: "7pm", at_local: null } }], say: "", compose: false }, expect: { llmCalls: 1, tools: ["reschedule_reminder"], reply: { includes: ["19:00"] }, db: { reminders: [{ title: "call mom", dueLocal: "19:00", channel: "telegram" }] } } },
    ],
  },
  {
    id: "R5",
    tags: ["reminder", "dialog"],
    requires: REQUIRES,
    at: AT,
    turns: [
      { text: "set a reminder", plan: cr(null, null), expect: { llmCalls: 1, dialog: { missing: ["what", "when"] } } },
      { text: "never mind", expect: { route: "dialog", llmCalls: 0, reply: { includes: ["cancelled"] }, dialog: { cleared: true }, db: { noNewRows: true } } },
    ],
  },
  {
    id: "R6",
    tags: ["reminder", "dialog"],
    requires: REQUIRES,
    at: AT,
    turns: [
      { text: "remind me to pay rent", plan: cr("pay rent", null), expect: { llmCalls: 1, dialog: { missing: ["when"] } } },
      { text: "in 10 min", advanceMs: 11 * 60_000, plan: cr(null, "10 min"), expect: { route: "plan", llmCalls: 1, reply: { includes: ["What should I remind you about?"] }, dialog: { missing: ["what"] } } },
    ],
  },
  {
    id: "R7",
    tags: ["reminder"],
    requires: REQUIRES,
    at: "2026-09-21T09:30:00Z", // 15:00 IST
    turns: one({ text: "remind me at 6 to stretch", plan: cr("stretch", "at 6", null), expect: { llmCalls: 1, reply: { includes: ["stretch", "18:00"] }, db: { reminders: [{ title: "stretch", dueLocal: "18:00", channel: "telegram" }] } } }),
  },
  {
    id: "R8",
    tags: ["reminder"],
    requires: REQUIRES,
    at: "2026-09-20T23:30:00Z", // 05:00 IST
    turns: one({ text: "remind me at 6 to stretch", plan: cr("stretch", "at 6", null), expect: { llmCalls: 1, reply: { includes: ["stretch", "06:00"] }, db: { reminders: [{ title: "stretch", dueLocal: "06:00", channel: "telegram" }] } } }),
  },
  {
    id: "R9",
    tags: ["reminder"],
    requires: REQUIRES,
    at: AT,
    turns: one({ text: "remind me yesterday at 5 to x", plan: cr("x", "yesterday at 5", null), expect: { llmCalls: 1, reply: { includes: ["passed"] }, db: { noNewRows: true } } }),
  },
  {
    id: "R10",
    tags: ["reminder"],
    requires: REQUIRES,
    at: AT,
    turns: one({ text: "remind me in 2 days at 5pm to submit form", plan: cr("submit form", "in 2 days at 5pm", null), expect: { llmCalls: 1, db: { reminders: [
      // "submit" puts it in the configured "assignment" category, whose 2h heads-up an explicit reminder keeps
      // (reminders/create.ts#createReminder, engine.ts#explicitOpts); the T-0 row is the exact instant under test.
      { title: "submit form", dueLocal: "2026-09-23 15:00", channel: "telegram" },
      { title: "submit form", dueLocal: "2026-09-23 17:00", channel: "telegram" },
    ] } } }),
  },
  {
    id: "R11",
    tags: ["reminder", "unsupported"],
    requires: REQUIRES,
    at: AT,
    turns: one({ text: "remind me every day at 9 to take meds", plan: { intent: "unsupported", tools: [], say: "I can't do recurring reminders yet. I can set a one-off reminder, or add \"take meds\" as a daily task.", compose: false }, expect: { llmCalls: 1, reply: { includes: ["recurring"] }, db: { noNewRows: true } } }),
  },
  {
    id: "R12",
    tags: ["reminder", "dialog"],
    requires: REQUIRES,
    at: AT,
    seed: { deadlines: [{ title: "essay", dueAt: "2026-09-22T03:30:00Z", source: "manual", sourceRef: "x" }] },
    turns: [
      { text: "set a reminder", plan: cr(null, null), expect: { llmCalls: 1, dialog: { missing: ["what", "when"] } } },
      { text: "what's due tomorrow?", plan: { intent: "list_deadlines", tools: [{ name: "list_deadlines", args: { range: "tomorrow" } }], say: "", compose: false }, expect: { llmCalls: 1, tools: ["list_deadlines"], reply: { includes: ["essay"] }, dialog: { missing: ["what", "when"] } } },
    ],
  },
  {
    id: "R13",
    tags: ["reminder"],
    requires: REQUIRES,
    at: AT,
    seed: { deadlines: [{ id: "eval:r13", title: "call mom", dueAt: "2026-09-21T10:00:00Z", source: "chat", sourceRef: "x", confidence: 1, originChannel: "telegram", originPeer: "111" }] },
    turns: one({ text: "list my reminders", plan: { intent: "list_reminders", tools: [{ name: "list_reminders", args: { range: "upcoming" } }], say: "", compose: false }, expect: { route: "plan", llmCalls: 1, tools: ["list_reminders"], reply: { includes: ["call mom"] } } }),
  },
  {
    id: "R14",
    tags: ["reminder"],
    requires: REQUIRES,
    at: AT,
    seed: { deadlines: [{ id: "eval:r14", title: "call mom", dueAt: "2026-09-21T10:00:00Z", source: "chat", sourceRef: "x", confidence: 1 }] },
    turns: one({ text: "cancel the call mom reminder", plan: { intent: "cancel_reminder", tools: [{ name: "cancel_reminder", args: { ref: { text: "call mom" } } }], say: "", compose: false }, expect: { llmCalls: 1, tools: ["cancel_reminder"], reply: { includes: ["call mom"] } } }),
  },
  {
    id: "R15",
    tags: ["reminder", "channels"],
    requires: REQUIRES,
    at: AT,
    seed: { deadlines: [{ id: "eval:r15", title: "call mom", dueAt: "2026-09-21T09:31:00Z", source: "chat", sourceRef: "x", confidence: 1, originChannel: "telegram", originPeer: "111" }] },
    turns: [
      { text: "ok", advanceMs: 90_000, expect: { llmCalls: 0, reply: { includes: ["Got it"] }, delivered: { count: 1, includes: ["call mom", "Due now", "snooze"] } } },
      // B.1 fast path: `snooze <dur>` is deterministic (0 calls). Fired at 15:01:30, +10m ceils to the minute: 15:12.
      { text: "snooze 10m", expect: { route: "fast", llmCalls: 0, reply: { includes: ["Snoozed", "call mom", "15:12"] }, db: { reminders: [{ title: "call mom", dueLocal: "15:12", channel: "telegram" }] } } },
    ],
  },
  {
    id: "R16",
    tags: ["reminder", "channels"],
    requires: REQUIRES,
    at: AT,
    seed: { deadlines: [{ id: "eval:r16", title: "call mom", dueAt: "2026-09-21T09:31:00Z", source: "chat", sourceRef: "x", confidence: 1, originChannel: "telegram", originPeer: "111" }] },
    turns: [
      { text: "ok", advanceMs: 90_000, expect: { llmCalls: 0, delivered: { count: 1, includes: ["call mom"] } } },
      // B.1 fast path: bare `done` = the reminder just delivered to this peer (0 calls).
      { text: "done", expect: { route: "fast", llmCalls: 0, reply: { includes: ["Marked done: call mom"] }, db: { reminders: [] } } },
    ],
  },
  {
    id: "R17",
    tags: ["reminder", "channels"],
    requires: REQUIRES,
    at: AT,
    seed: {
      deadlines: [
        { id: "eval:r17a", title: "call mom", dueAt: "2026-09-21T09:31:00Z", source: "chat", sourceRef: "x", confidence: 1, originChannel: "telegram", originPeer: "111" },
        { id: "eval:r17b", title: "call dad", dueAt: "2026-09-21T09:31:00Z", source: "chat", sourceRef: "x", confidence: 1, originChannel: "telegram", originPeer: "111" },
      ],
    },
    turns: [
      { text: "ok", advanceMs: 90_000, expect: { llmCalls: 0, sentTo: [{ channel: "telegram", peer: "111" }, { channel: "telegram", peer: "111" }, { channel: "telegram", peer: "111" }], delivered: { count: 2, includes: ["Due now"] } } },
      { text: "done", expect: { route: "fast", llmCalls: 0, reply: { includes: ["Marked done: call dad"] } } },
    ],
  },
  {
    id: "R18",
    tags: ["reminder", "channels"],
    requires: REQUIRES,
    at: AT,
    seed: {
      deadlines: ["call mom", "call dad", "gym", "submit form", "pay rent"].map((title, i) => ({
        id: `eval:r18-${i}`,
        title,
        dueAt: "2026-09-21T09:31:00Z",
        source: "chat" as const,
        sourceRef: "x",
        confidence: 1,
        originChannel: "telegram" as const,
        originPeer: "111",
      })),
    },
    turns: [
      // The numbered batch is the DELIVERED reminder message, not the reply to "ok".
      { text: "ok", advanceMs: 90_000, expect: { llmCalls: 0, reply: { includes: ["Got it"] }, delivered: { count: 1, includes: ["1.", "2.", "5.", "call mom", "call dad", "pay rent"] } } },
      { text: "snooze 2 10m", expect: { route: "fast", llmCalls: 0, reply: { includes: ["call dad"] }, db: { reminders: [{ title: "call dad", dueLocal: "15:12", channel: "telegram" }] } } },
    ],
  },
];
