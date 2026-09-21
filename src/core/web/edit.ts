// Cookie-authenticated phone editor. handleWeb() returns null for anything that is not one of
// its routes, and for EVERY path when disabled (kill switch) -> the Worker answers 404.
import { sha256Hex, timingSafeEqualHex } from "../crypto.ts";
import type { AgentContext } from "../types.ts";
import { conflictPage, editorPage, errorPage, listPage, loginPage, redirect } from "./html.ts";
import { HUMAN_PREFIXES, isEditablePath } from "./paths.ts";
import {
  clearCookieHeader, COOKIE_NAME, readCookie, sessionCookieHeader, signSession, verifySession,
} from "./session.ts";
import { createHumanVault, type HumanVault } from "./vault.ts";


export interface WebEnv {
  adminToken: string | undefined;
  enabled: boolean;
  sessionTtlSec?: number;
  maxBytes?: number;
  /** Test seam; production leaves it unset and gets createHumanVault(ctx). */
  humanVault?: HumanVault;
}

const ROUTES = new Set(["/login", "/logout", "/edit", "/edit/file", "/edit/save"]);
const LOGIN_BODY_CAP = 2048;
const RL_WINDOW_SEC = 900;
const RL_MAX_FAILS = 5;
const LIST_MAX = 300;
const SHA_RE = /^(?:[0-9a-f]{40})?$/;

const methodNotAllowed = (allow: string): Response => errorPage(405, "Method not allowed", { allow });

/** Reads at most `cap` bytes; returns null when the body is larger. */
async function readCapped(req: Request, cap: number): Promise<string | null> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > cap) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

/** Origin must match when present; otherwise Sec-Fetch-Site must say same-origin. */
function sameOrigin(req: Request, url: URL): boolean {
  const origin = req.headers.get("origin");
  if (origin !== null) return origin === url.origin;
  return req.headers.get("sec-fetch-site") === "same-origin";
}

