import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createShimServer } from "./agy-shim.ts";

async function withShim(script: string, fn: (base: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "fake-agy-"));
  const bin = join(dir, "agy");
  await writeFile(bin, `#!/bin/sh\n${script}\n`);
  await chmod(bin, 0o755);
  const server = createShimServer({ agyBin: bin, timeoutMs: 10_000 });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const post = (base: string, body: unknown) =>
  fetch(`${base}/v1/chat/completions`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const req = { model: "m", messages: [{ role: "user", content: "hi; rm -rf /" }] };

test("valid agy output yields OpenAI-shaped 200", async () => {
  await withShim(`echo '{"result":"pong"}'`, async (base) => {
    const res = await post(base, req);
    assert.equal(res.status, 200);
    const j = (await res.json()) as { choices: { message: { content: string } }[] };
    assert.equal(j.choices[0]!.message.content, "pong");
    assert.equal((await fetch(`${base}/health`)).status, 200);
  });
});

test("garbage agy output yields 502", async () => {
  await withShim(`echo 'not json at all'`, async (base) => {
    const res = await post(base, req);
    assert.equal(res.status, 502);
    assert.ok(((await res.json()) as { error: { message: string } }).error.message);
  });
});

test("json schema is passed by file path", async () => {
  await withShim(`for a in "$@"; do if [ "$p" = "--json-schema" ]; then cat "$a" >/dev/null || exit 3; fi; p="$a"; done; echo '{"result":"{}"}'`, async (base) => {
    const res = await post(base, { ...req, response_format: { type: "json_schema", json_schema: { name: "out", schema: { type: "object" } } } });
    assert.equal(res.status, 200);
  });
});
