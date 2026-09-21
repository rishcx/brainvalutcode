import type { AgentContext, JobSpec } from "../types.ts";
import { rollover } from "../tasks/rollover.ts";

export const rolloverTasks: JobSpec = {
  name: "rollover:tasks",
  schedule: { dailyAtLocal: "03:00" },
  async run(ctx: AgentContext): Promise<string> {
    if (!ctx.config.tasks.enabled) return "disabled";
    return rollover(ctx);
  },
};
