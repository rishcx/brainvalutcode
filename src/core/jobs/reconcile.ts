// 15-minute catch-up: (re)materialise every deadline's reminder rows, and purge old trace rows once per local day.
import { materialiseAll } from "../reminders/engine.ts";
import { DAY, localDate } from "../time.ts";
import type { JobSpec } from "../types.ts";

const purgedKey = (date: string): string => `trace:purged:${date}`;

export const reconcileReminders: JobSpec = {
  name: "reminders:reconcile",
  schedule: { everyMinutes: 15 },
  async run(ctx) {
    const materialised = await materialiseAll(ctx);

    const now = ctx.clock.now();
    const today = localDate(ctx.clock);
    const key = purgedKey(today);
    let purged = 0;
    if (!(await ctx.store.kvGet(key))) {
      try {
        const cutoff = new Date(now.getTime() - ctx.config.chat.traceRetainDays * DAY).toISOString();
        purged = await ctx.store.purgeTraceBefore(cutoff);
        await ctx.store.cachePurge(now.toISOString());
      } catch {
        purged = 0; // never let a trace-purge failure fail the job
      }
      await ctx.store.kvSet(key, now.toISOString(), now.toISOString());
    }

    return `materialised=${materialised} purged=${purged}`;
  },
};
