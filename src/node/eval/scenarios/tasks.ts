// T1-T12: PLAN_V3 C.3 "Tasks". All need the real V3-2 handler.
import type { Scenario, Turn } from "../types.ts";

const AT = "2026-09-21T09:30:00Z"; // 15:00 IST
const REQUIRES = "v3-2" as const;

const items = (...texts: string[]) => ({
  intent: "add_tasks",
  tools: [{ name: "add_tasks", args: { items: texts.map((text) => ({ text, every: null })) } }],
  say: "",
  compose: false,
});
const listTasks = (day: "today" | "tomorrow" = "today") => ({
  intent: "list_tasks",
  tools: [{ name: "list_tasks", args: { day, include_done: false } }],
  say: "",
  compose: false,
});
const one = (t: Turn): Scenario["turns"] => [t];

export const TASKS: Scenario[] = [
  {
    id: "T1",
    tags: ["tasks"],
    requires: REQUIRES,
    at: AT,
    turns: one({ text: "add task buy milk", plan: items("buy milk"), expect: { route: "plan", llmCalls: 1, db: { tasks: ["buy milk"] } } }),
  },
  {
    id: "T2",
    tags: ["tasks", "live"],
    requires: REQUIRES,
    at: AT,
    turns: one({ text: "add milk and eggs to my list", plan: items("milk", "eggs"), expect: { llmCalls: 1, db: { tasks: ["milk", "eggs"] } } }),
  },
  {
    id: "T3",
    tags: ["tasks", "live"],
    requires: REQUIRES,
    at: AT,
    turns: one({ text: "add task salt and pepper", plan: items("salt and pepper"), expect: { llmCalls: 1, db: { tasks: ["salt and pepper"] } } }),
  },
  {
    id: "T4",
    tags: ["tasks"],
    requires: REQUIRES,
    at: AT,
    turns: one({ text: "todo: call bank, pay LIC premium, gym at 7", plan: items("call bank", "pay LIC premium", "gym at 7"), expect: { llmCalls: 1, db: { tasks: ["call bank", "pay LIC premium", "gym at 7"] } } }),
  },
  {
    id: "T5",
    tags: ["tasks", "fast"],
    requires: REQUIRES,
    at: AT,
    seed: { tasks: [{ title: "buy milk" }] },
    turns: one({ text: "tasks", expect: { route: "fast", llmCalls: 0, reply: { includes: ["buy milk"] } } }),
  },
  {
    id: "T6",
    tags: ["tasks"],
    requires: REQUIRES,
    at: AT,
    seed: { tasks: [{ title: "buy milk" }] },
    turns: one({ text: "task list", plan: listTasks("today"), expect: { route: "plan", llmCalls: 1, reply: { includes: ["buy milk"], excludes: ["\"list\""] }, db: { tasks: ["buy milk"] } } }),
  },
  {
    id: "T7",
    tags: ["tasks"],
    requires: REQUIRES,
    at: AT,
    seed: { tasks: [{ title: "buy milk" }] },
    turns: one({ text: "what do I have to do today", plan: listTasks("today"), expect: { llmCalls: 1, reply: { includes: ["buy milk"] } } }),
  },
  {
    id: "T8",
    tags: ["tasks", "deadlines"],
    requires: REQUIRES,
    at: AT,
    seed: { tasks: [{ title: "buy milk", dueDate: "2026-09-22" }], deadlines: [{ title: "essay", dueAt: "2026-09-22T03:30:00Z", source: "manual", sourceRef: "x" }] },
    turns: one({
      text: "what's on tomorrow",
      plan: { intent: "list_tasks", tools: [{ name: "list_tasks", args: { day: "tomorrow", include_done: false } }, { name: "list_deadlines", args: { range: "tomorrow" } }], say: "", compose: false },
      expect: { llmCalls: 1, tools: ["list_tasks", "list_deadlines"], reply: { includes: ["buy milk", "essay"] } },
    }),
  },
  {
    id: "T9",
    tags: ["tasks", "listRef"],
    requires: REQUIRES,
    at: AT,
    seed: { tasks: [{ title: "buy milk" }, { title: "gym" }] },
    turns: [
      { text: "tasks", expect: { route: "fast", llmCalls: 0, reply: { includes: ["buy milk", "gym"] } } },
      {
        text: "done 2", // B.1 fast path: `done <n>` from last:list:<channel>:<peer>, 0 calls
        expect: { route: "fast", llmCalls: 0, reply: { includes: ["gym"] }, db: { tasks: ["buy milk"] } },
      },
    ],
  },
  {
    id: "T10",
    tags: ["tasks", "listRef", "channels"],
    requires: REQUIRES,
    at: AT,
    seed: { tasks: [{ title: "buy milk" }] },
    turns: [
      { text: "tasks", expect: { route: "fast", llmCalls: 0, reply: { includes: ["buy milk"] } } },
      { channel: "whatsapp", text: "status", expect: { route: "fast", llmCalls: 0 } },
      {
        text: "done 1", // B.1 fast path; TG's own list, not WA's status list
        expect: { route: "fast", llmCalls: 0, reply: { includes: ["buy milk"] }, db: { tasks: [] } },
      },
    ],
  },
  {
    id: "T11",
    tags: ["tasks"],
    requires: REQUIRES,
    at: AT,
    seed: { tasks: [{ title: "gym" }] },
    turns: one({ text: "mark gym as done", plan: { intent: "complete_task", tools: [{ name: "complete_task", args: { ref: { text: "gym" } } }], say: "", compose: false }, expect: { llmCalls: 1, reply: { includes: ["gym"] }, db: { tasks: [] } } }),
  },
  {
    id: "T12",
    tags: ["tasks", "smalltalk"],
    requires: REQUIRES,
    at: AT,
    turns: one({ text: "done for today, thanks", plan: { intent: "smalltalk", tools: [], say: "You're welcome!", compose: false }, expect: { llmCalls: 1, reply: { excludes: ["No open task matching"] } } }),
  },
];
