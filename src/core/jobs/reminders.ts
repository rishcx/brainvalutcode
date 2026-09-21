import { deliverDue } from "../reminders/deliver.ts";
import type { JobSpec } from "../types.ts";

export const sweepReminders: JobSpec = {
  name: "sweep:reminders",
  // Paired with the every-minute cron: materialisation now happens on write (create/confirm/snooze) plus the
  // 15-minute reconcile job, so the minute tick only has to look for rows that are already due (PLAN_V3 B.10/A.11a).
  schedule: { everyMinutes: 1 },
  async run(ctx) {
    const r = await deliverDue(ctx);
    return `sent=${r.sent} failed=${r.failed} targets=${r.targets.join(",") || "none"}`;
  },
};
