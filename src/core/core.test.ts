import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FixedClock } from "./clock.ts";
import { renderDeadlineIndex, renderDeadlineJson } from "./render/deadlines.ts";
import { renderDigest } from "./render/digest.ts";
import { clean, frontmatter, link } from "./render/markdown.ts";
import type { Deadline, GithubSnapshot } from "./types.ts";
import { FsWriter } from "../node/vault/fs.ts";
import { assertWritable } from "./vault/paths.ts";

const dl = (id: string, dueAt: string, status: Deadline["status"] = "open"): Deadline => ({
  id, source: "github", sourceRef: "u", title: id, dueAt, status, confidence: 1, notePath: "GitHub/x.md",
});

const clock = new FixedClock("2026-09-19T00:00:00Z", "Asia/Kolkata");

test("write allowlist accepts agent paths, refuses human/escaping paths", () => {
  for (const ok of ["Digests/2026-09-19.md", "GitHub/repos/a__b.md", "Deadlines/index.md", "Plans/Proposed/w38.md"]) {
    assert.doesNotThrow(() => assertWritable(ok));
  }
  for (const bad of [
    "Daily/2026-09-19.md", "Deadlines/manual/rent.md", "Plans/w38.md", "../x.md", "/etc/x",
    "Digests/../Daily/a.md", "Deadlines/index.md.bak", "Digests/./a.md", "Digests\\a.md", "", "Digests/",
  ]) {
    assert.throws(() => assertWritable(bad), bad);
  }
});

test("FsWriter refuses a batch atomically and skips unchanged files", async () => {
  const w = new FsWriter(mkdtempSync(join(tmpdir(), "vault-")));
  await assert.rejects(w.writeFiles("m", [{ path: "Digests/a.md", content: "x" }, { path: "Daily/a.md", content: "x" }]));
  assert.equal(await w.readFile("Digests/a.md"), null); // nothing written from the rejected batch
  assert.deepEqual(await w.writeFiles("m", [{ path: "Digests/a.md", content: "x" }]), ["Digests/a.md"]);
  assert.deepEqual(await w.writeFiles("m", [{ path: "Digests/a.md", content: "x" }]), []);
});

test("FsWriter reads human notes but cannot escape the vault root", async () => {
  const root = mkdtempSync(join(tmpdir(), "vault-"));
  writeFileSync(join(root, "..", "secret.env"), "KEY=nope");
  mkdirSync(join(root, "Daily"), { recursive: true });
  writeFileSync(join(root, "Daily", "2026-09-19.md"), "human note");
  mkdirSync(join(root, ".obsidian"), { recursive: true });
  writeFileSync(join(root, ".obsidian", "app.json"), "{}");

  const w = new FsWriter(root);
  // Reads are deliberately NOT gated by the write allowlist: this is the Q&A corpus.
  assert.equal(await w.readFile("Daily/2026-09-19.md"), "human note");
  await assert.rejects(w.readFile("../secret.env"), /outside root|unsafe path/);
  await assert.rejects(w.readFile("Daily/../../secret.env"), /unsafe path/);
  assert.deepEqual(await w.listFiles(), ["Daily/2026-09-19.md"]); // dot-dirs excluded
  assert.deepEqual(await w.listFiles("Daily"), ["Daily/2026-09-19.md"]);
  assert.deepEqual(await w.listFiles("Nope"), []);
});

test("deadline index groups by local calendar day and separates proposed items", () => {
  const out = renderDeadlineIndex(
    [
      dl("late", "2026-09-10T00:00:00Z"),
      dl("soon", "2026-09-22T00:00:00Z"),
      dl("far", "2026-12-01T00:00:00Z"),
      dl("gone", "2026-09-20T00:00:00Z", "done"),
      dl("maybe", "2026-09-25T00:00:00Z", "proposed"),
    ],
    clock,
  );
  const sec = (h: string) => out.split("## ").find((s) => s.startsWith(h))!;
  assert.match(sec("Overdue"), /late/);
  assert.match(sec("Next 7 days"), /soon/);
  assert.match(sec("Later"), /far/);
  assert.match(sec("Proposed"), /maybe/);
  assert.doesNotMatch(out, /gone/);
  assert.doesNotMatch(sec("Next 7 days"), /maybe/); // proposed items never sit in the live groups
});