/** Git blob sha1 of the text, so "unchanged" needs no extra GitHub fetch. */
async function gitBlobSha(text: string): Promise<string> {
  const body = new TextEncoder().encode(text);
  const head = new TextEncoder().encode(`blob ${body.length}\0`);
  const buf = new Uint8Array(head.length + body.length);
  buf.set(head);
  buf.set(body, head.length);
  const d = await crypto.subtle.digest("SHA-1", buf);
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function handleWeb(req: Request, ctx: AgentContext, env: WebEnv): Promise<Response | null> {
  const url = new URL(req.url);
  if (!env.enabled || !env.adminToken || !ROUTES.has(url.pathname)) return null;
  try {
    return await route(req, url, ctx, env as WebEnv & { adminToken: string });
  } catch {
    return errorPage(500, "Internal error");
  }
}

async function route(req: Request, url: URL, ctx: AgentContext, env: WebEnv & { adminToken: string }): Promise<Response> {
  const nowSec = Math.floor(ctx.clock.now().getTime() / 1000);
  const ttl = Math.min(Math.max(env.sessionTtlSec ?? 3600, 60), 7200);
  const maxBytes = env.maxBytes ?? 200_000;
  const method = req.method;
  const vault = env.humanVault ?? createHumanVault(ctx);
  const session = () =>
    verifySession(env.adminToken, readCookie(req.headers.get("cookie"), COOKIE_NAME), nowSec);

  switch (url.pathname) {
    case "/login": {
      if (method === "GET") return loginPage();
      if (method !== "POST") return methodNotAllowed("GET, POST");
      const raw = await readCapped(req, LOGIN_BODY_CAP);
      if (raw === null) return errorPage(413, "Request too large");
      if (!sameOrigin(req, url)) return errorPage(403, "Forbidden");
      const window = Math.floor(nowSec / RL_WINDOW_SEC);
      const key = `web:rl:${window}`;
      let fails: number;
      try {
        fails = Number((await ctx.store.kvGet(key)) ?? "0") || 0;
      } catch {
        return errorPage(503, "Temporarily unavailable");
      }
      if (fails >= RL_MAX_FAILS) {
        return errorPage(429, "Too many attempts", { "retry-after": String((window + 1) * RL_WINDOW_SEC - nowSec) });
      }
      const given = new URLSearchParams(raw).get("password") ?? "";
      const ok = timingSafeEqualHex(await sha256Hex(given), await sha256Hex(env.adminToken));
      if (!ok) {
        try {
          await ctx.store.kvSet(key, String(fails + 1), ctx.clock.now().toISOString());
        } catch {
          return errorPage(503, "Temporarily unavailable");
        }
        return loginPage("Invalid password", 401);
      }
      const s = await signSession(env.adminToken, nowSec, ttl);
      return redirect("/edit", {}, [sessionCookieHeader(s.cookie, ttl)]);
    }

    case "/logout": {
      if (method !== "POST") return methodNotAllowed("POST");
      const s = await session();
      if (!s.ok) return redirect("/login");
      const raw = await readCapped(req, LOGIN_BODY_CAP);
      if (raw === null) return errorPage(413, "Request too large");
      if (!sameOrigin(req, url)) return errorPage(403, "Forbidden");
      if (!timingSafeEqualHex(new URLSearchParams(raw).get("csrf") ?? "", s.csrf)) return errorPage(403, "Forbidden");
      return redirect("/login", {}, [clearCookieHeader()]);
    }

    case "/edit": {
      if (method !== "GET") return methodNotAllowed("GET");
      const s = await session();
      if (!s.ok) return redirect("/login");
      const files = (await ctx.vault.listFiles())
        .filter((p) => HUMAN_PREFIXES.some((h) => p.startsWith(h)) && isEditablePath(p))
        .slice(0, LIST_MAX);
      return listPage(files, s.csrf);
    }

    case "/edit/file": {
      if (method !== "GET") return methodNotAllowed("GET");
      const s = await session();
      if (!s.ok) return redirect("/login");
      const path = url.searchParams.get("path") ?? "";
      if (!isEditablePath(path)) return errorPage(403, "Path not editable");
      const loaded = await vault.load(path);
      return editorPage({
        path,
        sha: loaded?.sha ?? "",
        csrf: s.csrf,
        content: loaded?.content ?? "",
        saved: url.searchParams.get("saved") === "1",
      });
    }

    case "/edit/save": {
      if (method !== "POST") return methodNotAllowed("POST");
      const s = await session();
      if (!s.ok) return errorPage(401, "Not logged in");
      if (!sameOrigin(req, url)) return errorPage(403, "Forbidden");
      // The csrf token travels in the body, so the (capped) body is read before it is checked.
      const raw = await readCapped(req, maxBytes + 4096);
      if (raw === null) return errorPage(413, "Content too large");
      const form = new URLSearchParams(raw);
      if (!timingSafeEqualHex(form.get("csrf") ?? "", s.csrf)) return errorPage(403, "Forbidden");
      const path = form.get("path") ?? "";
      if (!isEditablePath(path)) return errorPage(403, "Path not editable");
      const sha = form.get("sha") ?? "";
      const content = form.get("content");
      if (content === null || content.includes("\0") || !SHA_RE.test(sha)) return errorPage(400, "Bad request");
      if (new TextEncoder().encode(content).length > maxBytes) return errorPage(413, "Content too large");
      const text = content.replace(/\r\n/g, "\n");
      const back = `/edit/file?path=${encodeURIComponent(path)}`;
      if (sha && (await gitBlobSha(text)) === sha) return redirect(`${back}&saved=1`);
      const res = await vault.save(path, text, sha || null, `web edit: ${path}`);
      if (res === "conflict") return conflictPage(path, text);
      return redirect(`${back}&saved=1`);
    }
  }
  return errorPage(404, "Not found");
}
