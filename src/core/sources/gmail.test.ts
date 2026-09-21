import assert from "node:assert/strict";
import { test } from "node:test";
import { testContext } from "../../node/testing/context.ts";
import { fakeFetch } from "../testing/fakes.ts";
import type { GmailMessage } from "../types.ts";
import { fetchGmail, gmailAccessToken, gmailToLlmPayload } from "./gmail.ts";
import { redact } from "./redact.ts";

const env = (n: string): string | undefined =>
  ({ GMAIL_CLIENT_ID: "cid", GMAIL_CLIENT_SECRET: "sec", GMAIL_REFRESH_TOKEN: "rt-secret-value" })[n];

test("redact removes codes, long digits, secrets, url params; idempotent", () => {
  assert.doesNotMatch(redact("your code is 483920"), /\d{4}/);
  assert.doesNotMatch(redact("483920 is your verification code"), /\d{4}/);
  assert.doesNotMatch(redact("OTP: 8391"), /8391/);
  assert.doesNotMatch(redact("acct 123456789012 ok"), /\d{5}/);
  assert.doesNotMatch(redact("key sk-live_abcdef123456 here"), /sk-live/);
  assert.doesNotMatch(redact("ghp_abcdefghij1234"), /ghp_abc/);
  assert.doesNotMatch(redact("Authorization: Bearer abc.def-ghi"), /abc\.def/);
  const u = redact("go https://example.com/verify?token=SECRETVAL&x=1");
  assert.match(u, /example\.com/);
  assert.doesNotMatch(u, /SECRETVAL/);
  for (const x of ["your code is 483920", "https://a.com/?code=zz9&key=k", "sk-live_abcdef123456 12345678", "plain text"]) {
    assert.equal(redact(redact(x)), redact(x));
  }
  assert.equal(redact(""), "");
  assert.equal(redact("Renewal due 2026-10-01"), "Renewal due 2026-10-01");
});

const msg = (o: Partial<GmailMessage> = {}): GmailMessage => ({
  id: "m1", threadId: "t1", subject: "Bill code is 483920", from: "a@b.com <a@b.com>",
  date: "Mon, 1 Sep 2026", snippet: "pin 991122 ref 123456789", labelIds: [], internalDate: "1",
  ...o,
});

test("gmailToLlmPayload has exactly four redacted keys; bodies never appear", () => {
  const raw = { ...msg(), body: "SECRETBODY", payload: { parts: [{ body: { data: "QUJDREVGR0hJSktMTU5PUFFSU1RVVldY" } }] } };
  const p = gmailToLlmPayload(raw as GmailMessage);
  assert.deepEqual(Object.keys(p).sort(), ["date", "from", "snippet", "subject"]);
  const s = JSON.stringify(p);
  assert.doesNotMatch(s, /483920|991122|123456789|SECRETBODY|QUJDREVG/);
});

test("fetchGmail requests format=metadata only and maps headers", async () => {
  const f = fakeFetch([
    { match: "oauth2.googleapis.com/token", json: { access_token: "at", expires_in: 3600 } },
    { match: /messages\?q=/, json: { messages: [{ id: "a" }, { id: "b" }] } },
    {
      match: /messages\/a\?/,
      json: { id: "a", threadId: "ta", snippet: "s", internalDate: "5", payload: { headers: [{ name: "SUBJECT", value: "Hi" }, { name: "from", value: "x" }] } },
    },
    { match: /messages\/b\?/, json: { id: "b", threadId: "tb", payload: { headers: [] } } },
  ]);
  const ctx = testContext({ fetch: f, env, configPatch: { gmail: { enabled: true } } });
  const ms = await fetchGmail(ctx);
  assert.equal(ms.length, 2);
  assert.equal(ms[0]!.subject, "Hi");
  assert.equal(ms[1]!.subject, "");
  const msgCalls = f.calls.filter((c) => /messages\/[ab]\?/.test(c.url));
  assert.equal(msgCalls.length, 2);
  for (const c of f.calls) assert.doesNotMatch(c.url, /format=(full|raw)/);
  for (const c of msgCalls) assert.match(c.url, /format=metadata/);
  // token is cached: a second fetch does not hit the token endpoint again
  await gmailAccessToken(ctx);
  assert.equal(f.calls.filter((c) => c.url.includes("oauth2")).length, 1);
});

test("fetchGmail disabled makes zero fetch calls", async () => {
  const f = fakeFetch([]);
  const ctx = testContext({ fetch: f, env });
  assert.deepEqual(await fetchGmail(ctx), []);
  assert.equal(f.calls.length, 0);
});

test("missing GMAIL_REFRESH_TOKEN names the variable, not a value", async () => {
  const ctx = testContext({ env: (n) => (n === "GMAIL_REFRESH_TOKEN" ? undefined : "leaky-value") });
  await assert.rejects(gmailAccessToken(ctx), (e: Error) => {
    assert.match(e.message, /GMAIL_REFRESH_TOKEN/);
    assert.doesNotMatch(e.message, /leaky-value/);
    return true;
  });
});