test("renders show the due date as the user's local day, not the UTC day", () => {
  // 20:00Z on the 30th is already the 1st in Asia/Kolkata.
  const d = dl("x", "2026-09-30T20:00:00Z");
  assert.match(renderDeadlineIndex([d], clock), /2026-10-01/);
});

test("renders are byte-stable across two runs on the same local day", () => {
  const gh: GithubSnapshot = {
    login: "me",
    repos: [{
      fullName: "me/a", private: false, defaultBranch: "main", pushedAt: "2026-06-01T00:00:00Z",
      openIssues: 1, openPrs: 0, myOpenPrs: 0, issues: [], prs: [], milestones: [],
    }],
    reviewRequested: [],
    skipped: [],
  };
  const ds = [dl("a", "2026-09-22T00:00:00Z")];
  const morning = new FixedClock("2026-09-19T03:30:00Z", "Asia/Kolkata"); // 09:00 local
  const evening = new FixedClock("2026-09-19T15:30:00Z", "Asia/Kolkata"); // 21:00 local
  assert.equal(renderDigest(gh, ds, morning), renderDigest(gh, ds, evening));
  assert.equal(renderDeadlineIndex(ds, morning), renderDeadlineIndex(ds, evening));
  assert.doesNotMatch(renderDigest(gh, ds, morning), /generated_at/); // no wall clock in the note
  assert.match(renderDigest(gh, ds, morning), /## Quiet for 30\+ days\n- me\/a/);
  assert.equal(renderDeadlineJson(ds), renderDeadlineJson([...ds]));
});

test("clean() neutralises markdown control chars and newlines from external titles", () => {
  assert.equal(clean("a\n[b]|c"), "a \\[b\\]\\|c");
  assert.equal(clean("a\\b"), "a\\\\b");
  assert.equal(clean("`rm -rf`"), "\\`rm -rf\\`");
});

test("frontmatter quotes anything that would break the YAML block", () => {
  assert.equal(frontmatter({ type: "digest", n: 3, ok: true }), "---\ntype: digest\nn: 3\nok: true\n---\n");
  assert.equal(frontmatter({ repo: "me/a" }), "---\nrepo: me/a\n---\n");
  assert.match(frontmatter({ title: "Re: urgent" }), /title: "Re: urgent"/);
  assert.match(frontmatter({ title: 'say "hi"\nnow' }), /title: "say \\"hi\\" now"/);
  assert.equal(frontmatter({ sources: ["github", "gmail"] }), "---\nsources: [github, gmail]\n---\n");
});

test("link() survives URLs that would close the markdown link early", () => {
  assert.equal(link("t", "https://x/a"), "[t](https://x/a)");
  assert.equal(link("t", "https://x/a_(b)"), "[t](<https://x/a_(b)>)");
});

test("core stays portable: no node: imports and no src/node dependency outside tests", async () => {
  // The rule that only breaks at Worker deploy time, enforced at the moment of violation.
  // `types: ["node"]` is global, so `import { createHash } from "node:crypto"` in a core
  // file typechecks and passes tests on Node — and then fails in production.
  const { readdir, readFile } = await import("node:fs/promises");
  const root = new URL("./", import.meta.url);
  const entries = await readdir(root, { withFileTypes: true, recursive: true });
  const offenders: string[] = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".ts") || e.name.endsWith(".test.ts")) continue;
    const rel = join(e.parentPath, e.name);
    const src = await readFile(rel, "utf8");
    // testing/fakes.ts is imported only by tests, but must stay portable anyway.
    if (/\bfrom\s+["']node:/.test(src)) offenders.push(`${rel}: imports node:*`);
    if (/\bfrom\s+["'][^"']*\/node\//.test(src)) offenders.push(`${rel}: imports src/node/*`);
  }
  assert.deepEqual(offenders, []);
});
