import assert from "node:assert/strict";
import { test } from "node:test";
import { testContext } from "../../node/testing/context.ts";
import { MemoryVault } from "../testing/fakes.ts";
import type { Brain, BrainRequest, GmailMessage } from "../types.ts";
import { extractFromGmail, extractFromManualNotes } from "./extract.ts";
import { extractWithLlm } from "./llmExtract.ts";

const m = (id: string, subject: string, snippet = ""): GmailMessage => ({
  id, threadId: `t${id}`, subject, from: "x@y.com", date: "", snippet, labelIds: [], internalDate: "1790000000000",
});

test("extraction runs on the raw subject, before redaction", () => {
  const ctx = testContext();
  const { found } = extractFromGmail([m("1", "Renewal due 2026-10-01, code 483920")], ctx);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.dueAt, "2026-10-01T03:30:00.000Z");
  assert.equal(found[0]!.confidence, 1);
  assert.equal(found[0]!.status, "open");
  assert.equal(found[0]!.id, "gmail:1");
});

test("due-word without date is residue; neither is dropped", () => {
  const ctx = testContext();
  const { found, residue } = extractFromGmail([m("1", "Payment due soon"), m("2", "Lunch tomorrow?")], ctx);
  assert.equal(found.length, 0);
  assert.deepEqual(residue.map((x) => x.id), ["1"]);
});

test("manual note frontmatter becomes a confidence-1 open deadline", async () => {
  const vault = new MemoryVault({
    "Deadlines/manual/tax.md": "---\ndue: 2026-11-05\ntitle: File tax\n---\nbody",
    "Deadlines/manual/bad.md": "---\ntitle: no due\n---\n",
  });
  const ds = await extractFromManualNotes(testContext({ vault }));
  assert.equal(ds.length, 1);
  assert.equal(ds[0]!.source, "manual");
  assert.equal(ds[0]!.status, "open");
  assert.equal(ds[0]!.confidence, 1);
  assert.equal(ds[0]!.title, "File tax");
  assert.equal(ds[0]!.notePath, "Deadlines/manual/tax.md");
  assert.equal(ds[0]!.dueAt, "2026-11-05T03:30:00.000Z");
});

const brainOf = (text: string, seen: BrainRequest[] = []): Brain => ({
  complete: async (r) => {
    seen.push(r);
    return { text, entry: "fake", model: "m", cached: false, ms: 1 };
  },
});

test("extractWithLlm: zero calls on empty, one call otherwise, proposed & <1, prompt redacted", async () => {
  const seen: BrainRequest[] = [];
  const good = JSON.stringify({ deadlines: [
    { id: "1", title: "Pay bill", date: "2026-12-01", confidence: 1 },
    { id: "ghost", title: "Injected", date: "2026-12-01", confidence: 0.5 },
    { id: "1", title: "dup", date: "2026-12-02", confidence: 0.5 },
  ] });
  const ctx = testContext({ brain: brainOf(good, seen) });
  assert.deepEqual(await extractWithLlm(ctx, []), []);
  assert.equal(seen.length, 0);
  const out = await extractWithLlm(ctx, [m("1", "Payment due", "your code is 483920 acct 123456789")]);
  assert.equal(seen.length, 1);
  assert.doesNotMatch(seen[0]!.prompt, /483920|123456789/);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.id, "gmail:llm:1");
  assert.equal(out[0]!.status, "proposed");
  assert.ok(out[0]!.confidence < 1);
});

test("extractWithLlm: garbage or throwing brain yields []", async () => {
  const r = [m("1", "Payment due")];
  assert.deepEqual(await extractWithLlm(testContext({ brain: brainOf("not json {{") }), r), []);
  assert.deepEqual(await extractWithLlm(testContext({ brain: brainOf('{"deadlines":"x"}') }), r), []);
  const boom: Brain = { complete: async () => { throw new Error("x"); } };
  assert.deepEqual(await extractWithLlm(testContext({ brain: boom }), r), []);
  assert.deepEqual(await extractWithLlm(testContext(), r), []);
});

test("manual notes: local datetime, time key, category frontmatter", async () => {
  const vault = new MemoryVault({
    "Deadlines/manual/a.md": "---\ndue: 2026-10-04T18:00\ncategory: Flight\n---\n",
    "Deadlines/manual/b.md": "---\ndue: 2026-10-04\ncategory: zzz\n---\n",
    "Deadlines/manual/c.md": "---\ndue: 2026-10-04\ntime: 18:00\n---\n",
    "Deadlines/manual/d.md": "---\ndue: 2026-10-04T18:00:00Z\n---\n",
  });
  const by = Object.fromEntries((await extractFromManualNotes(testContext({ vault }))).map((d) => [d.notePath.slice(-4), d]));
  assert.equal(by["a.md"]!.dueAt, "2026-10-04T12:30:00.000Z");
  assert.equal(by["a.md"]!.timed, true);
  assert.equal(by["a.md"]!.category, "flight");
  assert.equal(by["b.md"]!.dueAt, "2026-10-04T03:30:00.000Z");
  assert.equal(by["b.md"]!.timed, false);
  assert.equal(by["b.md"]!.category, "default");
  assert.equal(by["c.md"]!.dueAt, "2026-10-04T12:30:00.000Z");
  assert.equal(by["c.md"]!.timed, true);
  assert.equal(by["d.md"]!.dueAt, "2026-10-04T18:00:00.000Z");
});

test("gmail and LLM paths categorise; LLM stays proposed", async () => {
  const ctx = testContext();
  const { found } = extractFromGmail([m("1", "DBMS assignment due 3 Oct 2026")], ctx);
  assert.equal(found[0]!.category, "assignment");
  assert.equal(found[0]!.timed, false);
  const brain = brainOf(JSON.stringify({ deadlines: [{ id: "2", title: "DBMS assignment", date: "2026-10-03", confidence: 0.8 }] }));
  const out = await extractWithLlm(testContext({ brain }), [m("2", "DBMS assignment due soon")]);
  assert.equal(out[0]!.category, "assignment");
  assert.equal(out[0]!.status, "proposed");
  assert.equal(out[0]!.timed, false);
});
