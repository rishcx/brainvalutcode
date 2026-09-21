// Signed, expiring session cookie. HMAC key is derived from ADMIN_TOKEN; the token itself is
// never stored in the cookie. No node built-ins: crypto.subtle via ../crypto.ts.
import { hmacSha256Hex, timingSafeEqualHex } from "../crypto.ts";

export const COOKIE_NAME = "__Host-brain_sess";
export const MAX_TTL_SEC = 7200;
const SHAPE = /^v1\.(\d{1,12})\.([0-9a-f]{32})\.([0-9a-f]{64})$/;

const deriveKey = (secret: string): Promise<string> => hmacSha256Hex(secret, "brain-agent/web/v1");

function randomNonce(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function signSession(
  secret: string,
  nowSec: number,
  ttlSec: number,
  nonce: string = randomNonce(),
): Promise<{ cookie: string; csrf: string; expSec: number }> {
  const key = await deriveKey(secret);
  const expSec = Math.floor(nowSec) + Math.min(Math.max(Math.floor(ttlSec), 1), MAX_TTL_SEC);
  const body = `v1.${expSec}.${nonce}`;
  const sig = await hmacSha256Hex(key, body);
  return { cookie: `${body}.${sig}`, csrf: await hmacSha256Hex(key, `csrf|${nonce}`), expSec };
}

export async function verifySession(
  secret: string,
  cookieValue: string | null,
  nowSec: number,
): Promise<{ ok: true; csrf: string; expSec: number } | { ok: false }> {
  if (!cookieValue) return { ok: false };
  const m = SHAPE.exec(cookieValue);
  if (!m) return { ok: false };
  const exp = Number(m[1]);
  if (!Number.isSafeInteger(exp) || exp <= nowSec || exp - nowSec > MAX_TTL_SEC) return { ok: false };
  const key = await deriveKey(secret);
  const want = await hmacSha256Hex(key, `v1.${m[1]}.${m[2]}`);
  if (!timingSafeEqualHex(want, m[3]!)) return { ok: false };
  return { ok: true, csrf: await hmacSha256Hex(key, `csrf|${m[2]}`), expSec: exp };
}

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

const ATTRS = "HttpOnly; Secure; SameSite=Strict; Path=/";
export const sessionCookieHeader = (value: string, maxAge: number): string =>
  `${COOKIE_NAME}=${value}; ${ATTRS}; Max-Age=${maxAge}`;
export const clearCookieHeader = (): string => `${COOKIE_NAME}=; ${ATTRS}; Max-Age=0`;
