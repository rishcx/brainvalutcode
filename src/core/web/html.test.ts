import assert from "node:assert/strict";
import { test } from "node:test";
import { conflictPage, editorPage, esc, listPage, SECURITY_HEADERS } from "./html.ts";

test("esc handles all five characters", () => {
  assert.equal(esc(`&<>"'`), "&amp;&lt;&gt;&quot;&#39;");
});

test("pages escape dynamic values and carry security headers", async () => {
  const evil = `</textarea><script>alert(1)</script>"><img onerror=1>`;
  for (const r of [
    editorPage({ path: "Notes/a.md", sha: "", csrf: "c", content: evil, saved: false }),
    conflictPage("Notes/a.md", evil),
    listPage([`Notes/${evil}.md`], "c"),
  ]) {
    const h = await r.text();
    assert.ok(!h.includes("<script>") && !h.includes("<img") && !h.includes("</textarea><script"), h);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) assert.equal(r.headers.get(k), v);
  }
  assert.ok(!(await editorPage({ path: "a", sha: "", csrf: "c", content: "", saved: false }).text()).includes("<script"));
});
