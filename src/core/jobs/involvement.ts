import { INVOLVEMENT_NOTE_PATH, renderInvolvementNote, serialiseSnapshot } from "../render/involvement.ts";
import { fetchInvolvement, INVOLVEMENT_KV, isValidLogin, LOGIN_KV, parseSnapshot } from "../sources/involvement.ts";
import { localDate } from "../time.ts";
import type { JobSpec } from "../types.ts";

export const pollInvolvement: JobSpec = {
  name: "poll:involvement",
  schedule: { everyMinutes: 60 },
  async run(ctx) {
    const cfg = ctx.config.github.involvement;
    if (!cfg.enabled) return "disabled";

    const cached = await ctx.store.kvGet(LOGIN_KV);
    const login = cached && isValidLogin(cached) ? cached : undefined;
    const previous = parseSnapshot(await ctx.store.kvGet(INVOLVEMENT_KV));
    const now = ctx.clock.now().toISOString();

    // A throw here (rate limit, expired token, every query failing) propagates before anything is written:
    // the last good note and kv snapshot survive.
    const snap = await fetchInvolvement({
      token: await ctx.githubToken(),
      login,
      maxPerBucket: cfg.maxPerBucket,
      exclude: [ctx.env("VAULT_REPO")].filter((v): v is string => !!v),
      previous,
      now,
      fetch: ctx.fetch,
    });

    if (!login) await ctx.store.kvSet(LOGIN_KV, snap.login, now);
    await ctx.store.kvSet(INVOLVEMENT_KV, serialiseSnapshot(snap), now);
    const changed = await ctx.vault.writeFiles(`poll:involvement ${localDate(ctx.clock)}`, [
      { path: INVOLVEMENT_NOTE_PATH, content: renderInvolvementNote(snap, cfg.maxPerBucket) },
    ]);
    return (
      `login=${snap.login} review=${snap.reviewRequests.length} assigned=${snap.assignedIssues.length} ` +
      `prs=${snap.myOpenPrs.length} mentions=${snap.mentions.length} repos=${snap.recentRepos.length} ` +
      `partial=${snap.partial.length} changed=${changed.length ? 1 : 0}`
    );
  },
};
