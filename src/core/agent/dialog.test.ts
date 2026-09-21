import assert from "node:assert/strict";
import { test } from "node:test";
import { testContext } from "../../node/testing/context.ts";
import { localDateOf, localTimeOf } from "../time.ts";
import { loadDialog, normWhen, pureTimeAnswer, question, resolveWhen, saveDialog } from "./dialog.ts";

const TZ = "Asia/Kolkata";
const NOW = new Date("2026-09-21T09:35:00Z"); // 15:05 IST, Monday
const local = (iso: string): string => `${localDateOf(new Date(iso), TZ)} ${localTimeOf(new Date(iso), TZ)}`;

test("pureTimeAnswer accepts only a whole-message time phrase", () => {
  assert.equal(local(pureTimeAnswer("in 10 minutes", TZ, NOW)!.dueAt), "2026-09-21 15:15");
  assert.equal(local(pureTimeAnswer("6pm", TZ, NOW)!.dueAt), "2026-09-21 18:00");
  assert.equal(local(pureTimeAnswer("ok at 6", TZ, NOW)!.dueAt), "2026-09-21 18:00");
  assert.equal(local(pureTimeAnswer("6", TZ, NOW)!.dueAt), "2026-09-21 18:00");
  assert.equal(local(pureTimeAnswer("tomorrow 9am", TZ, NOW)!.dueAt), "2026-09-22 09:00");
  assert.equal(local(pureTimeAnswer("kal subah 9 baje", TZ, NOW)!.dueAt), "2026-09-22 09:00");
  assert.equal(local(pureTimeAnswer("10 min baad", TZ, NOW)!.dueAt), "2026-09-21 15:15");
  assert.equal(local(pureTimeAnswer("6:30pm please", TZ, NOW)!.dueAt), "2026-09-21 18:30");
  for (const t of ["call mom", "call mom at 6", "what's due tomorrow?", "ok", "no, make it 7pm to call dad"]) {
    assert.equal(pureTimeAnswer(t, TZ, NOW), null, t);
  }
});

test("resolveWhen: Hinglish/shorthand, date-only uses dueHourLocal, ambiguous hour -> next future", () => {
  assert.equal(normWhen("shaam ko 6 baje"), "evening at 6");
  assert.equal(local(resolveWhen("shaam ko 6 baje", TZ, NOW, 9)!.dueAt), "2026-09-21 18:00");
  assert.equal(local(resolveWhen("tmrw 5pm", TZ, NOW, 9)!.dueAt), "2026-09-22 17:00");
  const d = resolveWhen("tomorrow", TZ, NOW, 9)!;
  assert.equal(local(d.dueAt), "2026-09-22 09:00");
  assert.equal(d.timed, false);
  assert.equal(local(resolveWhen("at 6", TZ, new Date("2026-09-20T23:30:00Z"), 9)!.dueAt), "2026-09-21 06:00"); // 05:00 IST -> 06:00
  assert.equal(local(resolveWhen("in 2 days at 5pm", TZ, NOW, 9)!.dueAt), "2026-09-23 17:00");
  assert.equal(resolveWhen("later", TZ, NOW, 9), null);
});

test("questions are code templates", () => {
  assert.equal(question("what", {}), "What should I remind you about?");
  assert.match(question("when", { what: "call mom" }), /^When should I remind you to call mom\? For example/);
  assert.equal(question("which", { candidates: [{ title: "a" }, { title: "b" }] }), "Which one? 1. a  2. b");
});

test("save/load with CAS and expiry", async () => {
  const ctx = testContext({ at: NOW.toISOString() });
  const who = { channel: "telegram" as const, peer: "1" };
  const draft = { intent: "create_reminder", slots: {}, missing: ["what"], asked: "what", sources: ["set a reminder"], lastAction: null, questions: 1 };
  assert.ok(await saveDialog(ctx, who, null, draft));
  const d = await loadDialog(ctx, who);
  assert.equal(d?.intent, "create_reminder");
  assert.ok(await saveDialog(ctx, who, d, { ...draft, questions: 2 }));
  // stale version: retried once against the fresh row
  assert.ok(await saveDialog(ctx, who, d, { ...draft, questions: 3 }));
  assert.equal((await loadDialog(ctx, who))?.questions, 3);
  const later = testContext({ at: new Date(NOW.getTime() + 11 * 60_000).toISOString(), store: ctx.store });
  assert.equal(await loadDialog(later, who), null);
});
