// GET /admin/trace?n=50 — Bearer ADMIN_TOKEN, constant-time compare, JSON { rows }. No prompts are stored.
import { sha256Hex, timingSafeEqualHex } from "../crypto.ts";
import type { AgentContext } from "../types.ts";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const MAX_ROWS = 200;

/** null when the path/method is not this route, so the worker can fall through to its other handlers. */
export async function handleTraceAdmin(
  req: Request,
  ctx: AgentContext,
  adminToken: string | undefined,
): Promise<Response | null> {
  const url = new URL(req.url);
  if (req.method !== "GET" || url.pathname !== "/admin/trace") return null;

  const auth = req.headers.get("authorization") ?? "";
  const ok = adminToken
    ? await timingSafeEqualHex(await sha256Hex(auth), await sha256Hex(`Bearer ${adminToken}`))
    : false;
  if (!ok) return json({ error: "forbidden" }, 403);

  const raw = Number(url.searchParams.get("n") ?? "50");
  const n = Number.isFinite(raw) ? Math.min(MAX_ROWS, Math.max(1, Math.trunc(raw))) : 50;
  const rows = await ctx.store.listTrace(n);
  return json({ rows });
}
