# brain-agent

A personal "second brain" tracker. It watches your GitHub repos (and optionally Gmail and
chat), extracts deadlines, writes Markdown notes into your Obsidian vault (only inside
agent-owned folders), and pings you on Telegram or WhatsApp before things are due. It
has **zero runtime dependencies** and needs Node 24+ (it runs TypeScript directly).

## Two runtimes, one codebase

| | Mac CLI (`src/cli.ts`) | Cloudflare Worker (`src/worker.ts`) |
|---|---|---|
| Database | SQLite file (`.brain.db`) | Cloudflare D1 |
| Vault writes | Local folder | GitHub repo via the Git Data API |
| LLM chain | local gateway, OpenRouter, deterministic | OpenRouter, deterministic (never the local gateway) |
| Trigger | commands you type, or `cron` | one `*/15 * * * *` cron plus webhooks |

The Worker is what keeps working while your Mac is asleep. Your vault must be a GitHub
repo for the Worker to write to it.

## Mac setup

```sh
npm install                       # dev tooling only (typescript)
cp .env.example .env              # then fill in what you use; never commit .env
npm run cli -- help               # lists every job
npm run cli -- poll:github        # fetch repos, write notes and Deadlines/
npm run cli -- cron               # run every job that is due (attended)
npm run typecheck && npm test     # both must stay green; tests are fully offline
```

Options: `--vault DIR`, `--db FILE`, `--config FILE` (or `BRAIN_VAULT`, `BRAIN_DB`,
`BRAIN_CONFIG`). Settings live in `brain.config.json`; it holds only the *names* of
environment variables, never secrets.

## Deploy to Cloudflare

Short version (full walkthrough in [docs/OPS.md](docs/OPS.md)):

1. `npx wrangler login`
2. `npx wrangler d1 create brain-agent`, paste the printed id into `wrangler.toml`.
3. Edit `[vars]` in `wrangler.toml` (`VAULT_REPO`, `VAULT_BRANCH`, `BRAIN_CONFIG`).
4. `npx wrangler d1 migrations apply brain-agent --remote`
5. Set each secret with `npx wrangler secret put NAME` (table below).
6. `npx wrangler deploy`
7. Register the Telegram / WhatsApp webhooks (see OPS.md) and check `/health`.

## Secrets

Secrets are set only with `npx wrangler secret put NAME` (Worker) or in your local `.env`
(Mac). They are never stored in `wrangler.toml`, `brain.config.json` or the vault.

| Name | Where | What it is |
|---|---|---|
| `GITHUB_TOKEN_READ` | both | Fine-grained, read-only (Metadata, Issues, Pull requests) on the repos you track |
| `GITHUB_TOKEN_VAULT` | Worker | Fine-grained, **only** the vault repo, Contents read/write |
| `ADMIN_TOKEN` | Worker | Bearer token for `POST /admin/run`. Long random string |
| `OPENROUTER_KEY` | both | OpenRouter API key (fallback LLM) |
| `OMNIROUTE_KEY` | Mac only | Local gateway key. Never set on the Worker |
| `TELEGRAM_TOKEN` | both | Bot token from @BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | Worker | Random string Telegram echoes in a header |
| `TELEGRAM_WEBHOOK_PATH` | Worker | Random URL segment: webhook is `/wh/tg/<value>` |
| `WHATSAPP_TOKEN` | both | WhatsApp Cloud API access token |
| `WHATSAPP_PHONE_ID` | both | WhatsApp phone-number id |
| `WHATSAPP_APP_SECRET` | Worker | Meta app secret, used to verify webhook signatures |
| `WHATSAPP_VERIFY_TOKEN` | Worker | Random string you also give Meta when subscribing |
| `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` / `GMAIL_REFRESH_TOKEN` | both | Gmail OAuth (metadata-only access) |

Non-secret values (`VAULT_REPO`, `VAULT_BRANCH`, `BRAIN_CONFIG`) go under `[vars]` in
`wrangler.toml`.

## Safety rules baked in

- The agent writes only to `Digests/`, `GitHub/`, `Gmail/`, `Deadlines/index.md`,
  `Deadlines/deadlines.json`, `Plans/Proposed/`, `Inbox/`, `Threads/`, `Meta/`. Both vault
  writers share one allowlist (`src/core/vault/paths.ts`).
- The local LLM gateway (your personal quota) can never be reached from the Worker.
- Webhooks are verified before anything runs, and are acknowledged immediately.
