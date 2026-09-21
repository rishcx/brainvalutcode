// Integrator tests for the V3-1 wiring in commands.ts: origin channel, per-chat numbering, snooze/done/cancel.
import assert from "node:assert/strict";
import { test } from "node:test";
import { testContext } from "../../node/testing/context.ts";
import { MemoryChannel } from "../testing/fakes.ts";
import { deliverDue } from "../reminders/deliver.ts";
import type { AgentContext, InboundMessage } from "../types.ts";
import { handleInbound } from "./commands.ts";

const patch = {
  channels: {
    telegram: { enabled: true, allowedChatIds: ["42"] },
    whatsapp: { enabled: true, allowedWaIds: ["919900000000"] },
  },
};
let n = 0;
const from = (ch: "telegram" | "whatsapp") => (ch === "telegram" ? "42" : "919900000000");
const say = (ctx: AgentContext, ch: "telegram" | "whatsapp", text: string) =>
  handleInbound(ctx, { channel: ch, id: `m${++n}`, from: from(ch), text, at: ctx.clock.now().toISOString() } satisfies InboundMessage);

function mk(at = "2026-09-21T09:00:00.000Z") {
  const tg = new MemoryChannel("telegram");
  const wa = new MemoryChannel("whatsapp");
  const ctx = testContext({ configPatch: patch, at, channels: [tg, wa] });
  return { ctx, tg, wa };
}

test("a reminder set on WhatsApp is delivered ONLY on WhatsApp, and the message says what it is for", async () => {
  const { ctx, tg, wa } = mk();
  assert.match((await say(ctx, "whatsapp", "remind me in 2 minutes to drink water"))!, /Reminder set/);
  const later = testContext({ configPatch: patch, at: "2026-09-21T09:02:30.000Z", channels: [tg, wa], store: ctx.store });
  await deliverDue(later);
  assert.equal(tg.sentTo.length, 0, "nothing on Telegram");
  assert.equal(wa.sentTo.length, 1);
  assert.equal(wa.sentTo[0]!.peer, "919900000000");
  assert.match(wa.sentTo[0]!.text, /drink water/i);
  assert.match(wa.sentTo[0]!.text, /snooze/i);
});

test("'snooze 10m' then 'done' act on the reminder just delivered to this chat", async () => {
  const { ctx, tg, wa } = mk();
  await say(ctx, "telegram", "remind me in 1 minute to stretch");
  const t1 = testContext({ configPatch: patch, at: "2026-09-21T09:01:30.000Z", channels: [tg, wa], store: ctx.store });
  await deliverDue(t1);
  assert.equal(tg.sentTo.length, 1);
  assert.match((await say(t1, "telegram", "snooze 10m"))!, /Snoozed: stretch/);
  const t2 = testContext({ configPatch: patch, at: "2026-09-21T09:12:30.000Z", channels: [tg, wa], store: ctx.store });
  await deliverDue(t2);
  assert.equal(tg.sentTo.length, 2, "fires again after the snooze");
  assert.match((await say(t2, "telegram", "done"))!, /Marked done: stretch/);
  const [d] = await ctx.store.listDeadlines({ status: ["done"] });
  assert.equal(d?.title, "stretch");
});

test("numbered lists are per chat: 'done 1' on Telegram never touches the WhatsApp list", async () => {
  const { ctx } = mk();
  await say(ctx, "telegram", "add task buy milk");
  await say(ctx, "telegram", "tasks");
  await say(ctx, "whatsapp", "remind me to pay rent on 1 Oct 2026");
  await say(ctx, "whatsapp", "status");
  assert.match((await say(ctx, "telegram", "done 1"))!, /buy milk/);
  assert.equal((await ctx.store.listDeadlines({ status: ["open"] })).length, 1, "the WhatsApp deadline is still open");
});

test("'snooze' with nothing recently delivered says so; bare 'done' with nothing delivered falls through", async () => {
  const { ctx } = mk();
  assert.match((await say(ctx, "telegram", "snooze 5m"))!, /no recent reminder/i);
  assert.doesNotMatch((await say(ctx, "telegram", "done"))!, /Marked done/);
});
