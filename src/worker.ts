// Cloudflare Worker entry: one */15 cron drives every job, plus webhook ingress.
// Web-standard APIs only. Never uses the local gateway: ctx.runtime is "worker".
import { createBrain } from "./core/brain/chain.ts";
import { TelegramChannel, telegramWebhook } from "./core/channels/telegram.ts";
import { WhatsappChannel, whatsappWebhook } from "./core/channels/whatsapp.ts";
import { handleInbound, handleInboundV3 } from "./core/inbound/commands.ts";
import { handleWeb } from "./core/web/index.ts";
import { handleTraceAdmin } from "./core/trace/admin.ts";
import { beginTrace, finishTrace, instrumentBrain, preview, timed } from "./core/trace/record.ts";
import { SystemClock } from "./core/clock.ts";
import { parseConfig } from "./core/config.ts";
import { sha256Hex, timingSafeEqualHex } from "./core/crypto.ts";
import { dispatch, runDueJobs } from "./core/jobs/dispatch.ts";
import { D1Store } from "./core/store/d1.ts";
import type {
  InboundResult,
  AgentContext,
  Brain,
  Channel,
  D1Database,
  ExecutionContext,
  Fetcher,
  InboundMessage,
  ScheduledController,
  WebhookAdapter,
  WorkerDeps,
} from "./core/types.ts";
import { GitDataApiWriter } from "./core/vault/gitDataApi.ts";

type Env = Record<string, unknown>;

