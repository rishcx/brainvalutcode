// E1-E12: PLAN_V3 C.3 "Evidence", using the transcript's exact user texts (docs/EVIDENCE_2026-09-21.md),
// typos and spacing included. All need the real V3-2 handler (PLAN/dialog/provenance), so all are gated.
import type { Scenario } from "../types.ts";

const AT = "2026-09-21T09:30:00Z"; // 15:00 IST
/** All 12 evidence scenarios exercise PLAN/dialog/provenance, so all need the real V3-2 handler. */
const REQUIRES = "v3-2" as const;

export const EVIDENCE: Scenario[] = [
  {
    id: "E1",
    tags: ["evidence", "smalltalk"],
    requires: REQUIRES,
    at: AT,
    turns: [
      {
        text: "Hello , what can yiu do",
        plan: {
          intent: "help",
          tools: [],
          say: "I can set reminders, track tasks and deadlines, and answer questions from your notes and GitHub. What would you like to do?",
          compose: false,
        },
        expect: {
          route: "plan",
          llmCalls: 1,
          reply: { includes: ["reminders"], excludes: ["buy milk", "gym"], maxChars: 500 },
        },
      },
    ],
  },
  {
    id: "E2",
    tags: ["evidence", "smalltalk"],
    requires: REQUIRES,
    at: AT,
    seed: {
      tasks: [{ title: "buy milk" }],
      deadlines: [{ title: "v2 milestone", dueAt: "2026-09-22T03:30:00Z", source: "github", sourceRef: "x" }],
    },
    turns: [
      {
        // not a bare greeting (those are the fast path now, audit 15): this still pins that a PLAN "say" leaks no data.
        text: "how are you today",
        plan: { intent: "smalltalk", tools: [], say: "Hi! What can I do for you?", compose: false },
        expect: { route: "plan", llmCalls: 1, reply: { includes: ["Hi"], excludes: ["buy milk", "v2 milestone"], maxChars: 200 } },
      },
    ],
  },
  {
    id: "E3",
    tags: ["evidence", "reminder", "dialog", "live"],
    requires: REQUIRES,
    at: AT,
    turns: [
      {
        text: "Can you set a remaining of 2 mins",
        plan: {
          intent: "create_reminder",
          tools: [{ name: "create_reminder", args: { what: null, when_text: "2 mins", at_local: null } }],
          say: "",
          compose: false,
        },
        expect: {
          route: "plan",
          llmCalls: 1,
          reply: { includes: ["What should I remind you about?"] },
          dialog: { missing: ["what"] },
          db: { noNewRows: true },
        },
      },
    ],
  },
  {
    id: "E4",
    tags: ["evidence", "reminder"],
    requires: REQUIRES,
    at: AT,
    turns: [
      {
        text: "Remind me after 2 mins to drink water",
        plan: {
          intent: "create_reminder",
          tools: [{ name: "create_reminder", args: { what: "drink water", when_text: "after 2 mins", at_local: null } }],
          say: "",
          compose: false,
        },
        expect: {
          route: "plan",
          llmCalls: 1,
          reply: { includes: ["drink water", "15:02"] },
          db: { reminders: [{ title: "drink water", dueLocal: "15:02", channel: "telegram" }] },
        },
      },
    ],
  },
  {
    id: "E5",
    tags: ["evidence", "smalltalk"],
    requires: REQUIRES,
    at: AT,
    turns: [
      {
        // audit 15: both greetings are deterministic now, so the repeat is identical for free.
        text: "Hi",
        expect: { llmCalls: 0, reply: { includes: ["What can I do for you?"] } },
      },
      {
        text: "Hi",
        expect: { llmCalls: 0, reply: { excludes: ["again", "okay", "OK?"] } },
      },
    ],
  },
  {
    id: "E6",
    tags: ["evidence", "tasks", "live"],
    requires: REQUIRES,
    at: AT,
    seed: { tasks: [{ title: "buy milk , gym" }] },
    turns: [
      {
        text: "Any task.for today?",
        plan: {
          intent: "list_tasks",
          tools: [{ name: "list_tasks", args: { day: "today", include_done: false } }],
          say: "",
          compose: false,
        },
        expect: { route: "plan", llmCalls: 1, tools: ["list_tasks"], reply: { includes: ["buy milk , gym"] } },
      },
    ],
  },
  {
    id: "E7",
    tags: ["evidence", "smalltalk"],
    requires: REQUIRES,
    at: AT,
    turns: [
      {
        text: "what are you",
        plan: {
          intent: "smalltalk",
          tools: [],
          say: "I'm Brain, your personal assistant. I help with reminders, tasks, and answering from your notes and GitHub.",
          compose: false,
        },
        expect: { llmCalls: 1, reply: { includes: ["Brain"], excludes: ["buy milk"] } },
      },
    ],
  },
  {
    id: "E8",
    tags: ["evidence", "github"],
    requires: REQUIRES,
    at: AT,
    seed: {
      involvement: {
        login: "me",
        assignedIssues: [{ repo: "me/soup", number: 831, title: "GPU pricing bug", url: "https://github.com/me/soup/issues/831", updatedAt: AT, state: "OPEN" }],
        myOpenPrs: [],
        reviewRequests: [],
        mentions: [],
        recentRepos: [],
        totals: { assignedIssues: 1, myOpenPrs: 0, reviewRequests: 0, mentions: 0 },
        fetchedAt: AT,
        partial: [],
      },
    },
    turns: [
      {
        text: "Any open issues on my name on github",
        plan: {
          intent: "github_involvement",
          tools: [{ name: "github_involvement", args: { bucket: "assigned" } }],
          say: "",
          compose: true,
        },
        compose: "You have 1 assigned issue: Soup #831 - GPU pricing bug.",
        expect: {
          route: "plan+compose",
          llmCalls: 2,
          tools: ["github_involvement"],
          reply: { includes: ["Soup #831", "GPU pricing bug"] },
        },
      },
    ],
  },
  {
    id: "E9",
    tags: ["evidence", "reminder", "injection", "provenance"],
    requires: REQUIRES,
    at: AT,
    turns: [
      {
        text: "I might need to drink water later, just thinking out loud",
        plan: { intent: "smalltalk", tools: [], say: "Got it.", compose: false },
        expect: { llmCalls: 1, reply: { includes: ["Got it"] } },
      },
      {
        text: "Can you share a reminder of 1 min",
        // Adversarial: the model hallucinates `what` from the earlier turn instead of leaving it null.
        // Provenance must refuse a span that is not in THIS message and ask, same as if it had been null.
        plan: {
          intent: "create_reminder",
          tools: [{ name: "create_reminder", args: { what: "drink water", when_text: "1 min", at_local: null } }],
          say: "",
          compose: false,
        },
        expect: {
          llmCalls: 1,
          reply: { includes: ["What should I remind you about?"], excludes: ["drink water"] },
          dialog: { missing: ["what"] },
          db: { noNewRows: true },
        },
      },
    ],
  },
  {
    id: "E10",
    tags: ["evidence", "tasks", "live"],
    requires: REQUIRES,
    at: AT,
    seed: { tasks: [{ title: "milk" }] },
    turns: [
      {
        text: "what are today's tasks",
        plan: { intent: "list_tasks", tools: [{ name: "list_tasks", args: { day: "today", include_done: false } }], say: "", compose: false },
        expect: { route: "plan", llmCalls: 1, tools: ["list_tasks"], reply: { includes: ["milk"] } },
      },
    ],
  },
  {
    id: "E11",
    tags: ["evidence", "tasks", "live"],
    requires: REQUIRES,
    at: AT,
    turns: [
      {
        text: "add task buy milk, gym and call mom",
        plan: {
          intent: "add_tasks",
          tools: [{ name: "add_tasks", args: { items: [{ text: "buy milk", every: null }, { text: "gym", every: null }, { text: "call mom", every: null }] } }],
          say: "",
          compose: false,
        },
        expect: { route: "plan", llmCalls: 1, tools: ["add_tasks"], db: { tasks: ["buy milk", "gym", "call mom"] } },
      },
    ],
  },
  {
    id: "E12",
    tags: ["evidence", "reminder", "channels"],
    requires: REQUIRES,
    at: AT,
    seed: {
      deadlines: [
        {
          id: "eval:e12",
          title: "drink water",
          dueAt: "2026-09-21T09:31:00Z",
          source: "chat",
          sourceRef: "eval",
          status: "open",
          confidence: 1,
          originChannel: "whatsapp",
          originPeer: "919900000000",
        },
      ],
    },
    turns: [
      {
        channel: "whatsapp",
        text: "ok",
        advanceMs: 90_000, // crosses 09:31:00Z
        expect: {
          llmCalls: 0, // audit 15: "ok" is an ack on the fast path
          sentTo: [
            { channel: "whatsapp", peer: "919900000000" },
            { channel: "whatsapp", peer: "919900000000" },
          ],
          // C.3 E12: "text has WHAT + 'Due now' + 'snooze'".
          delivered: { count: 1, includes: ["drink water", "Due now", "snooze"] },
        },
      },
    ],
  },
];
