import { hmacSha256Hex, timingSafeEqualHex } from "../crypto.ts";
import { HOUR } from "../time.ts";
import type { AgentContext, Channel, InboundMessage, WebhookAdapter } from "../types.ts";
import { chunk } from "./format.ts";

// Meta retires Graph versions after ~2 years; override with WHATSAPP_GRAPH_VERSION (e.g. "v23.0") without a code change.
const DEFAULT_GRAPH_VERSION = "v21.0";
const lastInboundKey = (id: string): string => `wa:lastInbound:${id}`;

export class WhatsappChannel implements Channel {
  readonly id = "whatsapp" as const;
  private readonly ctx: AgentContext;
  constructor(ctx: AgentContext) {
    this.ctx = ctx;
  }

  private async post(phoneId: string, token: string, body: unknown): Promise<void> {
    const res = await this.ctx.fetch(`https://graph.facebook.com/${this.ctx.env("WHATSAPP_GRAPH_VERSION") ?? DEFAULT_GRAPH_VERSION}/${phoneId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      // Meta's own explanation ("(#132001) Template name does not exist in the translation") is what makes this fixable.
      let why = "";
      try {
        const e = ((await res.json()) as { error?: { code?: number; message?: string; error_data?: { details?: string } } }).error;
        why = e ? `: (#${e.code}) ${e.error_data?.details ?? e.message ?? ""}`.slice(0, 300) : "";
      } catch {
        /* non-JSON body: status alone */
      }
      throw new Error(`whatsapp messages HTTP ${res.status}${why}`);
    }
  }

  /** v3: send to one allowlisted peer only. Window/template logic lives here; send() loops it over the allowlist. */
  async sendTo(peer: string, text: string): Promise<void> {
    const { allowedWaIds, templateName, templateLanguage } = this.ctx.config.channels.whatsapp;
    if (!allowedWaIds.map(String).includes(peer)) throw new Error("whatsapp: not allowlisted");
    const token = this.ctx.env("WHATSAPP_TOKEN");
    const phoneId = this.ctx.env("WHATSAPP_PHONE_ID");
    if (!token || !phoneId) throw new Error("whatsapp: WHATSAPP_TOKEN / WHATSAPP_PHONE_ID not set");
    const now = this.ctx.clock.now().getTime();
    const last = await this.ctx.store.kvGet(lastInboundKey(peer));
    const age = last ? now - new Date(last).getTime() : Number.POSITIVE_INFINITY;
    if (age >= 0 && age < 24 * HOUR) {
      for (const part of chunk(text)) {
        await this.post(phoneId, token, { messaging_product: "whatsapp", to: peer, type: "text", text: { body: part } });
      }
    } else {
      // Outside the 24h customer-service window only an approved template may be sent.
      // Template variables cannot hold newlines, so collapse and cap the summary.
      const summary = text.replace(/\s+/g, " ").trim().slice(0, 1000);
      await this.post(phoneId, token, {
        messaging_product: "whatsapp",
        to: peer,
        type: "template",
        template: {
          name: templateName,
          language: { code: templateLanguage },
          components: [{ type: "body", parameters: [{ type: "text", text: summary }] }],
        },
      });
    }
  }

  /** No typing indicator is sent over the WhatsApp Cloud API; best-effort no-op. */
  async typing(_peer?: string): Promise<void> {
    /* no-op */
  }

  /** Loops sendTo over the allowlist: every allowed number gets the digest. */
  async send(text: string): Promise<void> {
    const { allowedWaIds } = this.ctx.config.channels.whatsapp;
    if (allowedWaIds.length === 0) throw new Error("whatsapp: no allowedWaIds configured");
    let delivered = 0;
    let failure = "";
    for (const to of allowedWaIds) {
      try {
        await this.sendTo(String(to), text);
        delivered++;
      } catch (e) {
        failure = e instanceof Error ? e.message : "send failed";
      }
    }
    if (delivered === 0) throw new Error(failure || "whatsapp: send failed");
  }
}

export function whatsappVerifyChallenge(url: URL, ctx: AgentContext): string | null {
  const expected = ctx.env("WHATSAPP_VERIFY_TOKEN");
  const p = url.searchParams;
  const challenge = p.get("hub.challenge");
  const token = p.get("hub.verify_token");
  if (p.get("hub.mode") !== "subscribe" || !expected || token === null || challenge === null) return null;
  // Synchronous API, so compare with the same length-folding XOR loop rather than hashing.
  let diff = expected.length ^ token.length;
  for (let i = 0; i < Math.max(expected.length, token.length); i++) {
    diff |= (expected.charCodeAt(i) | 0) ^ (token.charCodeAt(i) | 0);
  }
  return diff === 0 ? challenge : null;
}

const SIG_RE = /^sha256=([0-9a-fA-F]{64})$/;

export const whatsappWebhook: WebhookAdapter = {
  async verify(req, rawBody, ctx) {
    const secret = ctx.env("WHATSAPP_APP_SECRET");
    const m = SIG_RE.exec(req.headers.get("X-Hub-Signature-256") ?? "");
    if (!secret || !m) return false;
    // Over the raw body exactly as received, never a re-serialised object.
    return timingSafeEqualHex(await hmacSha256Hex(secret, rawBody), m[1]!);
  },

  async parse(rawBody, ctx) {
    let root: unknown;
    try {
      root = JSON.parse(rawBody);
    } catch {
      return [];
    }
    const out: InboundMessage[] = [];
    const allowed = new Set(ctx.config.channels.whatsapp.allowedWaIds.map(String));
    const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
    for (const e of arr((root as { entry?: unknown } | null)?.entry)) {
      for (const c of arr((e as { changes?: unknown } | null)?.changes)) {
        for (const raw of arr((c as { value?: { messages?: unknown } } | null)?.value?.messages)) {
          const m = raw as { id?: unknown; from?: unknown; type?: unknown; timestamp?: unknown; text?: { body?: unknown } } | null;
          if (!m || m.type !== "text" || typeof m.id !== "string" || typeof m.from !== "string") continue;
          if (typeof m.text?.body !== "string" || !allowed.has(m.from)) continue;
          const ts = Number(m.timestamp);
          const now = ctx.clock.now();
          const at = Number.isFinite(ts) && ts > 0 ? new Date(Math.min(ts * 1000, now.getTime())) : now;
          out.push({ channel: "whatsapp", id: m.id, from: m.from, text: m.text.body, at: at.toISOString() });
          // Opens the 24h free-form window; written only after the allowlist check.
          await ctx.store.kvSet(lastInboundKey(m.from), at.toISOString(), now.toISOString());
        }
      }
    }
    return out;
  },
};
