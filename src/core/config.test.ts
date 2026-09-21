import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { chainFor, parseConfig } from "./config.ts";

test("parseConfig fills defaults and keeps the shipped brain.config.json valid", () => {
  const cfg = parseConfig({});
  assert.equal(cfg.timezone, "Asia/Kolkata");
  assert.equal(cfg.brain.budgetMs, 25_000);
  assert.equal(cfg.brain.cacheTtlMs, 86_400_000);
  assert.deepEqual(cfg.reminders.offsets, ["7d", "2d", "24h", "3h", "0"]);
  assert.deepEqual(cfg.reminders.quietHours, { start: "22:00", end: "08:00" });
  assert.equal(cfg.reminders.dueHourLocal, 9);

  const shipped = parseConfig(JSON.parse(readFileSync(new URL("../../brain.config.json", import.meta.url), "utf8")));
  assert.equal(typeof shipped.timezone, "string");
  assert.ok(shipped.brain.entries.length >= 2);
});

test("parseConfig rejects values that would only fail at 03:00 inside a cron", () => {
  assert.throws(() => parseConfig({ timezone: "Mars/Olympus" }), /unknown timezone/);
  assert.throws(() => parseConfig({ reminders: { offsets: ["soonish"] } }), /bad reminder offset/);
  assert.throws(() => parseConfig({ reminders: { quietHours: { start: "10pm", end: "08:00" } } }), /HH:MM/);
  assert.throws(() => parseConfig({ brain: { entries: [{ kind: "anthropic" }] } }), /kind must be/);
  // An HTTP entry with no models would be skipped silently by the chain at 03:00.
  assert.throws(() => parseConfig({ brain: { entries: [{ kind: "openrouter", name: "or", baseUrl: "https://x" }] } }), /no models/);
  assert.throws(() => parseConfig({ brain: { entries: [{ kind: "openrouter", name: "or", models: ["m"] }] } }), /no baseUrl/);
});

test("model ids come from config, never from code", () => {
  const cfg = parseConfig({
    brain: { entries: [{ kind: "openrouter", name: "or", baseUrl: "https://x/v1", models: ["x/y:free"], keyEnv: "K" }] },
  });
  assert.deepEqual(cfg.brain.entries[0]!.models, ["x/y:free"]);
});

test("chainFor drops the local gateway whenever the run is unattended", () => {
  const cfg = parseConfig({});
  const cli = chainFor(cfg, { allowLocalGateway: true });
  const worker = chainFor(cfg, { allowLocalGateway: false });
  assert.equal(cli[0]!.kind, "omniroute");
  assert.equal(worker.some((e) => e.local), false);
  assert.equal(worker.some((e) => e.kind === "omniroute"), false);
  // The deterministic fallback is always last, even if a config omits it.
  for (const chain of [cli, worker]) assert.equal(chain.at(-1)!.kind, "deterministic");
  const onlyLocal = parseConfig({ brain: { entries: [{ kind: "omniroute", name: "o", baseUrl: "http://x/v1", models: ["m"] }] } });
  assert.deepEqual(chainFor(onlyLocal, { allowLocalGateway: false }).map((e) => e.kind), ["deterministic"]);
});

test("numeric chat/WA ids in allowlists are kept (as strings), junk falls back to the default", () => {
  const tg = (ids: unknown) => parseConfig({ channels: { telegram: { enabled: true, allowedChatIds: ids } } }).channels.telegram.allowedChatIds;
  assert.deepEqual(tg([1201232794]), ["1201232794"]);
  assert.deepEqual(tg(["1201232794", 42]), ["1201232794", "42"]);
  assert.deepEqual(tg([{}]), []);
  assert.deepEqual(tg([Number.NaN]), []);
});

test("parseConfig fills every v2 section with the documented defaults", () => {
  const cfg = parseConfig({});
  assert.deepEqual(cfg.reminders.rules.map((r) => r.id), ["flight", "github", "assignment"]);
  assert.deepEqual(cfg.reminders.rules[0]!.offsets, ["24h"]);
  assert.equal(cfg.reminders.rules[0]!.needsTime, true);
  assert.deepEqual(cfg.reminders.rules[1]!.sources, ["github"]);
  assert.deepEqual(cfg.reminders.rules[2]!.offsets, ["2h"]);
  assert.deepEqual(cfg.tasks, { enabled: true, maxPerDay: 50, rolloverLocalTime: "03:00" });
  assert.equal(cfg.chat.persona, "Brain");
  assert.deepEqual(cfg.chat.memory, { verbatimChars: 2400, summaryChars: 600, summariseAboveChars: 3000, retainDays: 3 });
  assert.deepEqual(cfg.chat.context, { snapshotChars: 3000, notesChars: 2800, userChars: 1000 });
  assert.equal(cfg.chat.maxReplyTokens, 400);
  assert.deepEqual(cfg.github.involvement, { enabled: true, maxPerBucket: 8 });
  assert.deepEqual(cfg.index, { batch: 15, maxNotes: 2000 });
  // The shipped file carries the same sections.
  const shipped = parseConfig(JSON.parse(readFileSync(new URL("../../brain.config.json", import.meta.url), "utf8")));
  assert.deepEqual(shipped.reminders.rules, cfg.reminders.rules);
  assert.deepEqual(shipped.chat, cfg.chat);
});

