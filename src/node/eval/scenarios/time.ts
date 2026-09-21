// S1-S4: PLAN_V3 C.3 "Scheduler and time". S1 calls the scheduler directly (brief: "S1 ... may call the jobs
// directly instead of the handler") and needs no later phase: nextRunAt is pure V3-0-era logic.
import { nextRunAt } from "../../../core/jobs/dispatch.ts";
import type { AgentContext } from "../../../core/types.ts";
import type { Scenario, Turn } from "../types.ts";

const REQUIRES = "v3-2" as const;
const one = (t: Turn): Scenario["turns"] => [t];
const cr = (what: string | null, when_text: string | null) => ({ intent: "create_reminder", tools: [{ name: "create_reminder", args: { what, when_text, at_local: null } }], say: "", compose: false });

export const TIME: Scenario[] = [
  {
    id: "S1",
    tags: ["time", "scheduler"],
    at: "2026-09-21T09:34:04Z",
    turns: [],
    direct: async (ctx: AgentContext) => {
      const failures: string[] = [];
      const next = nextRunAt({ everyMinutes: 1 }, ctx.clock.now(), ctx.clock.tz);
      if (next.toISOString() !== "2026-09-21T09:35:00.000Z") failures.push(`nextRunAt: expected 09:35:00Z, got ${next.toISOString()}`);
      return { failures };
    },
  },
  {
    id: "S2",
    tags: ["time", "reminder"],
    requires: REQUIRES,
    at: "2026-09-21T09:34:00Z",
    seed: { deadlines: [{ id: "eval:s2", title: "call mom", dueAt: "2026-09-21T09:35:00Z", source: "chat", sourceRef: "x", confidence: 1, originChannel: "telegram", originPeer: "111" }] },
    turns: one({
      text: "ok",
      advanceMs: 60_000, // lands exactly on the 09:35 tick

      expect: { llmCalls:  0, sentTo: [{ channel: "telegram", peer: "111" }, { channel: "telegram", peer: "111" }] },
    }),
  },
  {
    id: "S3",
    tags: ["time", "memory"],
    requires: REQUIRES,
    at: "2026-09-20T18:20:00Z", // 23:50 IST on 09-20
    turns: [
      { text: "remember the word unicorn7", plan: { intent: "smalltalk", tools: [], say: "Got it.", compose: false }, expect: { llmCalls: 1 } },
      {
        text: "what did I just say",
        advanceMs: 15 * 60_000, // 00:05 IST on 09-21: a new local day, so the 23:50 turn is out of context
        plan: { intent: "smalltalk", tools: [], say: "I don't have anything from today yet - what would you like?", compose: false },
        expect: { llmCalls: 1, reply: { excludes: ["unicorn7"] } },
      },
    ],
  },
  {
    id: "S4",
    tags: ["time", "reminder", "quietHours"],
    requires: REQUIRES,
    at: "2026-09-21T12:00:00Z", // 17:30 IST: well before 23:00, and before quiet hours start (22:00)
    turns: one({
      text: "remind me at 11pm to lock the door",
      plan: cr("lock the door", "at 11pm"),
      expect: { llmCalls: 1, db: { reminders: [{ title: "lock the door", dueLocal: "23:00", channel: "telegram" }] } },
    }),
  },
];
