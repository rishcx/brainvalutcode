import type { JobSpec } from "../types.ts";
import { buildIndex } from "./build.ts";

export const indexVault: JobSpec = {
  name: "index:vault",
  schedule: { everyMinutes: 30 },
  async run(ctx) {
    const s = await buildIndex(ctx);
    return `indexed=${s.indexed} removed=${s.removed} unchanged=${s.unchanged} pending=${s.pending}`;
  },
};
