import assert from "node:assert/strict";
import { test } from "node:test";
import { testContext } from "../../node/testing/context.ts";
import { addTask } from "../tasks/index.ts";
import { handleInbound } from "../inbound/commands.ts";

const patch = { channels: { telegram: { enabled: true, allowedChatIds: ["42"] } } };

test("a model reply that is empty and has no actions falls back to the user's real facts, never 'I didn't quite catch that'", async () => {
  const ctx = testContext({ configPatch: patch });
  ctx.brain = { complete: async () => ({ text: '{"reply":"","actions":[]}', entry: "openrouter", ms: 1, cached: false }) } as never;
  await addTask(ctx, { title: "buy milk", recurrence: null });
  const reply = (await handleInbound(ctx, { channel: "telegram", id: "1", from: "42", text: "what's on my plate?", at: "2026-09-20T04:30:00.000Z" }))!;
  assert.doesNotMatch(reply, /didn't quite catch|error|undefined/i);
  assert.match(reply, /buy milk/i);
  assert.doesNotMatch(reply, /\*\*|##/);
});

test("a model that 'thinks out loud' never leaks reasoning to the user: it is retried, and the good second answer is used", async () => {
  const ctx = testContext({ configPatch: patch });
  const outputs = [
    "We need to output JSON with reply and actions. The user asks \"what can you do?\" They want a summary. According to style, we should answer first.",
    '{"reply":"I set reminders and tasks, and summarise your GitHub work.","actions":[]}',
  ];
  let calls = 0;
  ctx.brain = { complete: async () => ({ text: outputs[Math.min(calls++, 1)]!, entry: "openrouter", ms: 1, cached: false }) } as never;
  const reply = (await handleInbound(ctx, { channel: "telegram", id: "1", from: "42", text: "what can you do?", at: "2026-09-20T04:30:00.000Z" }))!;
  assert.equal(calls, 2);
  assert.match(reply, /reminders and tasks/);
  assert.doesNotMatch(reply, /We need to|The user asks|output JSON/i);
});

test("if EVERY attempt leaks reasoning the user gets the friendly fallback, never the reasoning; <think> blocks are stripped", async () => {
  const ctx = testContext({ configPatch: patch });
  ctx.brain = { complete: async () => ({ text: "The user asks something. We need to output JSON with reply.", entry: "openrouter", ms: 1, cached: false }) } as never;
  const reply = (await handleInbound(ctx, { channel: "telegram", id: "1", from: "42", text: "hello there", at: "2026-09-20T04:30:00.000Z" }))!;
  assert.doesNotMatch(reply, /We need to|The user asks|output JSON/i);
  assert.match(reply, /trouble reaching/i);

  const ctx2 = testContext({ configPatch: patch });
  ctx2.brain = { complete: async () => ({ text: '<think>we need to output json ... the user asks</think>{"reply":"Hi there!","actions":[]}', entry: "openrouter", ms: 1, cached: false }) } as never;
  assert.equal(await handleInbound(ctx2, { channel: "telegram", id: "1", from: "42", text: "hello", at: "2026-09-20T04:30:00.000Z" }), "Hi there!");
});

test("a moderation/classifier verdict such as 'User Safety: safe' is never shown as an answer", async () => {
  const ctx = testContext({ configPatch: patch });
  const outputs = ["User Safety: safe", '{"reply":"Two tasks today: buy milk and gym.","actions":[]}'];
  let calls = 0;
  ctx.brain = { complete: async () => ({ text: outputs[Math.min(calls++, 1)]!, entry: "openrouter", ms: 1, cached: false }) } as never;
  await addTask(ctx, { title: "buy milk", recurrence: null });
  const reply = (await handleInbound(ctx, { channel: "telegram", id: "1", from: "42", text: "Any task for today?", at: "2026-09-20T04:30:00.000Z" }))!;
  assert.doesNotMatch(reply, /Safety/i);
  assert.match(reply, /buy milk/);
});
