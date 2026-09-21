// D1-D6: PLAN_V3 C.3 "Channels and delivery". D5/D6 call the reminder job directly (brief: "S1 and D5/D6 may
// call the jobs directly instead of the handler"); D6 goes through runDueJobs, the Worker cron's own entry point.
import { runDueJobs } from "../../../core/jobs/dispatch.ts";
import { sweepReminders } from "../../../core/jobs/reminders.ts";
import type { AgentContext, Channel } from "../../../core/types.ts";
import type { Scenario, Turn } from "../types.ts";

const AT = "2026-09-21T09:30:00Z"; // 15:00 IST
const REQUIRES = "v3-2" as const;
const one = (t: Turn): Scenario["turns"] => [t];

export const CHANNELS: Scenario[] = [
  {
    id: "D1",
    tags: ["channels", "fast"],
    requires: REQUIRES,
    at: AT,
    turns: one({ channel: "telegram", text: "status", expect: { route: "fast", llmCalls: 0, sentTo: [{ channel: "telegram", peer: "111" }] } }),
  },
  {
    id: "D2",
    tags: ["channels", "reminder"],
    requires: REQUIRES,
    at: AT,
    seed: { deadlines: [{ id: "eval:d2", title: "call mom", dueAt: "2026-09-21T09:31:00Z", source: "chat", sourceRef: "x", confidence: 1, originChannel: "whatsapp", originPeer: "919900000000" }] },
    turns: one({
      channel: "whatsapp",
      text: "ok",
      advanceMs: 90_000,

      expect: { llmCalls:  0, sentTo: [{ channel: "whatsapp", peer: "919900000000" }, { channel: "whatsapp", peer: "919900000000" }], delivered: { count: 1, includes: ["call mom", "Due now", "snooze"] } },
    }),
  },
  {
    id: "D3",
    tags: ["channels", "reminder", "github"],
    requires: REQUIRES,
    at: AT,
    seed: { deadlines: [{ id: "eval:d3", title: "v2 milestone", dueAt: "2026-09-21T09:31:00Z", source: "github", sourceRef: "x" }] },
    turns: one({
      channel: "telegram",
      text: "ok",
      advanceMs: 90_000,

      expect: { llmCalls:  0, sentTo: [{ channel: "telegram", peer: "111" }, { channel: "telegram", peer: "111" }], // First polled on its (date-only) due day: the late 24h heads-up must not claim "In 24 hours".
      delivered: { count: 1, includes: ["v2 milestone", "Due today"], excludes: ["In 24 hours"] } },
    }),
  },
  {
    id: "D4",
    tags: ["channels", "reminder"],
    requires: REQUIRES,
    at: AT,
    // Approximates "WhatsApp 24h window closed + template rejected" by disabling whatsapp outright: the
    // sweep must fall back to the default channel (telegram) rather than drop the delivery.
    configPatch: { channels: { telegram: { enabled: true, allowedChatIds: ["111"] }, whatsapp: { enabled: false, allowedWaIds: [] }, defaultChannel: "telegram" } },
    seed: { deadlines: [{ id: "eval:d4", title: "call mom", dueAt: "2026-09-21T09:31:00Z", source: "chat", sourceRef: "x", confidence: 1, originChannel: "whatsapp", originPeer: "919900000000" }] },
    turns: one({
      channel: "telegram",
      text: "ok",
      advanceMs: 90_000,

      expect: { llmCalls:  0, sentTo: [{ channel: "telegram", peer: "111" }, { channel: "telegram", peer: "111" }] },
    }),
  },
  {
    id: "D5",
    tags: ["channels", "reminder"],
    requires: REQUIRES,
    at: AT,
    seed: { deadlines: [{ id: "eval:d5", title: "call mom", dueAt: "2026-09-21T09:29:00Z", source: "chat", sourceRef: "x", confidence: 1, originChannel: "telegram", originPeer: "111" }] },
    turns: [],
    direct: async (ctx: AgentContext) => {
      const failures: string[] = [];
      const [a, b] = await Promise.all([sweepReminders.run(ctx), sweepReminders.run(ctx)]);
      const sent = a.includes("sent=1") || b.includes("sent=1");
      const bothSent = a.includes("sent=1") && b.includes("sent=1");
      if (!sent) failures.push(`neither overlapping sweep reported a send: ${a} / ${b}`);
      if (bothSent) failures.push(`both overlapping sweeps sent (expected exactly one): ${a} / ${b}`);
      return { failures };
    },
  },
  {
    id: "D6",
    tags: ["channels", "reminder"],
    requires: REQUIRES,
    at: AT,
    seed: { deadlines: [{ id: "eval:d6", title: "call mom", dueAt: "2026-09-21T09:29:00Z", source: "chat", sourceRef: "x", confidence: 1, originChannel: "telegram", originPeer: "111" }] },
    turns: [],
    // C.3 D6 "send fails once -> retried next tick, attempts=2, then ok", driven through the Worker's own cron
    // entry (scheduled() -> runDueJobs -> sweep:reminders -> deliverDue -> channel.sendTo), so registry membership
    // and the every-minute schedule are proven too, not just the sweep function.
    direct: async (ctx: AgentContext) => {
      const failures: string[] = [];
      const sent: string[] = [];
      let calls = 0;
      const flaky: Channel = {
        id: "telegram",
        async send() {
          throw new Error("send() must not be used for a reminder with a known peer");
        },
        async sendTo(peer: string, text: string) {
          calls++;
          if (calls === 1) throw new Error("telegram 502");
          sent.push(`${peer}:${text}`);
        },
      };
      ctx.channels = [flaky];
      const clock = ctx.clock as unknown as { advance(ms: number): void };
      const sweepOf = (rs: { name: string; detail: string }[]): string => rs.find((r) => r.name === "sweep:reminders")?.detail ?? "not run";

      const tick1 = sweepOf(await runDueJobs(ctx));
      const row1 = (await ctx.store.listReminders("eval:d6"))[0];
      if (!tick1.includes("failed=1")) failures.push(`tick 1: expected the injected failure, got ${tick1}`);
      if (row1?.sentAt !== null || row1?.attempts !== 1) failures.push(`tick 1: row should be unsent with attempts=1, got sentAt=${row1?.sentAt} attempts=${row1?.attempts}`);

      clock.advance(60_000);
      const tick2 = sweepOf(await runDueJobs(ctx));
      const row2 = (await ctx.store.listReminders("eval:d6"))[0];
      if (!tick2.includes("sent=1")) failures.push(`tick 2: expected a retry that delivers, got ${tick2}`);
      if (row2?.sentAt === null) failures.push("tick 2: row still unsent");
      if (calls !== 2) failures.push(`expected exactly 2 send attempts (attempt 2 succeeds), got ${calls}`);
      if (sent.length !== 1 || !sent[0]?.startsWith("111:") || !sent[0].includes("call mom")) failures.push(`delivered text wrong: ${JSON.stringify(sent)}`);

      clock.advance(60_000);
      const tick3 = sweepOf(await runDueJobs(ctx));
      if (calls !== 2) failures.push(`tick 3 re-sent a delivered reminder (${tick3})`);
      return { failures };
    },
  },
];
