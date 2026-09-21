// Archives yesterday's chat into Threads/<date>.md, then purges old turns. Idempotent per date.
import { summarisePrompt } from "../brain/prompts.ts";
import { cap, cleanText, cut } from "../chat/text.ts";
import { addDaysToLocalDate, localDate } from "../time.ts";
import type { AgentContext, ChannelId, ChatTurn, JobSpec } from "../types.ts";

const esc = (s: string): string => s.replace(/[\\[\]<>#]/g, "\\$&");
const oneLine = (s: string): string => cleanText(s).replace(/\s+/g, " ");

function stub(turns: ChatTurn[]): string {
  const first = cap(oneLine(turns[0]?.text ?? ""), 60);
  const last = cap(oneLine(turns[turns.length - 1]?.text ?? ""), 60);
  return `${turns.length} messages; first: ${first}; last: ${last}`;
}

async function summarise(ctx: AgentContext, turns: ChatTurn[]): Promise<string> {
  if (ctx.brain) {
    try {
      const t = turns.map((x) => `${x.role === "user" ? "You" : "Brain"}: ${oneLine(x.text)}`).join("\n");
      const p = summarisePrompt(t, 800);
      const r = await ctx.brain.complete({ system: p.system, prompt: p.prompt, maxTokens: 400, cacheTtlMs: 0 });
      const text = oneLine(cut(r.text, 800));
      if (text && r.entry !== "deterministic") return text;
    } catch {
      /* stub below */
    }
  }
  return stub(turns);
}

export const dailyChatJob: JobSpec = {
  name: "chat:daily",
  schedule: { dailyAtLocal: "00:10" },
  async run(ctx: AgentContext): Promise<string> {
    const cfg = ctx.config;
    if (!cfg.chat.enabled) return "disabled";
    const today = localDate(ctx.clock);
    const target = addDaysToLocalDate(today, -1);
    const gate = `chat:archived:${target}`;
    if ((await ctx.store.kvGet(gate)) !== null) return "already archived";

    const peers: { channel: ChannelId; peer: string }[] = [
      ...(cfg.channels.telegram.enabled ? cfg.channels.telegram.allowedChatIds.map((peer) => ({ channel: "telegram" as const, peer })) : []),
      ...(cfg.channels.whatsapp.enabled ? cfg.channels.whatsapp.allowedWaIds.map((peer) => ({ channel: "whatsapp" as const, peer })) : []),
    ];
    const sections: string[] = [];
    let total = 0;
    let threads = 0;
    for (const channel of ["telegram", "whatsapp"] as const) {
      const body: string[] = [];
      for (const p of peers.filter((x) => x.channel === channel)) {
        const turns = await ctx.store.turnsForDay(channel, p.peer, target);
        if (turns.length === 0) continue;
        total += turns.length;
        threads++;
        if (cfg.chat.transcript === "full") {
          body.push(turns.map((t) => `**${t.role === "user" ? "You" : "Brain"}**: ${esc(oneLine(t.text))}`).join("\n\n"));
        } else {
          body.push(esc(await summarise(ctx, turns)));
        }
      }
      if (body.length) sections.push(`## ${channel === "telegram" ? "Telegram" : "WhatsApp"}\n\n${body.join("\n\n")}`);
    }

    if (total > 0) {
      const md = `---\ntype: thread\ndate: ${target}\nmessages: ${total}\n---\n\n# Chat ${target}\n\n${sections.join("\n\n")}\n`;
      await ctx.vault.writeFiles(`chat: archive ${target}`, [{ path: `Threads/${target}.md`, content: md }]); // throws: gate stays unset, no purge
    }
    const purged = await ctx.store.purgeTurnsBefore(addDaysToLocalDate(today, -cfg.chat.memory.retainDays));
    await ctx.store.kvSet(gate, "1", ctx.clock.now().toISOString());
    return `archived ${threads} thread(s), purged ${purged} turns`;
  },
};
