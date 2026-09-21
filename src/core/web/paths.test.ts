import assert from "node:assert/strict";
import { test } from "node:test";
import { isEditablePath } from "./paths.ts";

test("allowed human paths", () => {
  for (const p of ["Daily/2026-09-21.md", "Deadlines/manual/a b.md", "Notes/x/y.md", "Plans/Q4 (draft).md", "Notes/café.md"]) {
    assert.equal(isEditablePath(p), true, p);
  }
});

test("refused paths", () => {
  const bad = [
    "../x.md", "Daily/../Tasks/i.md", "/Daily/a.md", "Daily\\a.md", ".hidden.md", "Notes/.secret.md",
    "Notes/.git/x.md", ".obsidian/app.md", ".obsidian/x.md", "Notes/a.txt", "Notes/a", "Plans/Proposed/x.md",
    "Deadlines/index.md", "Deadlines/deadlines.json", "Tasks/index.md", "Digests/x.md", "Mindmap/index.md",
    "daily/a.md", "notes/a.md", "Notes/%2e%2e/a.md", "Notes/a%2fb.md", "Notes/a\0.md", "Notes/a‮b.md",
    "Notes/a:b.md", "Notes/a\nb.md", "Notes/" + "a".repeat(300) + ".md", "", "Notes//a.md", "Notes/./a.md",
    "Notes/é.md", // NFD, not NFC-stable
  ];
  for (const p of bad) assert.equal(isEditablePath(p), false, JSON.stringify(p));
  assert.equal(isEditablePath(undefined as unknown as string), false);
});
