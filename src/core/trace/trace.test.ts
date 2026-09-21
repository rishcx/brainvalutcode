import assert from "node:assert/strict";
import { test } from "node:test";
import { testContext } from "../../node/testing/context.ts";
import type { AgentContext } from "../types.ts";
import { beginTrace, finishTrace, instrumentBrain, preview, timed } from "./record.ts";
import { renderTrace } from "./render.ts";
import { handleTraceAdmin } from "./admin.ts";

test("preview: redacts secrets, collapses whitespace, caps at 160 chars", () => {
  assert.equal(preview("a".repeat(200)).length, 160);
  assert.equal(preview("line one\n\n  line   two"), "line one line two");
  assert.ok(!preview("token ghp_1234567890123456789012345678").includes("ghp_"));
});

test("beginTrace/timed/finishTrace: one row per finish, with stage timings", async () => {
  const ctx = testContext({ at: "2026-09-21T10:00:00Z" });
  const d = beginTrace(ctx, { channel: "telegram", peer: "42" }, "inbound", "telegram:1");
  d.route = "fast";
  d.intent = "status";
  await timed(d, "load", async () => {
    await new Promise((r) => setTimeout(r, 1));
  });
  d.replyChars = 12;
  d.replyPreview = preview("Open deadlines (0)");
  await finishTrace(ctx, d, "ok");

  const rows = await ctx.store.listTrace(10);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.route, "fast");
  assert.equal(rows[0]!.intent, "status");
  assert.equal(rows[0]!.delivery, "ok");
  assert.ok(rows[0]!.latencyMs >= 0);
  const stages = JSON.parse(rows[0]!.stagesJson!) as Record<string, number>;
  assert.ok(stages.load >= 0);
});

test("finishTrace: redacts and caps error/toolsJson/replyPreview; never throws when the store fails", async () => {
  const ctx = testContext({ at: "2026-09-21T10:00:00Z" });
  const d = beginTrace(ctx, { channel: "whatsapp", peer: "919900000000" }, "inbound", "wa:1");
  d.toolsJson = JSON.stringify([{ name: "x", ok: true, note: "token ghp_abcdefghijklmnopqrstuvwxyz" }]);
  d.replyPreview = "leaked ghp_abcdefghijklmnopqrstuvwxyz";
  await finishTrace(ctx, d, "ok", `boom ghp_abcdefghijklmnopqrstuvwxyz ${"x".repeat(400)}`);

  const [row] = await ctx.store.listTrace(1);
  assert.ok(!row!.toolsJson!.includes("ghp_"));
  assert.ok(!row!.replyPreview!.includes("ghp_"));
  assert.ok(!row!.error!.includes("ghp_"));
  assert.ok(row!.error!.length <= 300);

  const bad: AgentContext = { ...ctx, store: { ...ctx.store, appendTrace: async () => { throw new Error("db down"); } } };
  const d2 = beginTrace(bad, { channel: "telegram", peer: "1" }, "inbound", null);
  await assert.doesNotReject(finishTrace(bad, d2, "ok"));
});

test("instrumentBrain: counts calls, records model/provider and the llm stage", async () => {
  const ctx = testContext({ at: "2026-09-21T10:00:00Z" });
  const d = beginTrace(ctx, { channel: "telegram", peer: "1" }, "inbound", null);
  const brain = instrumentBrain(
    { complete: async () => ({ text: "hi", entry: "groq", model: "m1", cached: false, ms: 1 }) },
    d,
  );
  await brain.complete({ prompt: "x" });
  assert.equal(d.llmCalls, 1);
  assert.equal(d.model, "m1");
  assert.equal(d.provider, "groq");
  assert.ok(d.stages.llm !== undefined);
});

test("renderTrace: empty says 'No trace yet.'; newest first; one line per row", async () => {
  assert.equal(renderTrace([], "Asia/Kolkata"), "No trace yet.");

  const ctx = testContext({ at: "2026-09-21T10:00:00Z" }); // 15:30 IST
  const d1 = beginTrace(ctx, { channel: "whatsapp", peer: "919900000000" }, "reminder", null);
  d1.route = "reminder";
  d1.intent = "create_reminder";
  d1.replyPreview = preview("Reminder set: call mom, today 15:15.");
  await finishTrace(ctx, d1, "ok");

  const ctx2 = testContext({ at: "2026-09-21T10:00:05Z", store: ctx.store }); // 5s later
  const d2 = beginTrace(ctx2, { channel: "telegram", peer: "42" }, "inbound", "telegram:2");
  d2.route = "fast";
  d2.intent = "status";
  await finishTrace(ctx2, d2, "ok");

  const rows = await ctx.store.listTrace(10);
  const lines = renderTrace(rows, "Asia/Kolkata").split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /^\d\d:\d\d tg fast status ok/); // newest first
  assert.match(lines[1]!, /^\d\d:\d\d wa reminder create_reminder ok .*"Reminder set: call mom/);
});

test("handleTraceAdmin: null for other paths/methods; 403 bad/missing token; 200 JSON rows; n clamped 1..200", async () => {
  const ctx = testContext({ at: "2026-09-21T10:00:00Z" });
  const d = beginTrace(ctx, { channel: "telegram", peer: "1" }, "inbound", null);
  await finishTrace(ctx, d, "ok");
  const req = (path: string, headers: Record<string, string> = {}, method = "GET"): Request =>
    new Request(`https://x${path}`, { method, headers });

  assert.equal(await handleTraceAdmin(req("/other"), ctx, "secret"), null);
  assert.equal(await handleTraceAdmin(req("/admin/trace", {}, "POST"), ctx, "secret"), null);

  const noAuth = await handleTraceAdmin(req("/admin/trace"), ctx, "secret");
  assert.equal(noAuth!.status, 403);
  const wrong = await handleTraceAdmin(req("/admin/trace", { authorization: "Bearer nope" }), ctx, "secret");
  assert.equal(wrong!.status, 403);
  const noToken = await handleTraceAdmin(req("/admin/trace", { authorization: "Bearer secret" }), ctx, undefined);
  assert.equal(noToken!.status, 403);

  const ok = await handleTraceAdmin(req("/admin/trace?n=500", { authorization: "Bearer secret" }), ctx, "secret");
  assert.equal(ok!.status, 200);
  const body = (await ok!.json()) as { rows: unknown[] };
  assert.ok(Array.isArray(body.rows));
  assert.ok(body.rows.length <= 200);
});