/** WorkerDeps plus integration seams that keep this file free of package A/C imports. */
export interface WorkerOptions extends WorkerDeps {
  /** Builds the LLM chain for a request context (integrator: `createBrain`). */
  makeBrain?: (ctx: AgentContext) => Brain;
  /** Builds outbound channels for a request context (integrator: Telegram/WhatsApp classes). */
  makeChannels?: (ctx: AgentContext) => Channel[];
  /** Test seam; defaults to the global fetch. */
  fetch?: Fetcher;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const text = (body: string, status: number): Response =>
  new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

/** Constant-time string equality: compare fixed-length digests, so length never leaks. */
async function safeEqual(a: string, b: string): Promise<boolean> {
  return timingSafeEqualHex(await sha256Hex(a), await sha256Hex(b));
}

const envStr = (env: Env, name: string): string | undefined => {
  const v = env[name];
  return typeof v === "string" && v.length ? v : undefined;
};

export function createWorker(deps: WorkerOptions = {}) {
  const doFetch: Fetcher = deps.fetch ?? ((u, i) => fetch(u, i));

  function buildContext(env: Env): AgentContext {
    let requests = 0;
    const countedFetch: Fetcher = (u, i) => {
      requests++;
      return doFetch(u, i);
    };
    const config = parseConfig(JSON.parse(envStr(env, "BRAIN_CONFIG") ?? "{}"));
    const clock = new SystemClock(config.timezone);
    // Two tokens so a leaked one is bounded: the vault token can write ONLY the vault repo; the read token can't write at all.
    // Either falls back to the single GITHUB_TOKEN (older setups).
    const vaultToken = envStr(env, "GITHUB_TOKEN_VAULT") ?? envStr(env, "GITHUB_TOKEN");
    const readToken = envStr(env, "GITHUB_TOKEN_READ") ?? envStr(env, "GITHUB_TOKEN");
    const ctx: AgentContext = {
      store: new D1Store(env.DB as D1Database, clock),
      vault: new GitDataApiWriter({
        repo: envStr(env, "VAULT_REPO") ?? "",
        branch: envStr(env, "VAULT_BRANCH") ?? "main",
        token: vaultToken ?? "",
        fetch: countedFetch,
      }),
      clock,
      fetch: countedFetch,
      requestCount: () => requests,
      config,
      env: (n) => envStr(env, n),
      runtime: "worker",
      githubToken: async () => {
        if (!readToken) throw new Error("GITHUB_TOKEN_READ (or GITHUB_TOKEN) secret is not set");
        return readToken;
      },
    };
    if (deps.makeBrain) ctx.brain = deps.makeBrain(ctx);
    ctx.channels = deps.makeChannels ? deps.makeChannels(ctx) : [];
    return ctx;
  }

  /** Runs after the 200 has gone out. Errors are logged by message only (never bodies/secrets). */
  async function handleMessages(ctx: AgentContext, adapter: WebhookAdapter, raw: string): Promise<void> {
    try {
      if (!deps.onInbound) return;
      // Cloudflare's ~30 s limit is for the WHOLE invocation, and one webhook can carry several messages. So the
      // deadline is shared by the batch: a slow first message must not leave the second one to be cancelled silently.
      const batchDeadline = performance.now() + 24_000;
      const msgs: InboundMessage[] = await adapter.parse(raw, ctx);
      for (const m of msgs) {
        // The default wiring uses the v3 agent; a custom onInbound (tests, embedders) keeps the generic path below.
        if (ctx.config.chat.engine === "v3" && deps.onInbound === handleInbound) {
          await handleV3(ctx, m, batchDeadline);
          continue;
        }
        // Every inbound message is traced (route, stage timings, LLM calls, reply preview, delivery), never blocking.
        const d = beginTrace(ctx, { channel: m.channel, peer: m.from }, "inbound", `${m.channel}:${m.id}`);
        const baseBrain = ctx.brain;
        if (baseBrain) ctx.brain = instrumentBrain(baseBrain, d);
        let delivery = "none";
        let error: string | undefined;
        try {
          const ch = ctx.channels?.find((c) => c.id === m.channel);
          void ch?.typing?.(m.from).catch(() => undefined); // cosmetic, never awaited
          const reply = await timed(d, "handle", () => deps.onInbound!(ctx, m));
          if (d.route === "dropped") d.route = reply ? "legacy" : "dropped";
          if (reply && ch) {
            d.replyChars = reply.length;
            d.replyPreview = preview(reply);
            await timed(d, "send", () => (ch.sendTo ? ch.sendTo(m.from, reply) : ch.send(reply)));
            delivery = "sent";
          }
        } catch (e) {
          delivery = "failed";
          error = e instanceof Error ? e.message : "unknown error";
          console.error("inbound failed:", error);
        } finally {
          ctx.brain = baseBrain;
          await finishTrace(ctx, d, delivery, error);
        }
      }
    } catch (e) {
      console.error("inbound failed:", e instanceof Error ? e.message : "unknown error");
    }
  }

  /** v3: the agent builds its own trace draft; this sends the reply to the sender and finishes the trace. */
  async function handleV3(ctx: AgentContext, m: InboundMessage, batchDeadline: number): Promise<void> {
    const ch = ctx.channels?.find((c) => c.id === m.channel);
    const left = batchDeadline - performance.now();
    if (left < 6_000) {
      // Not enough time left in this invocation to do the work safely: say so instead of being cancelled mid-way.
      const busy = "I was still busy with your previous message, so I skipped this one. Please send it again.";
      console.error("batch deadline: skipped a message with", Math.round(left), "ms left");
      await (ch?.sendTo ? ch.sendTo(m.from, busy) : ch?.send(busy))?.catch(() => undefined);
      return;
    }
    void ch?.typing?.(m.from).catch(() => undefined);
    // Watchdog: Cloudflare cancels background work ~30 s after the ack, silently. At 22 s we stop waiting, tell the
    // user, and record which stage was running, so a hang is never silent again.
    let live: (InboundResult["trace"] & { current?: string; t0?: number }) | null = null;
    const WATCHDOG_MS = Math.min(22_000, left - 2_000);
    const timedOut = Symbol("timeout");
    const raced = await Promise.race([
      handleInboundV3(ctx, m, { onTrace: (t) => (live = t), deferAfter: true }).catch((e: unknown) => {
        // A throw here (e.g. D1 failing at the idempotency check) must never look like "message ignored".
        console.error("v3 handler failed:", e instanceof Error ? e.message : "unknown error");
        return "failed" as const;
      }),
      new Promise<typeof timedOut>((r) => setTimeout(() => r(timedOut), WATCHDOG_MS)),
    ]);
    if (raced === timedOut) {
      const d = live as (InboundResult["trace"] & { current?: string; t0: number }) | null;
      const where = `hung in stage "${d?.current ?? "unknown"}"; finished: ${JSON.stringify(d?.stages ?? {})}`;
      console.error("watchdog:", where);
      const sorry = "Sorry, that took too long on my side and I stopped it. Please send it again.";
      await (ch?.sendTo ? ch.sendTo(m.from, sorry) : ch?.send(sorry))?.catch(() => undefined);
      if (d) {
        if (typeof d.t0 !== "number") d.t0 = performance.now();
        d.route = "dropped";
        await finishTrace(ctx, d, "sent-timeout-notice", `watchdog: ${where}`);
      }
      return;
    }
    if (raced === "failed") {
      const oops = "Something went wrong on my side. Please send that again.";
      await (ch?.sendTo ? ch.sendTo(m.from, oops) : ch?.send(oops))?.catch(() => undefined);
      return;
    }
    const res = raced;
    if (!res) return; // ignored (not allowlisted / duplicate)
    const d = res.trace as typeof res.trace & { t0: number };
    if (typeof d.t0 !== "number") d.t0 = performance.now();
    let delivery = "none";
    let error: string | undefined;
    try {
      if (res.reply && ch) {
        d.replyChars = res.reply.length;
        d.replyPreview = preview(res.reply);
        await timed(d, "send", () => (ch.sendTo ? ch.sendTo(m.from, res.reply!) : ch.send(res.reply!)));
        delivery = "sent";
        d.stages.replied = Math.round(performance.now() - d.t0); // what the user actually waited
      }
    } catch (e) {
      delivery = "failed";
      error = e instanceof Error ? e.message : "unknown error";
      console.error("inbound failed:", error);
    } finally {
      // Saving the turns and refreshing the day summary happen only now, after the user has their reply.
      if (res.after && batchDeadline - performance.now() > 3_000) await res.after();
      else if (res.after) void res.after();
      await finishTrace(ctx, d, delivery, error);
    }
  }

  async function webhook(
    req: Request,
    adapter: WebhookAdapter | undefined,
    ctx: AgentContext,
    ectx: ExecutionContext,
  ): Promise<Response> {
    if (!adapter) return text("channel not configured", 503);
    const raw = await req.text(); // raw body, read exactly once
    if (!(await adapter.verify(req, raw, ctx))) return text("forbidden", 403);
    ectx.waitUntil(handleMessages(ctx, adapter, raw)); // ack first, work after
    return text("ok", 200);
  }

  async function route(req: Request, env: Env, ectx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const ctx = buildContext(env);

    if (req.method === "GET" && path === "/health") {
      try {
        const jobs = await ctx.store.listJobs();
        return json({ ok: true, tz: ctx.config.timezone, runtime: ctx.runtime, jobs });
      } catch {
        return json({ ok: false, tz: ctx.config.timezone, runtime: ctx.runtime, error: "store unavailable" }, 503);
      }
    }

    if (path === "/wh/whatsapp") {
      if (req.method === "GET") {
        const expected = envStr(env, "WHATSAPP_VERIFY_TOKEN");
        const given = url.searchParams.get("hub.verify_token");
        const challenge = url.searchParams.get("hub.challenge");
        const ok =
          expected !== undefined &&
          given !== null &&
          challenge !== null &&
          url.searchParams.get("hub.mode") === "subscribe" &&
          (await safeEqual(given, expected));
        return ok ? text(challenge, 200) : text("forbidden", 403);
      }
      if (req.method === "POST") return webhook(req, deps.whatsapp, ctx, ectx);
    }

    if (req.method === "POST" && path.startsWith("/wh/tg/")) {
      const expected = envStr(env, "TELEGRAM_WEBHOOK_PATH");
      const given = decodeURIComponent(path.slice("/wh/tg/".length));
      if (!expected || !(await safeEqual(given, expected))) return text("forbidden", 403);
      return webhook(req, deps.telegram, ctx, ectx);
    }

    if (req.method === "POST" && path === "/admin/run") {
      const admin = envStr(env, "ADMIN_TOKEN");
      const auth = req.headers.get("authorization") ?? "";
      if (!admin || !(await safeEqual(auth, `Bearer ${admin}`))) return text("forbidden", 403);
      const job = url.searchParams.get("job");
      if (!job) return json({ error: "missing ?job=<name>" }, 400);
      try {
        return json({ job, ok: true, result: await dispatch(job, ctx) });
      } catch (e) {
        const msg = e instanceof Error ? e.message : "failed";
        return json({ job, ok: false, error: msg }, msg.startsWith("unknown job") ? 400 : 500);
      }
    }

    const traced = await handleTraceAdmin(req, ctx, envStr(env, "ADMIN_TOKEN"));
    if (traced) return traced;

    // Phone editor. Returns null (=> 404 below) for every path unless EDIT_ENABLED=1 and ADMIN_TOKEN is set.
    const web = await handleWeb(req, ctx, {
      adminToken: envStr(env, "ADMIN_TOKEN"),
      enabled: envStr(env, "EDIT_ENABLED") === "1",
    });
    if (web) return web;

    return text("not found", 404);
  }

  return {
    async fetch(req: Request, env: Env, ectx: ExecutionContext): Promise<Response> {
      try {
        return await route(req, env, ectx);
      } catch (e) {
        console.error("request failed:", e instanceof Error ? e.message : "unknown error");
        return json({ ok: false, error: "internal error" }, 500);
      }
    },

    async scheduled(_c: ScheduledController, env: Env, ectx: ExecutionContext): Promise<void> {
      ectx.waitUntil(
        (async () => {
          const results = await runDueJobs(buildContext(env));
          for (const r of results) console.log(`job ${r.name}: ${r.status}`);
        })(),
      );
    },
  };
}

export default createWorker({
  telegram: telegramWebhook,
  whatsapp: whatsappWebhook,
  onInbound: handleInbound,
  makeBrain: (c) => createBrain(c), // runtime "worker" excludes the local gateway
  makeChannels: (c) => [
    ...(c.config.channels.telegram.enabled ? [new TelegramChannel(c)] : []),
    ...(c.config.channels.whatsapp.enabled ? [new WhatsappChannel(c)] : []),
  ],
});
