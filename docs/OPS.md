# Operations guide

Everything here uses `npx wrangler` (no global install). Run commands from the project
root. Replace `<your-worker-url>` with the URL `wrangler deploy` prints, for example
`https://brain-agent.<your-subdomain>.workers.dev`.

## 1. First deploy

1. **Log in:** `npx wrangler login` (opens a browser).
2. **Create the database:** `npx wrangler d1 create brain-agent`. Copy the
   `database_id` it prints into `wrangler.toml`, replacing `REPLACE_WITH_D1_DATABASE_ID`.
3. **Edit `[vars]` in `wrangler.toml`:** set `VAULT_REPO` (`owner/name` of the GitHub
   repo that holds your vault), `VAULT_BRANCH`, and adjust `BRAIN_CONFIG` (timezone,
   channels). Set channel `enabled` to `true` and fill the allowed chat / WhatsApp ids
   when you turn a channel on.
4. **Create the tables:** `npx wrangler d1 migrations apply brain-agent --remote`
   (the Worker never creates tables itself).
5. **Create a GitHub token:** GitHub, Settings, Developer settings, Fine-grained tokens.
   Give it *Contents: Read and write* on the vault repo, and read access to repos you
   want tracked.
6. **Set secrets**, one command each; each prompts for the value:
   ```sh
   npx wrangler secret put GITHUB_TOKEN_READ    # read-only, all repos you track
   npx wrangler secret put GITHUB_TOKEN_VAULT   # Contents read/write on the vault repo ONLY
   npx wrangler secret put ADMIN_TOKEN        # any long random string
   npx wrangler secret put OPENROUTER_KEY
   ```
   Add the Telegram / WhatsApp / Gmail secrets from the README table as you enable them.
   Do **not** set `OMNIROUTE_KEY` on the Worker.
7. **Deploy:** `npx wrangler deploy`
8. **Check:** `curl <your-worker-url>/health` should return `{"ok":true,...}`.

## 2. Registering webhooks

### Telegram

1. Create a bot with @BotFather; put its token in `TELEGRAM_TOKEN`.
2. Generate two random strings. Save them as secrets `TELEGRAM_WEBHOOK_PATH` and
   `TELEGRAM_WEBHOOK_SECRET`.
3. Tell Telegram where to send updates (run this in your own terminal, with the values
   in shell variables so they do not land in shared logs):
   ```sh
   curl -sS "https://api.telegram.org/bot$TELEGRAM_TOKEN/setWebhook" \
     --data-urlencode "url=<your-worker-url>/wh/tg/$TELEGRAM_WEBHOOK_PATH" \
     --data-urlencode "secret_token=$TELEGRAM_WEBHOOK_SECRET"
   ```
4. Add your chat id to `channels.telegram.allowedChatIds` in `BRAIN_CONFIG`, set
   `enabled: true`, redeploy. Messages from other chats are dropped.

### WhatsApp (Cloud API)

1. In the Meta developer dashboard, open your app, WhatsApp, Configuration.
2. Callback URL: `<your-worker-url>/wh/whatsapp`. Verify token: the value of your
   `WHATSAPP_VERIFY_TOKEN` secret. Meta calls the URL with a challenge; the Worker echoes
   it only when the token matches.
3. Subscribe to the `messages` field.
4. Set secrets `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID`, `WHATSAPP_APP_SECRET`,
   `WHATSAPP_VERIFY_TOKEN`. Add your number to `channels.whatsapp.allowedWaIds`,
   set `enabled: true`, redeploy.

## 3. Rotating a secret

1. Create the new value at the provider (new token, new bot token, and so on).
2. `npx wrangler secret put NAME` and paste the new value. It applies on the next request.
3. Revoke the old value at the provider.
4. For Telegram: if you rotate `TELEGRAM_WEBHOOK_SECRET` or `TELEGRAM_WEBHOOK_PATH`, run
   `setWebhook` again with the new values. For WhatsApp: rotating `WHATSAPP_VERIFY_TOKEN`
   means re-saving the callback in Meta.

## 4. Reading `/health`

`GET <your-worker-url>/health` returns JSON: `ok`, `tz`, `runtime` (always `worker`) and
`jobs`. Each job row has `lastRunAt`, `lastStatus` (`ok` or `error`), `lastDetail`
(what it did, or the error message) and `nextRunAt`. It never includes secrets. If
`ok` is `false` the database is unreachable (check the D1 binding and migrations).

## 5. Replaying a job

```sh
curl -sS -X POST "<your-worker-url>/admin/run?job=poll:github" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

Job names: `poll:github`, `digest:daily`, plus `poll:gmail` and `sweep:reminders` once
integrated. Unknown name gives 400; a missing or wrong token gives 403. The response
contains the job's summary or its error message.

## 6. When the cron silently stops

1. `GET /health` and read `jobs[].lastRunAt`. If it is old, the cron is not firing.
2. Cloudflare dashboard, Workers, brain-agent, Triggers: confirm the `*/15 * * * *`
   cron is listed. If not, `npx wrangler deploy` again.
3. If `lastRunAt` is fresh but `lastStatus` is `error`, read `lastDetail`. Common
   causes: expired or rotated `GITHUB_TOKEN` (401/403), GitHub rate limit, a
   `VAULT_REPO` typo, or the vault branch name being wrong.
4. If a job is missing from `jobs`, it has never run: call `/admin/run` once.
5. Watch live logs while a run happens: `npx wrangler tail`. Logs contain job names and
   error messages only, never tokens or webhook paths.
6. Vault commit failing with "kept moving": something else pushed to the branch during
   the run. It self-heals on the next run; nothing is lost.
