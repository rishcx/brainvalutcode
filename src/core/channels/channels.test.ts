import assert from "node:assert/strict";
import { test } from "node:test";
import { hmacSha256Hex } from "../crypto.ts";
import { fakeFetch } from "../testing/fakes.ts";
import { testContext } from "../../node/testing/context.ts";
import type { Deadline } from "../types.ts";
import { chunk, formatReminderBatch, listingOrder, persistListing } from "./format.ts";
import { TelegramChannel, telegramWebhook } from "./telegram.ts";
import { WhatsappChannel, whatsappVerifyChallenge, whatsappWebhook } from "./whatsapp.ts";

const ENV: Record<string, string> = {
  TELEGRAM_TOKEN: "tg-token", TELEGRAM_WEBHOOK_SECRET: "tg-secret",
  WHATSAPP_TOKEN: "wa-token", WHATSAPP_PHONE_ID: "555", WHATSAPP_APP_SECRET: "app-secret", WHATSAPP_VERIFY_TOKEN: "vt",
};
const patch = {
  channels: {
    telegram: { enabled: true, allowedChatIds: ["42"] },
    whatsapp: { enabled: true, allowedWaIds: ["9199"], templateName: "deadline_reminder" },
  },
};
const mk = (o: Parameters<typeof testContext>[0] = {}) =>
  testContext({ configPatch: patch, env: (k) => ENV[k], ...o });

test("chunk: 5000 chars -> 2 non-empty chunks <= 4096; no empty chunks, no split surrogates", () => {
  const parts = chunk("a".repeat(5000));
  assert.equal(parts.length, 2);
  assert.ok(parts.every((p) => p.length > 0 && p.length <= 4096));
  assert.equal(parts.join(""), "a".repeat(5000));
  const emoji = chunk("\u{1F600}".repeat(5), 5); // 10 UTF-16 units, cut must not land mid-pair
  assert.ok(emoji.every((p) => !/[\ud800-\udbff]$/.test(p) && !/^[\udc00-\udfff]/.test(p)));
  assert.equal(emoji.join(""), "\u{1F600}".repeat(5));
  assert.deepEqual(chunk("a\n\n\n\nb", 3).filter((x) => !x.trim()), []);
  assert.deepEqual(chunk("para one\n\npara two", 10), ["para one", "para two"]);
});

test("telegram send: 5000 chars => 2 fetch calls in order, token only in URL", async () => {
  const f = fakeFetch([{ match: "api.telegram.org/bottg-token/sendMessage", json: { ok: true } }]);
  const ctx = mk({ fetch: f });
  const text = "x".repeat(4096) + "y".repeat(904);
  await new TelegramChannel(ctx).send(text);
  assert.equal(f.calls.length, 2);
  assert.equal(JSON.parse(f.calls[0]!.body!).text[0], "x");
  assert.equal(JSON.parse(f.calls[1]!.body!).text[0], "y");
  assert.equal(JSON.parse(f.calls[0]!.body!).chat_id, "42");
});

test("telegram send: HTTP failure rejects without leaking the token", async () => {
  const ctx = mk({ fetch: fakeFetch([{ match: "telegram", status: 500, json: {} }]) });
  await assert.rejects(new TelegramChannel(ctx).send("hi"), (e: Error) => !e.message.includes("tg-token"));
});

test("telegram webhook: wrong/missing secret fails; foreign chat dropped; junk never throws", async () => {
  const ctx = mk();
  const req = (h: Record<string, string>) => new Request("https://x/wh", { method: "POST", headers: h });
  assert.equal(await telegramWebhook.verify(req({ "X-Telegram-Bot-Api-Secret-Token": "tg-secret" }), "", ctx), true);
  assert.equal(await telegramWebhook.verify(req({ "X-Telegram-Bot-Api-Secret-Token": "nope" }), "", ctx), false);
  assert.equal(await telegramWebhook.verify(req({}), "", ctx), false);
  const upd = (chat: number) => JSON.stringify({ update_id: 7, message: { text: "status", date: 1790000000, chat: { id: chat } } });
  const ok = await telegramWebhook.parse(upd(42), ctx);
  assert.deepEqual(ok.map((m) => [m.id, m.from, m.text]), [["7", "42", "status"]]);
  assert.deepEqual(await telegramWebhook.parse(upd(43), ctx), []);
  for (const junk of ["", "{", "null", "[]", '{"message":5}', '{"update_id":1,"message":{"text":"x"}}']) {
    assert.deepEqual(await telegramWebhook.parse(junk, ctx), []);
  }
});

