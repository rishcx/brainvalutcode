// U1-U8: PLAN_V3 C.3 "Unsupported, meta, degraded". U1-U4,U7,U8 need V3-2; U5,U6 also need V3-3 (degraded mode).
import type { Scenario, Turn } from "../types.ts";

const AT = "2026-09-21T09:30:00Z"; // 15:00 IST
const REQUIRES_V32 = "v3-2" as const;
const REQUIRES_V33 = "v3-3" as const;
const one = (t: Turn): Scenario["turns"] => [t];
const unsupported = (say: string) => ({ intent: "unsupported", tools: [], say, compose: false });

export const UNSUPPORTED: Scenario[] = [
  {
    id: "U1",
    tags: ["unsupported", "live"],
    requires: REQUIRES_V32,
    at: AT,
    turns: one({ text: "book me a cab", plan: unsupported("I can't do that yet. I can set reminders, manage tasks, and answer from your notes and GitHub."), expect: { llmCalls: 1, reply: { includes: ["can't do that yet"] }, db: { noNewRows: true } } }),
  },
  {
    id: "U2",
    tags: ["unsupported"],
    requires: REQUIRES_V32,
    at: AT,
    turns: one({ text: "what's the weather", plan: unsupported("I can't check the weather. I can set reminders, manage tasks, and answer from your notes and GitHub."), expect: { llmCalls: 1, reply: { includes: ["can't"] } } }),
  },
  {
    id: "U3",
    tags: ["unsupported"],
    requires: REQUIRES_V32,
    at: AT,
    turns: one({ text: "send a message to mom", plan: unsupported("I can't send messages on your behalf. I can set reminders, manage tasks, and answer from your notes and GitHub."), expect: { llmCalls: 1, reply: { includes: ["can't"] }, db: { noNewRows: true } } }),
  },
  {
    id: "U4",
    tags: ["unsupported", "fast"],
    requires: REQUIRES_V32,
    at: AT,
    turns: one({ text: "trace", expect: { route: "fast", llmCalls: 0 } }),
  },
  {
    id: "U5",
    tags: ["unsupported", "degraded"],
    requires: REQUIRES_V33,
    at: AT,
    providerQuota: { exhausted: true, resetAt: "2026-09-22T00:00:00Z" }, // 05:30 IST
    turns: [
      // not a bare greeting: greetings never reach the model now (audit 15), and this pins the quota line.
      { text: "tell me about the rent", expect: { route: "degraded", llmCalls: 0, reply: { includes: ["out of free quota", "05:30", "Reminders still fire"] } } },
      // C.3 U5: "fast path still works".
      { text: "tasks", expect: { route: "fast", llmCalls: 0 } },
    ],
  },
  {
    id: "U6",
    tags: ["unsupported", "degraded", "reminder"],
    requires: REQUIRES_V33,
    at: AT,
    providerQuota: { exhausted: true, resetAt: "2026-09-22T00:00:00Z" },
    // 15:00 IST + 10 min = 15:10.
    turns: one({ text: "remind me in 10 minutes to x", expect: { route: "degraded", llmCalls: 0, reply: { includes: ["x", "15:10", "offline mode"] }, db: { reminders: [{ title: "x", dueLocal: "15:10", channel: "telegram" }] } } }),
  },
  {
    id: "U7",
    tags: ["unsupported", "resilience"],
    requires: REQUIRES_V32,
    at: AT,
    turns: one({
      text: "asdkjhasd",
      plan: ["not json at all", "still not json"],
      expect: { llmCalls: 2, reply: { includes: ["didn't get that", "remind me at 6pm to call mom"], excludes: ["{\"intent\""] } },
    }),
  },
  {
    id: "U8",
    tags: ["unsupported", "resilience"],
    requires: REQUIRES_V32,
    at: AT,
    turns: one({
      // The add_tasks item must be a span of the user's words or provenance (correctly) refuses it; "a" was not.
      text: "add task gym and do everything",
      plan: {
        intent: "add_tasks",
        tools: [
          { name: "add_tasks", args: { items: [{ text: "gym", every: null }] } },
          { name: "list_tasks", args: { day: "today", include_done: false } },
          { name: "list_deadlines", args: { range: "today" } },
          { name: "list_reminders", args: { range: "upcoming" } },
          { name: "search_notes", args: { query: "a" } },
          { name: "github_involvement", args: { bucket: "all" } },
        ],
        say: "",
        compose: false,
      },
      expect: { llmCalls: 1, tools: ["add_tasks", "list_tasks", "list_deadlines", "list_reminders"], db: { tasks: ["gym"] } },
    }),
  },
];
