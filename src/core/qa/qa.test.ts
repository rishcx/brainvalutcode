import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryVault } from "../testing/fakes.ts";
import { testContext } from "../../node/testing/context.ts";
import { ask } from "./ask.ts";
import { retrieve } from "./retrieve.ts";

const vault = () =>
  new MemoryVault({
    "notes/passport.md": "---\ntags: travel\n---\n# Passport renewal\nThe passport renewal appointment is booked for March.\n",
    "notes/recipes.md": "# Recipes\nPasta with tomato sauce and basil.\n",
    "notes/2026-01-02.md": "Daily log: nothing about documents.\n",
    "readme.txt": "passport passport passport",
  });

test("ranks relevant note first, stable across runs", async () => {
  const ctx = testContext({ vault: vault() });
  const a = await retrieve(ctx, "when is my passport renewal appointment?");
  const b = await retrieve(ctx, "when is my passport renewal appointment?");
  assert.equal(a[0]?.path, "notes/passport.md");
  assert.ok(!a.some((r) => r.path === "notes/recipes.md"));
  assert.deepEqual(a, b);
});

test("excerpt budget respected", async () => {
  const big = new MemoryVault();
  for (let i = 0; i < 20; i++) big.files.set(`n/${i}.md`, `# alpha ${i}\n${"alpha beta gamma ".repeat(200)}`);
  const ctx = testContext({ vault: big, configPatch: { qa: { maxNotes: 5, maxChars: 600 } } });
  const r = await retrieve(ctx, "alpha beta");
  assert.ok(r.length <= 5);
  assert.ok(r.reduce((n, x) => n + x.excerpt.length, 0) <= 600);
});

test("ask degrades to a fact dump with sources", async () => {
  const ctx = testContext({ vault: vault() });
  const r = await ask(ctx, "when is my passport renewal appointment?");
  assert.equal(r.entry, "deterministic");
  assert.deepEqual(r.sources[0], "notes/passport.md");
  assert.ok(r.answer.includes("March"));
});

test("ask with no matches is deterministic and empty of sources", async () => {
  const r = await ask(testContext(), "quantum chromodynamics");
  assert.equal(r.entry, "deterministic");
  assert.deepEqual(r.sources, []);
});
