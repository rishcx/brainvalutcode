import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FsWriter } from "./fs.ts";

test("FsWriter.listFiles accepts a trailing-slash prefix, skips dot dirs, and refuses escapes", async () => {
  const root = mkdtempSync(join(tmpdir(), "fsw-"));
  mkdirSync(join(root, "Deadlines/manual"), { recursive: true });
  mkdirSync(join(root, ".obsidian"));
  writeFileSync(join(root, "Deadlines/manual/rent.md"), "x");
  writeFileSync(join(root, ".obsidian/app.json"), "{}");
  const w = new FsWriter(root);
  assert.deepEqual(await w.listFiles("Deadlines/manual/"), ["Deadlines/manual/rent.md"]);
  assert.deepEqual(await w.listFiles("Deadlines/manual"), ["Deadlines/manual/rent.md"]);
  assert.deepEqual(await w.listFiles(""), ["Deadlines/manual/rent.md"]);
  assert.deepEqual(await w.listFiles("Nope/"), []);
  await assert.rejects(w.listFiles("../"), /unsafe|outside/);
  await assert.rejects(w.readFile("../../etc/passwd"), /unsafe|outside/);
});
