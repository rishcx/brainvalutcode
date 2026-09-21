import assert from "node:assert/strict";
import { createHmac, createHash } from "node:crypto";
import { test } from "node:test";
import { hmacSha256Hex, sha256Hex, timingSafeEqualHex } from "./crypto.ts";

test("sha256Hex matches node:crypto (the cache key must be stable forever)", async () => {
  for (const s of ["", "hello", "unicode: नमस्ते 🧠"]) {
    assert.equal(await sha256Hex(s), createHash("sha256").update(s, "utf8").digest("hex"));
  }
});

test("hmacSha256Hex matches node:crypto for strings and raw bytes", async () => {
  const secret = "app-secret";
  const body = '{"entry": [ {"id":"1"} ]}'; // whitespace a re-serialisation would drop
  assert.equal(await hmacSha256Hex(secret, body), createHmac("sha256", secret).update(body, "utf8").digest("hex"));
  const bytes = new TextEncoder().encode(body);
  assert.equal(await hmacSha256Hex(secret, bytes), createHmac("sha256", secret).update(bytes).digest("hex"));
  // The signature must depend on the exact raw bytes: re-serialised JSON will not verify.
  assert.notEqual(await hmacSha256Hex(secret, body), await hmacSha256Hex(secret, JSON.stringify(JSON.parse(body))));
});

test("timingSafeEqualHex is case-insensitive, length-safe and rejects near misses", () => {
  const a = "a".repeat(64);
  assert.equal(timingSafeEqualHex(a, a.toUpperCase()), true);
  assert.equal(timingSafeEqualHex(` ${a}\n`, a), true);
  assert.equal(timingSafeEqualHex(a, a.slice(0, 63)), false); // prefix, differing length
  assert.equal(timingSafeEqualHex(a, a.slice(0, 63) + "b"), false); // last char only
  assert.equal(timingSafeEqualHex("", ""), true);
  assert.equal(timingSafeEqualHex("", a), false);
});
