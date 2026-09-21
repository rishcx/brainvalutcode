import assert from "node:assert/strict";
import { test } from "node:test";
import { FixedClock } from "../clock.ts";
import { MemoryChannel } from "../testing/fakes.ts";
import { testContext } from "../../node/testing/context.ts";
import { localTimeOf } from "../time.ts";
import type { AgentContext, Deadline } from "../types.ts";
import { materialise, materialiseAll, planFires, sweep } from "./engine.ts";
import { digestDaily } from "../jobs/digest.ts";
import { sweepReminders } from "../jobs/reminders.ts";

const TZ = "Asia/Kolkata";
const DUE = "2026-10-01T03:30:00.000Z"; // 09:00 IST

const dl = (over: Partial<Deadline> = {}): Deadline => ({
  id: "gh:milestone:me/a:1", source: "manual", sourceRef: "https://x", title: "Ship v1",
  dueAt: DUE, status: "open", confidence: 1, notePath: "GitHub/repos/me__a.md", ...over,
});

/** Same store/config, later instant: FixedClock cannot advance, so build a sibling context. */
const at = (ctx: AgentContext, iso: string): AgentContext => ({ ...ctx, clock: new FixedClock(iso, TZ) });

function setup(over: Record<string, unknown> = {}, iso = "2026-09-20T04:30:00Z") {
  const ch = new MemoryChannel("telegram");
  const ctx = testContext({ at: iso, channels: [ch], ...over });
  return { ctx, ch };
}

test("2026-10-01 deadline materialises offsets.length rows, none after due, T-3h shifted to 08:00", async () => {
  const { ctx } = setup();
  await ctx.store.upsertDeadline(dl());
  assert.equal(await materialise(ctx, dl()), ctx.config.reminders.offsets.length);
  const rows = await ctx.store.listReminders(dl().id);
  assert.equal(rows.length, 5);
  for (const r of rows) assert.ok(new Date(r.fireAt).getTime() <= new Date(DUE).getTime());
  const t3 = rows.find((r) => r.kind === "3h")!;
  assert.equal(localTimeOf(new Date(t3.fireAt), TZ), "08:00");
  // re-materialising is a no-op on the row count
  await materialise(ctx, dl());
  assert.equal((await ctx.store.listReminders(dl().id)).length, 5);
});

test("late discovery skips stale offsets but T-0 still fires once", async () => {
  const { ctx } = setup({}, "2026-10-01T04:00:00Z"); // 30 minutes after due
  await ctx.store.upsertDeadline(dl());
  await materialise(ctx, dl());
  const kinds = (await ctx.store.listReminders(dl().id)).map((r) => r.kind).sort();
  assert.deepEqual(kinds, ["0", "3h"]); // 7d, 2d, 24h are missed by more than their span
  const late = setup({}, "2026-11-01T00:00:00Z");
  await late.ctx.store.upsertDeadline(dl());
  assert.equal(await materialise(late.ctx, dl()), 1); // only T-0
});

test("proposed deadline materialises nothing until confirmed", async () => {
  const { ctx } = setup();
  const p = dl({ status: "proposed", confidence: 0.9 });
  await ctx.store.upsertDeadline(p);
  assert.equal(await materialise(ctx, p), 0);
  assert.equal((await ctx.store.listReminders(p.id)).length, 0);
  await ctx.store.setDeadlineStatus(p.id, "open");
  assert.equal(await materialise(ctx, (await ctx.store.getDeadline(p.id))!), 5);
});

test("coinciding offsets list the deadline once and mark both rows sent", async () => {
  const { ctx, ch } = setup({ configPatch: { reminders: { offsets: ["3h", "2h"] } } }, "2026-10-01T02:00:00Z");
  await ctx.store.upsertDeadline(dl());
  await materialiseAll(ctx);
  const rows = await ctx.store.listReminders(dl().id);
  assert.equal(rows[0]!.fireAt, rows[1]!.fireAt); // both shifted to 08:00 local
  const now = at(ctx, "2026-10-01T02:35:00Z"); // 08:05 IST
  const r = await sweep({ ...now, channels: [ch] });
  assert.equal(r.sent, 1);
  assert.equal(ch.sent.length, 1);
  assert.equal(ch.sent[0]!.split("Ship v1").length - 1, 1);
  assert.ok((await ctx.store.listReminders(dl().id)).every((x) => x.sentAt !== null));
  assert.deepEqual(JSON.parse((await ctx.store.kvGet("last:list"))!)[0], { k: "d", id: dl().id }); // typed ref: unified done <n> numbering
});