test("whatsapp signature: raw body verifies; wrong, missing, truncated, re-serialised all fail", async () => {
  const ctx = mk();
  const raw = '{ "object" : "whatsapp_business_account",  "entry":[] }'; // deliberately odd spacing
  const sig = await hmacSha256Hex("app-secret", raw);
  const req = (h?: string) => new Request("https://x/wh", { method: "POST", headers: h ? { "X-Hub-Signature-256": h } : {} });
  assert.equal(await whatsappWebhook.verify(req(`sha256=${sig}`), raw, ctx), true);
  assert.equal(await whatsappWebhook.verify(req(`sha256=${"0".repeat(64)}`), raw, ctx), false);
  assert.equal(await whatsappWebhook.verify(req(), raw, ctx), false);
  assert.equal(await whatsappWebhook.verify(req(`sha256=${sig.slice(0, 10)}`), raw, ctx), false);
  assert.equal(await whatsappWebhook.verify(req(sig), raw, ctx), false); // no prefix
  const reser = await hmacSha256Hex("app-secret", JSON.stringify(JSON.parse(raw)));
  assert.equal(await whatsappWebhook.verify(req(`sha256=${reser}`), raw, ctx), false);
  const noSecret = mk({ env: () => undefined });
  assert.equal(await whatsappWebhook.verify(req(`sha256=${sig}`), raw, noSecret), false);
});

test("whatsapp verify challenge and parse (allowlist, text only, records lastInbound)", async () => {
  const ctx = mk();
  const u = (q: string) => new URL(`https://x/wh?${q}`);
  assert.equal(whatsappVerifyChallenge(u("hub.mode=subscribe&hub.verify_token=vt&hub.challenge=abc"), ctx), "abc");
  assert.equal(whatsappVerifyChallenge(u("hub.mode=subscribe&hub.verify_token=bad&hub.challenge=abc"), ctx), null);
  assert.equal(whatsappVerifyChallenge(u("hub.mode=other&hub.verify_token=vt&hub.challenge=abc"), ctx), null);
  const body = (from: string, type = "text") => JSON.stringify({
    entry: [{ changes: [{ value: { messages: [{ id: "wamid.1", from, type, timestamp: "1790000000", text: { body: "hi" } }] } }] }],
  });
  assert.deepEqual(await whatsappWebhook.parse(body("1111"), ctx), []);
  assert.equal(await ctx.store.kvGet("wa:lastInbound:1111"), null); // no store write for strangers
  assert.deepEqual(await whatsappWebhook.parse(body("9199", "image"), ctx), []);
  const [m] = await whatsappWebhook.parse(body("9199"), ctx);
  assert.deepEqual([m!.id, m!.from, m!.text, m!.channel], ["wamid.1", "9199", "hi", "whatsapp"]);
  assert.ok(await ctx.store.kvGet("wa:lastInbound:9199"));
  assert.deepEqual(await whatsappWebhook.parse("junk", ctx), []);
});

