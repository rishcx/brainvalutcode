// audit C: the proactive morning agenda on chat.
import assert from "node:assert/strict";
import { test } from "node:test";
import { testContext } from "../../node/testing/context.ts";
import { FixedClock } from "../clock.ts";
import type { AgentContext, Channel } from "../types.ts";
import { chatAgendaJob } from "./agenda.ts";

const recorder = (id: "telegram" | "whatsapp", fail = false): Channel & { sent: string[] } => {
  const sent: string[] = [];
  return {
    id,
    sent,
    async send(text: string) {
      sent.push(text);
    },
    async sendTo(_peer: string, text: string) {
      if (fail) throw new Error("24h window closed");
      sent.push(text);
    },
  } as Channel & { sent: string[] };
};

const ctxAt = (iso: string): AgentContext =>
  testContext({
    clock: new FixedClock(iso, "Asia/Kolkata"),
    configPatch: { channels: { telegram: { enabled: true, allowedChatIds: ["111"] }, defaultChannel: "telegram" } },
  });

test("chat:agenda sends one code-rendered brief at 08:00 local, once a day, with no LLM call", async () => {
  const ctx = ctxAt("2026-09-21T02:30:00Z"); // 08:00 IST
  const tg = recorder("telegram");
  ctx.channels = [tg];
  ctx.brain = undefined;
  await ctx.store.upsertDeadline({
    id: "a1", source: "chat", sourceRef: "x", title: "call mom", dueAt: "2026-09-21T12:30:00Z",
    status: "open", confidence: 1, notePath: "", originChannel: "telegram", originPeer: "111",
  });
  assert.equal(await chatAgendaJob.run(ctx), "sent to telegram");
  assert.equal(tg.sent.length, 1);
  assert.match(tg.sent[0]!, /^Your day - Monday 21 Sept?:/);
  assert.match(tg.sent[0]!, /call mom/);
  assert.ok(!tg.sent[0]!.includes("*"), "plain text only");
  assert.equal(await chatAgendaJob.run(ctx), "already sent");
  assert.equal(tg.sent.length, 1);
});

test("chat:agenda is a no-op outside the morning window and when chat is off", async () => {
  const late = ctxAt("2026-09-21T09:30:00Z"); // 15:00 IST
  late.channels = [recorder("telegram")];
  assert.equal(await chatAgendaJob.run(late), "outside the morning window");
  const off = ctxAt("2026-09-21T02:30:00Z");
  off.config = { ...off.config, chat: { ...off.config.chat, enabled: false } };
  assert.equal(await chatAgendaJob.run(off), "disabled");
});

test("chat:agenda falls back to the default channel when the origin channel refuses", async () => {
  const ctx = ctxAt("2026-09-21T02:30:00Z");
  const wa = recorder("whatsapp", true);
  const tg = recorder("telegram");
  ctx.channels = [wa, tg];
  ctx.config = {
    ...ctx.config,
    channels: { ...ctx.config.channels, whatsapp: { ...ctx.config.channels.whatsapp, enabled: true, allowedWaIds: ["919"] }, defaultChannel: "whatsapp" },
  };
  assert.equal(await chatAgendaJob.run(ctx), "sent to telegram (fallback from whatsapp)");
  assert.equal(wa.sent.length, 0);
  assert.equal(tg.sent.length, 1);
  assert.equal(await ctx.store.kvGet("agenda:sent:2026-09-21"), "1");
});
