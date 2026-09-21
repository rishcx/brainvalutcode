import assert from "node:assert/strict";
import { test } from "node:test";
import { readCookie, sessionCookieHeader, signSession, verifySession } from "./session.ts";

const S = "s3cret-admin-token";
const NOW = 1_800_000_000;
const NONCE = "0123456789abcdef0123456789abcdef";

test("sign then verify round-trips and yields csrf", async () => {
  const s = await signSession(S, NOW, 3600, NONCE);
  assert.equal(s.expSec, NOW + 3600);
  assert.match(s.cookie, /^v1\.\d+\.[0-9a-f]{32}\.[0-9a-f]{64}$/);
  const v = await verifySession(S, s.cookie, NOW + 10);
  assert.deepEqual(v, { ok: true, csrf: s.csrf, expSec: s.expSec });
  assert.ok(!s.cookie.includes(S) && !s.csrf.includes(S));
});

test("random nonce differs per session", async () => {
  const a = await signSession(S, NOW, 60);
  const b = await signSession(S, NOW, 60);
  assert.notEqual(a.cookie, b.cookie);
});

test("tamper, wrong secret, truncated, wrong version, expired, too far ahead all fail", async () => {
  const s = await signSession(S, NOW, 3600, NONCE);
  const parts = s.cookie.split(".");
  const flip = (c: string) => (c === "0" ? "1" : "0");
  const cases: [string, string | null][] = [
    ["sig tampered", [...parts.slice(0, 3), parts[3]!.slice(0, -1) + flip(parts[3]!.slice(-1))].join(".")],
    ["exp tampered", [parts[0], String(Number(parts[1]) + 1000), parts[2], parts[3]].join(".")],
    ["nonce tampered", [parts[0], parts[1], "f".repeat(32), parts[3]].join(".")],
    ["truncated", s.cookie.slice(0, -10)],
    ["wrong version", "v2." + s.cookie.slice(3)],
    ["null", null],
    ["empty", ""],
    ["garbage", "abc"],
  ];
  for (const [name, c] of cases) assert.deepEqual(await verifySession(S, c, NOW), { ok: false }, name);
  assert.deepEqual(await verifySession("other", s.cookie, NOW), { ok: false }, "wrong secret");
  assert.deepEqual(await verifySession(S, s.cookie, NOW + 3600), { ok: false }, "expired at exp");
  assert.deepEqual(await verifySession(S, s.cookie, NOW + 9999), { ok: false }, "expired");
  // Validly signed but exp too far in the future: forge with a huge ttl bypassing the clamp.
  const far = await signSession(S, NOW + 10_000, 3600, NONCE);
  assert.deepEqual(await verifySession(S, far.cookie, NOW), { ok: false }, "exp - now > 7200");
});

test("ttl is clamped to 7200", async () => {
  assert.equal((await signSession(S, NOW, 999_999)).expSec, NOW + 7200);
});

test("cookie flags and readCookie", () => {
  const h = sessionCookieHeader("v", 3600);
  for (const f of ["__Host-brain_sess=v", "HttpOnly", "Secure", "SameSite=Strict", "Path=/", "Max-Age=3600"]) {
    assert.ok(h.includes(f), f);
  }
  assert.ok(!h.includes("Domain"));
  assert.equal(readCookie("a=1; __Host-brain_sess=abc; b=2", "__Host-brain_sess"), "abc");
  assert.equal(readCookie(null, "x"), null);
  assert.equal(readCookie("xx__Host-brain_sess=abc", "__Host-brain_sess"), null);
});
