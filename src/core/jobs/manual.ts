import { extractFromManualNotes } from "../deadlines/extract.ts";
import { upsertAndMaterialise } from "../reminders/engine.ts";
import { localDate } from "../time.ts";
import type { JobSpec } from "../types.ts";
import { deadlineFiles } from "./github.ts";

/**
 * Human-authored `Deadlines/manual/*.md` -> deadlines. Its own job so manual reminders work with Gmail
 * off; the note is the source of truth, so a deleted note retires its deadline.
 */
export const syncManual: JobSpec = {
  name: "sync:manual",
  schedule: { everyMinutes: 15 },
  async run(ctx) {
    const found = await extractFromManualNotes(ctx);
    await upsertAndMaterialise(ctx, found);
    const staled = await ctx.store.markStale("manual:", found.map((d) => d.id));
    const changed = await ctx.vault.writeFiles(`sync:manual ${localDate(ctx.clock)}`, await deadlineFiles(ctx));
    return `manual=${found.length} staled=${staled} changed=${changed.length}`;
  },
};
