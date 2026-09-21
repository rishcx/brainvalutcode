// G1-G8: PLAN_V3 C.3 "Deadlines, GitHub, notes". All need the real V3-2 handler.
import type { Scenario, Turn } from "../types.ts";

const AT = "2026-09-21T09:30:00Z"; // 15:00 IST
const REQUIRES = "v3-2" as const;
const one = (t: Turn): Scenario["turns"] => [t];
const listDeadlines = (range: string) => ({ intent: "list_deadlines", tools: [{ name: "list_deadlines", args: { range } }], say: "", compose: false });

export const READ: Scenario[] = [
  {
    id: "G1",
    tags: ["deadlines"],
    requires: REQUIRES,
    at: AT,
    seed: { deadlines: [{ title: "essay", dueAt: "2026-09-24T03:30:00Z", source: "manual", sourceRef: "x" }] },
    turns: one({ text: "what's due this week", plan: listDeadlines("week"), expect: { route: "plan", llmCalls: 1, tools: ["list_deadlines"], reply: { includes: ["essay"] } } }),
  },
  {
    id: "G2",
    tags: ["deadlines"],
    requires: REQUIRES,
    at: AT,
    turns: one({ text: "anything overdue?", plan: listDeadlines("overdue"), expect: { llmCalls: 1, reply: { includes: ["Nothing is overdue"] } } }),
  },
  {
    id: "G3",
    tags: ["github"],
    requires: REQUIRES,
    at: AT,
    seed: {
      involvement: {
        login: "me",
        assignedIssues: [],
        myOpenPrs: [],
        reviewRequests: [{ repo: "me/soup", number: 12, title: "fix flaky test", url: "https://github.com/me/soup/pull/12", updatedAt: AT, state: "OPEN" }],
        mentions: [],
        recentRepos: [],
        totals: { assignedIssues: 0, myOpenPrs: 0, reviewRequests: 1, mentions: 0 },
        fetchedAt: AT,
        partial: [],
      },
    },
    turns: one({
      text: "any PRs waiting for my review",
      plan: { intent: "github_involvement", tools: [{ name: "github_involvement", args: { bucket: "reviews" } }], say: "", compose: false },
      expect: { llmCalls: 1, tools: ["github_involvement"], reply: { includes: ["fix flaky test"] } },
    }),
  },
  {
    id: "G4",
    tags: ["github"],
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
    turns: one({
      text: "summarise my github",
      plan: { intent: "github_involvement", tools: [{ name: "github_involvement", args: { bucket: "all" } }], say: "", compose: true },
      compose: "You have 1 assigned issue: Soup #831 - GPU pricing bug.",
      expect: { route: "plan+compose", llmCalls: 2, reply: { includes: ["Soup #831"], excludes: ["marginal"] } },
    }),
  },
  {
    id: "G5",
    tags: ["notes", "live"],
    requires: REQUIRES,
    at: AT,
    seed: { notes: [{ path: "Notes/gpu.md", sha: "s1", title: "GPU pricing bug", tokens: "gpu pricing bug", excerpt: "The GPU pricing bug was traced to a stale cache key.", updatedAt: AT }] },
    turns: one({
      text: "what did I write about the GPU pricing bug",
      plan: { intent: "search_notes", tools: [{ name: "search_notes", args: { query: "GPU pricing bug" } }], say: "", compose: true },
      compose: "You wrote that the GPU pricing bug was traced to a stale cache key (Notes/gpu.md).",
      expect: { route: "plan+compose", llmCalls: 2, tools: ["search_notes"], reply: { includes: ["stale cache key", "Notes/gpu.md"] } },
    }),
  },
  {
    id: "G6",
    tags: ["notes"],
    requires: REQUIRES,
    at: AT,
    turns: one({
      text: "what's my passport number",
      plan: { intent: "search_notes", tools: [{ name: "search_notes", args: { query: "passport number" } }], say: "", compose: false },
      expect: { llmCalls: 1, tools: ["search_notes"], reply: { includes: ["couldn't find"] } },
    }),
  },
  {
    id: "G7",
    tags: ["fast"],
    requires: REQUIRES,
    at: AT,
    turns: one({ text: "status", expect: { route: "fast", llmCalls: 0 } }),
  },
  {
    id: "G8",
    tags: ["deadlines", "tasks"],
    requires: REQUIRES,
    at: AT,
    seed: { tasks: [{ title: "buy milk" }], deadlines: [{ title: "essay", dueAt: "2026-09-22T03:30:00Z", source: "manual", sourceRef: "x" }] },
    turns: one({
      text: "what should I work on first today?",
      plan: { intent: "list_tasks", tools: [{ name: "list_tasks", args: { day: "today", include_done: false } }, { name: "list_deadlines", args: { range: "today" } }], say: "", compose: true },
      compose: "Start with the essay, due tomorrow morning; buy milk can wait until later today.",
      expect: { route: "plan+compose", llmCalls: 2, reply: { includes: ["essay"], maxChars: 700 } },
    }),
  },
];