test("whatsapp send: free-form within 24h, template after", async () => {
  const f = fakeFetch([{ match: "graph.facebook.com/v21.0/555/messages", json: {} }]);
  const ctx = mk({ fetch: f, at: "2026-09-20T12:00:00Z" });
  await ctx.store.kvSet("wa:lastInbound:9199", "2026-09-20T11:00:00Z", "2026-09-20T11:00:00Z");
  await new WhatsappChannel(ctx).send("hello\nworld");
  const a = JSON.parse(f.calls[0]!.body!);
  assert.equal(a.type, "text");
  assert.equal(a.text.body, "hello\nworld");
  assert.equal(f.calls[0]!.headers.authorization, "Bearer wa-token");

  await ctx.store.kvSet("wa:lastInbound:9199", "2026-09-19T06:00:00Z", "2026-09-19T06:00:00Z"); // 30h ago
  await new WhatsappChannel(ctx).send("hello\nworld");
  const b = JSON.parse(f.calls[1]!.body!);
  assert.equal(b.type, "template");
  assert.equal(b.template.name, "deadline_reminder");
  assert.equal(b.template.components[0].parameters[0].text, "hello world");

  const fresh = mk({ fetch: f }); // never heard from: template
  await new WhatsappChannel(fresh).send("x");
  assert.equal(JSON.parse(f.calls[2]!.body!).type, "template");
});

const dl = (id: string, title: string, dueAt: string, timed?: boolean): Deadline => ({
  id, source: "chat", sourceRef: "x", title, dueAt, status: "open", confidence: 1, notePath: "Deadlines/index.md", timed,
});

test("formatReminderBatch: one on-time item is a friendly plain line, no markdown", () => {
  const ctx = testContext({ at: "2026-09-21T10:03:05Z" });
  assert.equal(formatReminderBatch([dl("a", "drink water", "2026-09-21T10:03:00.000Z", true)], ctx), "⏰ drink water");
  assert.equal(formatReminderBatch([dl("a", "  drink\n  water ", "2026-09-21T10:03:00.000Z")], ctx), "⏰ drink water");
});

test("formatReminderBatch: due time shown only when it differs from now", () => {
  const ctx = testContext({ at: "2026-09-21T10:00:00Z" }); // 15:30 IST
  assert.equal(formatReminderBatch([dl("a", "flight", "2026-09-21T14:30:00.000Z", true)], ctx), "⏰ flight (due 20:00)");
  assert.equal(formatReminderBatch([dl("a", "flight", "2026-09-22T12:30:00.000Z", true)], ctx), "⏰ flight (due tomorrow 18:00)");
  assert.equal(formatReminderBatch([dl("a", "rent", "2026-09-22T03:30:00.000Z")], ctx), "⏰ rent (due tomorrow)"); // untimed: date only
  assert.match(formatReminderBatch([dl("a", "rent", "2026-10-05T03:30:00.000Z")], ctx), /^⏰ rent \(due Mon 5 Oct\)$/);
});

test("formatReminderBatch: several items are a bulleted, numbered list; numbering matches persistListing", async () => {
  const ctx = testContext({ at: "2026-09-21T10:00:00Z" });
  const ds = [dl("b", "second", "2026-09-21T10:00:00.000Z"), dl("a", "first", "2026-09-21T09:59:00.000Z")];
  const text = formatReminderBatch(ds, ctx);
  assert.equal(text, "⏰ 2 reminders\n• 1. first\n• 2. second\n\nReply 'done <n>' when one is finished.");
  assert.ok(!/[*_`#\[\]]/.test(text));
  await persistListing(ctx, listingOrder(ds));
  assert.deepEqual(JSON.parse((await ctx.store.kvGet("last:list"))!), [{ k: "d", id: "a" }, { k: "d", id: "b" }]);
});

test("TelegramChannel.typing() posts sendChatAction to every allowed chat and never throws, even when Telegram is down", async () => {
  const calls: string[] = [];
  const ctx = testContext({
    configPatch: { channels: { telegram: { enabled: true, allowedChatIds: ["42"] } } },
    env: (n) => (n === "TELEGRAM_TOKEN" ? "tok" : undefined),
    fetch: async (u, init) => {
      calls.push(`${u.split("/").pop()} ${String(init?.body)}`);
      throw new Error("network down");
    },
  });
  await new TelegramChannel(ctx).typing(); // must resolve
  assert.deepEqual(calls, ['sendChatAction {"chat_id":"42","action":"typing"}']);
});
