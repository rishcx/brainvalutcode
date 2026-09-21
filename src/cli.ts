// The attended entry point. This is the ONLY runtime allowed to use the local gateway.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createBrain } from "./core/brain/chain.ts";
import { TelegramChannel } from "./core/channels/telegram.ts";
import { WhatsappChannel } from "./core/channels/whatsapp.ts";
import { SystemClock } from "./core/clock.ts";
import { parseConfig } from "./core/config.ts";
import { dispatch, JOBS, runDueJobs, type Ctx } from "./core/jobs/dispatch.ts";
import { ask } from "./core/qa/ask.ts";
import { gmailAuthCli } from "./node/gmailAuth.ts";
import { SqliteStore } from "./node/store/sqlite.ts";
import { FsWriter } from "./node/vault/fs.ts";

const ROOT = new URL("../", import.meta.url);
const DEFAULT_VAULT = "/Users/rjangid/Desktop/opensource/Personal/Personal";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    vault: { type: "string", default: process.env.BRAIN_VAULT ?? DEFAULT_VAULT },
    // Resolved against the project, not the cwd: `npm run cli` from anywhere must hit one db.
    db: { type: "string", default: process.env.BRAIN_DB ?? fileURLToPath(new URL(".brain.db", ROOT)) },
    config: { type: "string", default: process.env.BRAIN_CONFIG ?? fileURLToPath(new URL("brain.config.json", ROOT)) },
    explain: { type: "boolean", default: false },
  },
});

const cfg = parseConfig(JSON.parse(readFileSync(values.config, "utf8")));

let cachedToken: string | undefined;
/** Lazy: a job that never touches GitHub must not shell out to `gh`. */
async function githubToken(): Promise<string> {
  if (cachedToken) return cachedToken;
  cachedToken = process.env.GITHUB_TOKEN_READ ?? process.env.GITHUB_TOKEN ?? "";
  if (!cachedToken) cachedToken = execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
  if (!cachedToken) throw new Error("no GitHub token: set GITHUB_TOKEN_READ or run `gh auth login`");
  return cachedToken;
}

const job = positionals[0];
if (!job || job === "help") {
  console.log(
    `usage: npm run cli -- <job|ask "question"|notify "text"|models|gmail:auth|cron|health|jobs> [--explain] [--vault DIR] [--db FILE] [--config FILE]\njobs: ${Object.keys(JOBS).join(", ")}`,
  );
  process.exit(job ? 0 : 1);
}

const clock = new SystemClock(cfg.timezone);
const store = new SqliteStore(values.db, clock);
try {
  const ctx: Ctx = {
    store,
    vault: new FsWriter(values.vault),
    clock,
    fetch: (url, init) => fetch(url, init),
    config: cfg,
    env: (name) => process.env[name],
    runtime: "cli",
    githubToken,
    channels: [],
  };
  ctx.brain = createBrain(ctx); // needs the finished context
  if (cfg.channels.telegram.enabled) ctx.channels!.push(new TelegramChannel(ctx));
  if (cfg.channels.whatsapp.enabled) ctx.channels!.push(new WhatsappChannel(ctx));
  if (job === "health") {
    console.log(JSON.stringify({ ok: true, store: "sqlite", db: values.db, vault: values.vault, tz: cfg.timezone }));
  } else if (job === "jobs") {
    console.log(JSON.stringify(await store.listJobs(), null, 2));
  } else if (job === "ask") {
    const r = await ask(ctx, positionals.slice(1).join(" "));
    console.log(
      values.explain
        ? `${r.answer}\n\n— ${r.entry}${r.cached ? " (cached)" : ""} ${r.ms}ms\n  ${r.sources.join("\n  ")}`
        : r.answer,
    );
  } else if (job === "models") {
    // Discover the model ids each configured gateway really serves, so brain.config.json can name them.
    for (const e of cfg.brain.entries.filter((x) => x.baseUrl && x.keyEnv)) {
      const key = process.env[e.keyEnv!];
      if (!key) {
        console.log(`${e.name}: skipped (${e.keyEnv} not set)`);
        continue;
      }
      try {
        const res = await fetch(`${e.baseUrl}/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const ids = ((await res.json()) as { data?: { id: string }[] }).data?.map((m) => m.id) ?? [];
        console.log(`${e.name}: ${ids.length} models\n  ${ids.slice(0, 80).join("\n  ")}`);
      } catch (err) {
        console.log(`${e.name}: failed (${err instanceof Error ? err.message : "error"})`);
      }
    }
  } else if (job === "notify") {
    // Manual delivery check: sends through every enabled channel.
    const text = positionals.slice(1).join(" ") || "brain-agent test message";
    if (!ctx.channels?.length) throw new Error("no channel enabled: set channels.<name>.enabled in brain.config.json");
    for (const ch of ctx.channels) {
      await ch.send(text);
      console.log(`sent via ${ch.id}`);
    }
  } else if (job === "gmail:auth") {
    await gmailAuthCli();
  } else if (job === "cron") {
    for (const r of await runDueJobs(ctx)) console.log(`${r.name} ${r.status} ${r.detail}`);
  } else {
    console.log(await dispatch(job, ctx));
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await store.close();
}
