// Read-only Gmail metadata. Scope gmail.readonly; format=metadata ONLY, never a body.
import type { AgentContext, GmailMessage, GmailPayload } from "../types.ts";
import { redact } from "./redact.ts";

const API = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const TOKEN_KEY = "gmail:token";
const CONCURRENCY = 5;

function need(ctx: AgentContext, name: string): string {
  const v = ctx.env(name);
  if (!v) throw new Error(`missing env var ${name}`);
  return v;
}

export async function gmailAccessToken(ctx: AgentContext): Promise<string> {
  const clientId = need(ctx, "GMAIL_CLIENT_ID");
  const clientSecret = need(ctx, "GMAIL_CLIENT_SECRET");
  const refreshToken = need(ctx, "GMAIL_REFRESH_TOKEN");
  const now = ctx.clock.now().getTime();

  const cached = await ctx.store.kvGet(TOKEN_KEY);
  if (cached) {
    try {
      const c = JSON.parse(cached) as { token?: string; expiresAt?: number };
      if (c.token && typeof c.expiresAt === "number" && c.expiresAt - 60_000 > now) return c.token;
    } catch {
      /* fall through to a fresh token */
    }
  }

  const res = await ctx.fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    }).toString(),
  });
  if (!res.ok) throw new Error(`gmail token refresh failed: HTTP ${res.status}`);
  const j = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!j.access_token) throw new Error("gmail token refresh returned no access_token");
  const expiresAt = now + (j.expires_in ?? 3600) * 1000;
  await ctx.store.kvSet(TOKEN_KEY, JSON.stringify({ token: j.access_token, expiresAt }), ctx.clock.now().toISOString());
  return j.access_token;
}

interface RawMessage {
  id?: string;
  threadId?: string;
  snippet?: string;
  labelIds?: string[];
  internalDate?: string;
  payload?: { headers?: { name?: string; value?: string }[] };
}

export async function fetchGmail(ctx: AgentContext): Promise<GmailMessage[]> {
  const cfg = ctx.config.gmail;
  if (!cfg.enabled) return [];
  const token = await gmailAccessToken(ctx);
  const auth = { authorization: `Bearer ${token}` };

  const listUrl = `${API}?q=${encodeURIComponent(cfg.query)}&maxResults=${cfg.maxMessages}`;
  const listRes = await ctx.fetch(listUrl, { headers: auth });
  if (!listRes.ok) throw new Error(`gmail list failed: HTTP ${listRes.status}`);
  const ids = ((await listRes.json()) as { messages?: { id: string }[] }).messages ?? [];

  const out: GmailMessage[] = new Array(ids.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < ids.length) {
      const i = next++;
      const id = ids[i]!.id;
      const url =
        `${API}/${encodeURIComponent(id)}?format=metadata` +
        `&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`;
      const res = await ctx.fetch(url, { headers: auth });
      if (!res.ok) throw new Error(`gmail message fetch failed: HTTP ${res.status}`);
      const m = (await res.json()) as RawMessage;
      const h = new Map<string, string>();
      for (const x of m.payload?.headers ?? []) if (x.name) h.set(x.name.toLowerCase(), x.value ?? "");
      out[i] = {
        id: m.id ?? id,
        threadId: m.threadId ?? "",
        subject: h.get("subject") ?? "",
        from: h.get("from") ?? "",
        date: h.get("date") ?? "",
        snippet: m.snippet ?? "",
        labelIds: m.labelIds ?? [],
        internalDate: m.internalDate ?? "",
      };
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, worker));
  return out;
}

/** The ONLY path from a Gmail message to an LLM prompt. Exactly four redacted fields. */
export function gmailToLlmPayload(m: GmailMessage): GmailPayload {
  return {
    subject: redact(m.subject),
    from: redact(m.from),
    date: redact(m.date),
    snippet: redact(m.snippet),
  };
}
