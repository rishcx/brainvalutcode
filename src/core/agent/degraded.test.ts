import assert from "node:assert/strict";
import { test } from "node:test";
import { testContext } from "../../node/testing/context.ts";
import { recordCall } from "../brain/usage.ts";
import { localTimeOf } from "../time.ts";
import type { InboundMessage } from "../types.ts";
import { degradedReply } from "./degraded.ts";

const AT = "2026-09-21T08:30:00Z"; // 14:00 IST
const msg = (text: string, id = "1"): InboundMessage => ({ channel: "telegram", id, from: "111", text, at: AT });

test("no-brain: a short honest line with the fast-path commands, no LLM mention of quota", async () => {
  const ctx = testContext({ at: AT });
  const out = await degradedReply(ctx, msg("what is up"), "no-brain");
  assert.match(out, /^No language model is configured\. You can use: tasks, status, done 2, remind me in 10 minutes to <thing>\.$/);
  assert.ok(out.length <= 400);
});

test("unreachable and unparseable both get the same 'try again' line", async () => {
  const ctx = testContext({ at: AT });
  for (const reason of ["unreachable", "unparseable"] as const) {
    const out = await degradedReply(ctx, msg("anything"), reason);
    assert.match(out, /^I couldn't reach my language model just now\. Try again in a minute, or use: tasks, status, done 2, remind me in 10 minutes to <thing>\.$/);
  }
});

test("U5: quota reason states the local reset time from quotaStatus and mentions reminders still fire", async () => {
  const ctx = testContext({
    at: AT,
    env: (n) => (n === "K" ? "key" : undefined),
    configPatch: { brain: { entries: [{ kind: "groq", name: "groq", baseUrl: "https://g.test/v1", keyEnv: "K", models: ["m1"], local: false }] } },
  });
  await recordCall(ctx, "groq", "m1", { ok: false, status: 429, rate: { retryAfterMs: 3_600_000 } }); // 1h from 08:30 UTC = 09:30 UTC = 15:00 IST
  const out = await degradedReply(ctx, msg("what's due"), "quota");
  const expected = localTimeOf(new Date(new Date(AT).getTime() + 3_600_000), ctx.config.timezone);
  assert.match(out, new RegExp(`^My language model is out of free quota until about ${expected}\\.`));
  assert.match(out, /Reminders still fire\. Meanwhile you can use: tasks, status, done 2, snooze 10m, remind me in 10 minutes to <thing>\.$/);
});

test("quota reason with no known reset says 'for a while'", async () => {
  const ctx = testContext({ at: AT }); // no brain entries configured at all with a key => quotaStatus resetAt is null
  const out = await degradedReply(ctx, msg("hello"), "quota");
  assert.match(out, /^My language model is out of free quota for a while\. Reminders still fire\./);
});

test("U6: an explicit 'remind me in 10 minutes to X' still fires offline, with the offline suffix", async () => {
  const ctx = testContext({ at: AT });
  const out = await degradedReply(ctx, msg("remind me in 10 minutes to call mom"), "quota");
  const when = localTimeOf(new Date(new Date(AT).getTime() + 10 * 60_000), ctx.config.timezone);
  assert.equal(out, `Reminder set: call mom, ${when}. (offline mode)`);
  const rows = await ctx.store.listDeadlines({ status: ["open"] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.title, "call mom");
  assert.equal(rows[0]?.id, "chat:1");
});

test("a subject-less explicit reminder asks what, and creates no row", async () => {
  const ctx = testContext({ at: AT });
  const out = await degradedReply(ctx, msg("set a reminder in 10 minutes"), "quota");
  assert.equal(
    out,
    "What should I remind you about? My language model is unavailable, so please say it in one message, e.g. remind me in 10 minutes to call mom.",
  );
  assert.equal((await ctx.store.listDeadlines()).length, 0);
});

test("the old regex task commands still work offline: add task gets the offline suffix, tasks lists as usual", async () => {
  const ctx = testContext({ at: AT });
  const added = await degradedReply(ctx, msg("add task buy milk"), "unreachable");
  assert.match(added, /buy milk/);
  assert.match(added, / \(offline mode\)$/);

  const listed = await degradedReply(ctx, msg("tasks"), "unreachable");
  assert.match(listed, /buy milk/);
  assert.doesNotMatch(listed, /offline mode/); // replyTasks is used as-is, no suffix
});

test("add task never splits into more than one task even when several are named", async () => {
  const ctx = testContext({ at: AT });
  await degradedReply(ctx, msg("add task buy milk and eggs"), "unreachable");
  const view = await (await import("../tasks/service.ts")).listToday(ctx);
  assert.equal(view.open.length, 1);
});

test("never throws: a broken store still returns a plain honest line", async () => {
  const base = testContext({ at: AT });
  const broken = new Proxy(base.store, {
    get(t, k, r) {
      const v = Reflect.get(t, k, r);
      return typeof v === "function"
        ? () => {
            throw new Error("store down");
          }
        : v;
    },
  });
  const out = await degradedReply({ ...base, store: broken }, msg("remind me in 10 minutes to call mom"), "quota");
  assert.equal(typeof out, "string");
  assert.ok(out.length > 0 && out.length <= 400);
});

test("audit 17: offline, 'task list' lists and does not add a task; 'remaind me' still sets a reminder", async () => {
  const ctx = testContext({ at: AT });
  const { listToday } = await import("../tasks/service.ts");
  for (const text of ["task list", "tasks list"]) {
    const out = await degradedReply(ctx, msg(text), "no-brain");
    assert.match(out, /^No tasks for /, text);
    assert.equal((await listToday(ctx)).open.length, 0, `${text} must not create a task`);
  }
  for (const [i, text] of ["remaind me in 10 minutes to call mom", "remnd me in 20 minutes to call dad"].entries()) {
    const out = await degradedReply(ctx, msg(text, `t${i}`), "unreachable");
    assert.match(out, /^Reminder set: call \w+, \d\d:\d\d\. \(offline mode\)$/, text);
  }
});
