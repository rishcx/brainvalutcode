// crypto.subtle only: node:crypto would not survive the move to a Worker.
// ARCHITECT-OWNED: builder packages import from here and never edit this file.

const hex = (buf: ArrayBuffer): string =>
  Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");

/** Cache key for Brain responses. */
export async function sha256Hex(input: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)));
}

/** Webhook signature verification (WhatsApp X-Hub-Signature-256) over the RAW body bytes. */
export async function hmacSha256Hex(secret: string, message: string | Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = typeof message === "string" ? new TextEncoder().encode(message) : message;
  return hex(await crypto.subtle.sign("HMAC", key, bytes as unknown as ArrayBuffer));
}

/**
 * Constant-time-ish comparison of two hex digests. Case-insensitive, no early return:
 * the length difference is folded into the accumulator instead of short-circuiting.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x.charCodeAt(i) | 0) ^ (y.charCodeAt(i) | 0);
  return diff === 0;
}
