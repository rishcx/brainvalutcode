// Proactive morning agenda on chat (audit C): one code-rendered message a day at 08:00 local, to the owner's
// default channel. No LLM. Idempotent per local date; a WhatsApp send that the 24h window rejects falls back to
// the default channel, exactly as reminder delivery does.
import { agendaText } from "../agent/agenda.ts";
import type { Target } from "../agent/contract.ts";
import { targetFor } from "../reminders/deliver.ts";
import { localDate, localTimeOf } from "../time.ts";
import type { AgentContext, Deadline, JobSpec } from "../types.ts";

const NO_ORIGIN = { originChannel: null, originPeer: null } as Deadline;

export const chatAgendaJob: JobSpec = {
  name: "chat:agenda",
  schedule: { dailyAtLocal: "08:00" },
  async run(ctx: AgentContext): Promise<string> {
    if (!ctx.config.chat.enabled) return "disabled";
    // A morning brief is only a morning brief: a first registration or a long outage must not deliver it at 15:00.
    const hour = Number(localTimeOf(ctx.clock.now(), ctx.clock.tz).slice(0, 2));
    if (hour < 8 || hour >= 11) return "outside the morning window";
    const today = localDate(ctx.clock);
    const gate = `agenda:sent:${today}`;
    if ((await ctx.store.kvGet(gate)) !== null) return "already sent";

    const channels = ctx.channels ?? [];
    const target: Target | null = targetFor(NO_ORIGIN, ctx.config, channels.map((c) => c.id));
    if (!target) return "no channel";

    const text = await agendaText(ctx, target);
    const send = async (t: Target): Promise<void> => {
      const ch = channels.find((c) => c.id === t.channel);
      if (!ch) throw new Error(`no channel ${t.channel}`);
      if (ch.sendTo) await ch.sendTo(t.peer, text);
      else await ch.send(text);
    };
    try {
      await send(target);
    } catch (e) {
      // e.g. the WhatsApp 24h window is closed: try the other enabled channels, as reminder delivery does.
      const fb = targetFor(NO_ORIGIN, ctx.config, channels.map((c) => c.id).filter((id) => id !== target.channel));
      if (!fb) throw e;
      await send(fb); // throws: the gate stays unset and the next tick tries again
      await ctx.store.kvSet(gate, "1", ctx.clock.now().toISOString());
      return `sent to ${fb.channel} (fallback from ${target.channel})`;
    }
    await ctx.store.kvSet(gate, "1", ctx.clock.now().toISOString());
    return `sent to ${target.channel}`;
  },
};