test("parseConfig rejects duplicate rule ids, the reserved default id and bad offsets", () => {
  const rules = (r: unknown[]) => () => parseConfig({ reminders: { rules: r } });
  assert.throws(rules([{ id: "a", offsets: ["1h"] }, { id: "a", offsets: ["2h"] }]), /duplicate/);
  assert.throws(rules([{ id: "default", offsets: ["1h"] }]), /default/);
  assert.throws(rules([{ id: "a", offsets: ["7x"] }]), /offset/);
  assert.throws(() => parseConfig({ tasks: { rolloverLocalTime: "3am" } }), /HH:MM/);
});

test("parseConfig lower-cases rule keywords and clamps chat/index bounds", () => {
  const cfg = parseConfig({
    reminders: { rules: [{ id: "trip", offsets: [], keywords: ["Flight", "AIR India"] }] },
    chat: { memory: { verbatimChars: 5 }, context: { notesChars: 1 } },
    index: { batch: 0, maxNotes: -3 },
  });
  assert.deepEqual(cfg.reminders.rules[0]!.keywords, ["flight", "air india"]);
  assert.equal(cfg.chat.memory.verbatimChars, 200);
  assert.equal(cfg.chat.context.notesChars, 200);
  assert.equal(cfg.index.batch, 1);
  assert.equal(cfg.index.maxNotes, 1);
});

test("chat.transcript defaults to the private 'summary'; only 'full' or 'summary' are accepted", () => {
  assert.equal(parseConfig({}).chat.transcript, "summary");
  assert.equal(parseConfig({ chat: { transcript: "full" } }).chat.transcript, "full");
  assert.equal(parseConfig({ chat: { transcript: "everything" } }).chat.transcript, "summary");
});

test("v3 config: defaults, shipped file, and loud rejections", () => {
  const cfg = parseConfig({});
  assert.equal(cfg.channels.defaultChannel, "telegram");
  assert.equal(cfg.chat.engine, "v3"); // the shipped default since go-live on 2026-09-21; "legacy" remains the rollback value
  assert.equal(cfg.chat.dialogTtlMin, 10);
  assert.equal(cfg.chat.llmBudgetMs, 9000);
  assert.equal(cfg.chat.perAttemptMs, 4000);
  assert.equal(cfg.chat.traceRetainDays, 14);
  assert.deepEqual(cfg.brain.dailyBudget, { groq: 900, openrouter: 45 });
  const groq = cfg.brain.entries.find((e) => e.name === "groq")!;
  assert.equal(groq.jsonMode, true);
  assert.equal("extraBody" in groq, false);

  const shipped = parseConfig(JSON.parse(readFileSync(new URL("../../brain.config.json", import.meta.url), "utf8")));
  assert.equal(shipped.channels.defaultChannel, "telegram");
  // 2026-09-21: the account has credit, so free models allow 1000/day; the paid answer-writing model is capped separately.
  assert.deepEqual(shipped.brain.dailyBudget, { groq: 900, openrouter: 900, "openrouter-paid": 400 });
  const paid = shipped.brain.entries.find((e) => e.name === "openrouter-paid")!;
  assert.deepEqual(paid.purposes, ["compose", "summary"]); // never used for planning or background jobs
  assert.equal(shipped.brain.entries.find((e) => e.name === "groq")!.jsonMode, true);

  const ok = parseConfig({
    channels: { defaultChannel: "whatsapp" },
    chat: { engine: "v3", dialogTtlMin: 500, llmBudgetMs: 5000, perAttemptMs: 5000 },
    brain: {
      dailyBudget: { groq: 0 },
      entries: [{ kind: "groq", name: "groq", baseUrl: "https://x/v1", models: ["m"], jsonMode: false, extraBody: { m: { reasoning_effort: "none" } } }],
    },
  });
  assert.equal(ok.channels.defaultChannel, "whatsapp");
  assert.equal(ok.chat.engine, "v3");
  assert.equal(ok.chat.dialogTtlMin, 120); // clamped
  assert.deepEqual(ok.brain.dailyBudget, { groq: 0, openrouter: 45 }); // merged over the defaults
  assert.equal(ok.brain.entries[0]!.jsonMode, false);
  assert.deepEqual(ok.brain.entries[0]!.extraBody, { m: { reasoning_effort: "none" } });

  assert.throws(() => parseConfig({ channels: { defaultChannel: "sms" } }), /defaultChannel/);
  assert.throws(() => parseConfig({ chat: { perAttemptMs: 5000, llmBudgetMs: 4000 } }), /perAttemptMs/);
  assert.throws(() => parseConfig({ chat: { perAttemptMs: 10_000 } }), /perAttemptMs/); // > default 9000 budget
  assert.throws(() => parseConfig({ brain: { dailyBudget: { groq: -1 } } }), /dailyBudget/);
  assert.throws(() => parseConfig({ brain: { dailyBudget: { groq: 1.5 } } }), /dailyBudget/);
  assert.throws(() => parseConfig({ chat: { engine: "v4" } }), /engine/);
  assert.throws(() => parseConfig({ brain: { entries: [{ kind: "groq", name: "g", baseUrl: "https://x", models: ["m"], extraBody: [1] }] } }), /extraBody/);
  const low = parseConfig({ chat: { llmBudgetMs: 10, perAttemptMs: 10 } }).chat;
  assert.deepEqual([low.llmBudgetMs, low.perAttemptMs], [2000, 1000]); // clamped to the floors
});
