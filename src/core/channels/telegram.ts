import { sha256Hex, timingSafeEqualHex } from "../crypto.ts";
import type { AgentContext, Channel, InboundMessage, WebhookAdapter } from "../types.ts";
import { chunk } from "./format.ts";

export class TelegramChannel implements Channel {
  readonly id = "telegram" as const;
  private readonly ctx: AgentContext;
  constructor(ctx: AgentContext) {
    this.ctx = ctx;
  }

  /**
   * Shows "typing..." in the chat while the reply is being prepared. Best effort: never throws.
   * v3: a peer targets just that chat; the legacy no-arg form still pings every allowed chat.
   */
  async typing(peer?: string): Promise<void> {
    const token = this.ctx.env("TELEGRAM_TOKEN");
    if (!token) return;
    const chats = peer !== undefined ? [peer] : this.ctx.config.channels.telegram.allowedChatIds;
    for (const chat of chats) {
      try {
        await this.ctx.fetch(`https://api.telegram.org/bot${token}/sendChatAction`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: chat, action: "typing" }),
          signal: AbortSignal.timeout(3000),
        });
      } catch {
        /* cosmetic only */
      }
    }
  }

  /** v3: send to one allowlisted peer only (replies, reminders). */
  async sendTo(peer: string, text: string): Promise<void> {
    if (!this.ctx.config.channels.telegram.allowedChatIds.map(String).includes(peer)) {
      throw new Error("telegram: not allowlisted");
    }
    const token = this.ctx.env("TELEGRAM_TOKEN");
    if (!token) throw new Error("telegram: TELEGRAM_TOKEN is not set");
    for (const part of chunk(text)) {
      // The URL carries the token: never put it in an error message.
      const res = await this.ctx.fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: peer, text: part }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`telegram sendMessage HTTP ${res.status}`);
    }
  }

  /** Loops sendTo over the allowlist: every allowed chat gets the digest. */
  async send(text: string): Promise<void> {
    if (!this.ctx.env("TELEGRAM_TOKEN")) throw new Error("telegram: TELEGRAM_TOKEN is not set");
    const chats = this.ctx.config.channels.telegram.allowedChatIds;
    if (chats.length === 0) throw new Error("telegram: no allowedChatIds configured");
    let delivered = 0;
    let failure = "";
    for (const chat of chats) {
      try {
        await this.sendTo(String(chat), text);
        delivered++;
      } catch (e) {
        failure = e instanceof Error ? e.message : "send failed";
      }
    }
    if (delivered === 0) throw new Error(failure || "telegram: send failed");
  }
}

export const telegramWebhook: WebhookAdapter = {
  async verify(req, _raw, ctx) {
    const secret = ctx.env("TELEGRAM_WEBHOOK_SECRET");
    const got = req.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (!secret || got === null) return false;
    // Hash both sides so the constant-time compare works for non-hex secrets too.
    return timingSafeEqualHex(await sha256Hex(secret), await sha256Hex(got));
  },

  async parse(rawBody, ctx) {
    let update: unknown;
    try {
      update = JSON.parse(rawBody);
    } catch {
      return [];
    }
    const u = update as { update_id?: unknown; message?: { text?: unknown; date?: unknown; chat?: { id?: unknown } } } | null;
    const m = u?.message;
    if (!m || typeof m.text !== "string" || typeof u?.update_id !== "number") return [];
    const chat = m.chat?.id;
    if (typeof chat !== "number" && typeof chat !== "string") return [];
    const from = String(chat);
    if (!ctx.config.channels.telegram.allowedChatIds.map(String).includes(from)) return [];
    const at = typeof m.date === "number" ? new Date(m.date * 1000).toISOString() : ctx.clock.now().toISOString();
    const msg: InboundMessage = { channel: "telegram", id: String(u.update_id), from, text: m.text, at };
    return [msg];
  },
};
