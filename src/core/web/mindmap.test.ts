import assert from "node:assert/strict";
import { test } from "node:test";
import { renderMindmap } from "./mindmap.ts";

const snap = {
  deadlines: [
    { title: "Zeta", category: "work", dueAt: "2026-10-02" },
    { title: "Alpha", category: "work", dueAt: "2026-10-02" },
    { title: "Rent", category: "money", dueAt: "2026-10-01" },
    { title: "Loose", dueAt: "2026-11-01" },
  ],
  tasks: [{ title: "b task", status: "open" }, { title: "a task", status: "open" }, { title: "old", status: "done" }],
  notes: ["Zed", "Apple"],
};

test("PLAN 30: byte-identical, sorted", () => {
  const expected = [
    "# Brain", "", "## Deadlines", "",
    "### money", "", "- Rent (due 2026-10-01)", "",
    "### uncategorized", "", "- Loose (due 2026-11-01)", "",
    "### work", "", "- Alpha (due 2026-10-02)", "- Zeta (due 2026-10-02)", "",
    "## Tasks", "",
    "### done", "", "- old", "",
    "### open", "", "- a task", "- b task", "",
    "## Notes", "", "- Apple", "- Zed", "",
  ].join("\n");
  assert.equal(renderMindmap(snap), expected);
  const shuffled = { deadlines: [...snap.deadlines].reverse(), tasks: [...snap.tasks].reverse(), notes: [...snap.notes].reverse() };
  assert.equal(renderMindmap(shuffled), expected);
});

test("titles are escaped and single-line", () => {
  const out = renderMindmap({
    deadlines: [{ title: "<script>alert(1)</script>\n# hi [x](y)", dueAt: "d" }],
    tasks: [], notes: ["<img onerror=1>"],
  });
  assert.ok(!out.includes("<"));
  assert.ok(!/^# hi/m.test(out));
  assert.ok(out.includes("&lt;script&gt;"));
});
