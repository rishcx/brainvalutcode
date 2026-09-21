// One OpenAI-compatible chat-completions call. Web-standard APIs only.
import type { Fetcher } from "../types.ts";

export interface CompletionCall {
  baseUrl: string;
  apiKey: string;
  model: string;
  fetch: Fetcher;
  prompt: string;
  system?: string;
  maxTokens?: number;
  temperature?: number;
  jsonSchema?: unknown;
  signal?: AbortSignal;
  /** v3: provider JSON mode. Ignored when `jsonSchema` is set (that already sets response_format). */
  responseFormat?: "json_object";
  /** v3: merged into the request body; never overrides model/messages/max_tokens/response_format. */
  extraBody?: Record<string, unknown>;
}

/** v3: rate-limit headers of one call, normalised. Any field absent when the header was missing or unparseable. */
export interface RateInfo {
  remainingReq?: number;
  remainingTok?: number;
  resetAt?: string;
  retryAfterMs?: number;
}

export class LlmError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  /** v3: rate-limit headers of the response that produced this error, when one was received. */
  readonly rate?: RateInfo;
  /** v3: true when the 400 came back while `extraBody` or `responseFormat` was sent. */
  readonly badParam?: boolean;
  constructor(message: string, status: number, retryable: boolean, extra: { rate?: RateInfo; badParam?: boolean } = {}) {
    super(message);
    this.name = "LlmError";
    this.status = status;
    this.retryable = retryable;
    this.rate = extra.rate;
    this.badParam = extra.badParam;
  }
}

const isAbort = (e: unknown): boolean =>
  typeof e === "object" && e !== null && ["AbortError", "TimeoutError"].includes((e as { name?: string }).name ?? "");

const PROTECTED_KEYS = new Set(["model", "messages", "max_tokens", "response_format"]);

/**
 * Groq/OpenAI-style durations: "2m59.56s", "7.66s", "1h2m", "1h2m3.5s". Any other shape (including "") is null,
 * never a throw: a garbled header must fall back to "no info", not break the call.
 */
function parseDuration(s: string): number | null {
  const m = /^\s*(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?\s*$/.exec(s);
  if (!m || (m[1] === undefined && m[2] === undefined && m[3] === undefined)) return null;
  const h = m[1] ? Number(m[1]) : 0;
  const min = m[2] ? Number(m[2]) : 0;
  const sec = m[3] ? Number(m[3]) : 0;
  return h * 3_600_000 + min * 60_000 + sec * 1000;
}

/** Never throws: a missing or garbled header simply leaves its field absent. */
export function parseRate(h: Headers, now: Date): RateInfo {
  const info: RateInfo = {};
  try {
    const reqRem = h.get("x-ratelimit-remaining-requests");
    if (reqRem !== null) {
      const n = Number(reqRem);
      if (Number.isFinite(n)) info.remainingReq = n;
    }
    const tokRem = h.get("x-ratelimit-remaining-tokens");
    if (tokRem !== null) {
      const n = Number(tokRem);
      if (Number.isFinite(n)) info.remainingTok = n;
    }
    const resetReq = h.get("x-ratelimit-reset-requests");
    if (resetReq !== null) {
      const ms = parseDuration(resetReq);
      if (ms !== null) info.resetAt = new Date(now.getTime() + ms).toISOString();
    }
    const retryAfter = h.get("retry-after");
    if (retryAfter !== null) {
      const secs = Number(retryAfter);
      if (Number.isFinite(secs) && retryAfter.trim() !== "") {
        info.retryAfterMs = Math.max(0, Math.round(secs * 1000));
      } else {
        const d = new Date(retryAfter);
        if (!Number.isNaN(d.getTime())) info.retryAfterMs = Math.max(0, d.getTime() - now.getTime());
      }
    }
  } catch {
    /* never throw over a header parse */
  }
  return info;
}

function numUsage(u: unknown): { in: number; out: number } | undefined {
  if (!u || typeof u !== "object") return undefined;
  const o = u as Record<string, unknown>;
  const pin = o.prompt_tokens;
  const pout = o.completion_tokens;
  return typeof pin === "number" && typeof pout === "number" ? { in: pin, out: pout } : undefined;
}

export async function openAiCompat(
  call: CompletionCall,
  now?: Date,
): Promise<{ text: string; model: string; usage?: { in: number; out: number }; rate: RateInfo }> {
  const at = now ?? new Date();
  const messages: { role: string; content: string }[] = [];
  if (call.system) messages.push({ role: "system", content: call.system });
  messages.push({ role: "user", content: call.prompt });

  const body: Record<string, unknown> = { model: call.model, messages };
  if (call.maxTokens !== undefined) body.max_tokens = call.maxTokens;
  if (call.temperature !== undefined) body.temperature = call.temperature;
  if (call.jsonSchema !== undefined) {
    body.response_format = { type: "json_schema", json_schema: { name: "out", schema: call.jsonSchema, strict: true } };
  } else if (call.responseFormat === "json_object") {
    body.response_format = { type: "json_object" };
  }
  const sentExtra = call.extraBody !== undefined || call.responseFormat !== undefined;
  if (call.extraBody) {
    for (const [k, v] of Object.entries(call.extraBody)) {
      if (PROTECTED_KEYS.has(k)) continue; // extraBody can never override these
      body[k] = v;
    }
  }

  let res: Response;
  try {
    res = await call.fetch(`${call.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${call.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: call.signal,
    });
  } catch (e) {
    // Never include the request or the key in the message.
    if (isAbort(e)) throw new LlmError("request timed out", 0, true);
    throw new LlmError("request failed", 0, false);
  }

  if (!res.ok) {
    const rate = parseRate(res.headers, at);
    await res.body?.cancel().catch(() => undefined);
    const badParam = res.status === 400 && sentExtra;
    throw new LlmError(`http ${res.status}`, res.status, res.status === 429 || res.status >= 500, { rate, badParam });
  }

  const rate = parseRate(res.headers, at);
  let text: unknown;
  try {
    const json = (await res.json()) as { choices?: { message?: { content?: unknown } }[]; model?: unknown; usage?: unknown };
    text = json.choices?.[0]?.message?.content;
    if (typeof text === "string" && text.length > 0) {
      return {
        text,
        model: typeof json.model === "string" && json.model ? json.model : call.model,
        usage: numUsage(json.usage),
        rate,
      };
    }
  } catch (e) {
    if (isAbort(e)) throw new LlmError("request timed out", 0, true, { rate });
  }
  throw new LlmError("malformed completion response", 502, false, { rate });
}