test("identical sweep twice sends once; a batch is one message per channel", async () => {
  const tg = new MemoryChannel("telegram");
  const wa = new MemoryChannel("whatsapp");
  const ctx = testContext({ at: "2026-09-20T04:30:00Z", channels: [tg, wa] });
  await ctx.store.upsertDeadline(dl());
  await ctx.store.upsertDeadline(dl({ id: "gh:milestone:me/a:2", title: "Other" }));
  await materialiseAll(ctx);
  const later = at(ctx, "2026-09-24T04:00:00Z");
  const first = await sweep(later);
  assert.deepEqual(first, { sent: 2, channels: ["telegram", "whatsapp"] });
  assert.equal(tg.sent.length, 1);
  assert.match(tg.sent[0]!, /1\. .*\n?.*2\. /s);
  assert.deepEqual(await sweep(later), { sent: 0, channels: [] });
  assert.equal(tg.sent.length, 1);
  assert.equal(wa.sent.length, 1);
});

test("a deadline marked done between materialise and sweep is not announced", async () => {
  const { ctx, ch } = setup();
  await ctx.store.upsertDeadline(dl());
  await materialiseAll(ctx);
  await ctx.store.setDeadlineStatus(dl().id, "done");
  assert.deepEqual(await sweep(at(ctx, "2026-09-24T04:00:00Z")), { sent: 0, channels: [] });
  assert.equal(ch.sent.length, 0);
  await materialiseAll(ctx); // and its unsent rows are cleaned up
  assert.equal((await ctx.store.listReminders(dl().id)).length, 0);
});

test("quiet hours: nothing is delivered before the shifted 08:00 instant", async () => {
  const { ctx, ch } = setup({ configPatch: { reminders: { offsets: ["3h"] } } });
  await ctx.store.upsertDeadline(dl());
  await materialiseAll(ctx);
  assert.equal((await sweep(at(ctx, "2026-10-01T00:30:00Z"))).sent, 0); // 06:00 IST, T-3h raw
  assert.equal((await sweep(at(ctx, "2026-10-01T02:30:00Z"))).sent, 1); // 08:00 IST
  assert.equal(ch.sent.length, 1);
});

test("total send failure leaves rows unsent; partial failure marks them sent", async () => {
  const bad = { id: "telegram" as const, send: async () => { throw new Error("boom"); } };
  const ctx = testContext({ at: "2026-09-20T04:30:00Z", channels: [bad] });
  await ctx.store.upsertDeadline(dl());
  await materialiseAll(ctx);
  const later = at(ctx, "2026-09-24T04:00:00Z");
  await assert.rejects(sweep(later), /boom/);
  assert.equal((await ctx.store.dueReminders(later.clock.now().toISOString())).length, 1);
  const good = new MemoryChannel("whatsapp");
  const r = await sweep({ ...later, channels: [bad, good] });
  assert.deepEqual(r.channels, ["whatsapp"]);
  assert.equal((await ctx.store.dueReminders(later.clock.now().toISOString())).length, 0);
});

test("no channels is a no-op; sweep:reminders reports counts", async () => {
  const ctx = testContext({ at: "2026-09-20T04:30:00Z" });
  await ctx.store.upsertDeadline(dl());
  assert.match(await sweepReminders.run(ctx), /^sent=0 failed=0 targets=none$/);
  assert.deepEqual(await sweep(at(ctx, "2026-09-24T04:00:00Z")), { sent: 0, channels: [] });
});

test("digest narration: brain prose is prepended and model is truthful; deterministic fallback is unchanged", async () => {
  const { fakeFetch } = await import("../testing/fakes.ts");
  const routes = [
    { match: "/user/repos", json: [] },
    { match: "/search/issues", json: { items: [] } },
    { match: "/user", json: { login: "me" } },
  ];
  const plain = testContext({ fetch: fakeFetch(routes) });
  await digestDaily.run(plain);
  const base = await plain.vault.readFile("Digests/2026-09-20.md");
  const brainy = testContext({
    fetch: fakeFetch(routes),
    brain: { complete: async () => ({ text: "Quiet day.\n\nNothing due.", entry: "openrouter", model: "m", cached: false, ms: 1 }) },
  });
  await digestDaily.run(brainy);
  const out = (await brainy.vault.readFile("Digests/2026-09-20.md"))!;
  assert.match(out, /^model: openrouter$/m);
  assert.match(out, /# Digest 2026-09-20\n\nQuiet day\. Nothing due\.\n\n\*\*0 repos/);
  const det = testContext({
    fetch: fakeFetch(routes),
    brain: { complete: async () => ({ text: "x", entry: "deterministic", model: "d", cached: false, ms: 0 }) },
  });
  await digestDaily.run(det);
  assert.equal(await det.vault.readFile("Digests/2026-09-20.md"), base);
});

/* ------------------------------------------------------------------ P1: categories */

const flight = (over: Partial<Deadline> = {}): Deadline =>
  dl({ id: "manual:f", source: "manual", title: "Flight", dueAt: "2026-10-04T12:30:00.000Z", category: "flight", timed: true, ...over });

test("flight deadline: exactly one reminder, T-24h", async () => {
  const { ctx } = setup();
  await ctx.store.upsertDeadline(flight());
  assert.equal(await materialise(ctx, flight()), 1);
  const rows = await ctx.store.listReminders("manual:f");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.kind, "24h");
  assert.equal(rows[0]!.fireAt, "2026-10-03T12:30:00.000Z"); // 18:00 IST
});

test("github milestone, assignment and uncategorised counts; re-materialise is a no-op", async () => {
  const { ctx } = setup();
  const gh = dl({ source: "github" });
  const asg = dl({ id: "manual:a", source: "manual", title: "DBMS assignment" });
  const plain = dl({ id: "manual:p", source: "manual", title: "Renew insurance" });
  for (const d of [gh, asg, plain]) await ctx.store.upsertDeadline(d);
  for (let i = 0; i < 2; i++) {
    assert.equal(await materialise(ctx, gh), 1);
    assert.equal(await materialise(ctx, asg), 1);
    assert.equal(await materialise(ctx, plain), ctx.config.reminders.offsets.length);
  }
  const g = await ctx.store.listReminders(gh.id);
  assert.deepEqual(g.map((r) => [r.kind, r.fireAt]), [["24h", "2026-09-30T03:30:00.000Z"]]);
  const a = await ctx.store.listReminders(asg.id);
  assert.deepEqual(a.map((r) => [r.kind, localTimeOf(new Date(r.fireAt), TZ)]), [["2h", "08:00"]]);
  assert.equal((await ctx.store.listReminders(plain.id)).length, 5);
});

test("invariant: no fireAt after due, for every rule x due time, incl. DST", () => {
  const ctx = testContext();
  const { quietHours, offsets } = ctx.config.reminders;
  const sets = [...ctx.config.reminders.rules.map((r) => r.offsets), offsets, ["0", "1h", "30m"]];
  const dues = ["09:00", "06:30", "05:00", "23:00", "00:30"];
  for (const hhmm of dues) {
    const due = new Date(`2026-10-04T${hhmm}:00+05:30`);
    for (const set of sets) {
      for (const p of planFires(due, set.length ? set : offsets, TZ, quietHours)) {
        assert.ok(p.fireAt.getTime() <= due.getTime(), `${hhmm} ${p.kind}`);
      }
    }
  }
  const ny = "America/New_York";
  for (const iso of ["2026-03-08T06:30:00Z", "2026-03-08T07:30:00Z", "2026-03-08T09:00:00Z", "2026-03-09T03:00:00Z", "2026-03-08T04:00:00Z"]) {
    for (const p of planFires(new Date(iso), ["0", "2h", "24h"], ny, quietHours)) {
      assert.ok(p.fireAt.getTime() <= new Date(iso).getTime(), `${iso} ${p.kind}`);
    }
  }
});

test("category change drops stale unsent kinds but keeps sent rows", async () => {
  const { ctx } = setup();
  const d = dl({ id: "manual:s", source: "manual", title: "Trip", dueAt: "2026-10-04T12:30:00.000Z" });
  await ctx.store.upsertDeadline(d);
  assert.equal(await materialise(ctx, d), 5);
  const sent = (await ctx.store.listReminders(d.id)).find((r) => r.kind === "7d")!;
  await ctx.store.markRemindersSent([sent.id], "2026-09-25T00:00:00Z");
  await materialise(ctx, { ...d, category: "flight" });
  const rows = await ctx.store.listReminders(d.id);
  assert.deepEqual(rows.map((r) => r.kind).sort(), ["24h", "7d"]);
  assert.ok(rows.find((r) => r.kind === "7d")!.sentAt !== null);
  assert.equal(rows.find((r) => r.kind === "24h")!.sentAt, null);
});
