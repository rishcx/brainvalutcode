import { localDate } from "../time.ts";
import type { AgentContext } from "../types.ts";
import { instantiateTemplate } from "./service.ts";
import { restoreFromVault, syncTaskNotes } from "./vaultSync.ts";

/**
 * Idempotent per local day. The kv gate is set LAST, after the vault write, so a failed write can be retried:
 * every store step is safe to repeat (PK-guarded instances; rollOpenTasks only moves due_date < today).
 * Missed days: one roll (rollCount + 1), today's instance only, no back-fill.
 */
export async function rollover(ctx: AgentContext): Promise<string> {
  const today = localDate(ctx.clock);
  const nowIso = ctx.clock.now().toISOString();
  if ((await ctx.store.kvGet("tasks:rolledFor")) === today) return "already rolled";
  if ((await ctx.store.listTasks()).length === 0) await restoreFromVault(ctx);
  const moved = await ctx.store.rollOpenTasks(today, nowIso);
  let instantiated = 0;
  for (const tpl of await ctx.store.listTasks({ status: ["template"] })) {
    if (await instantiateTemplate(ctx, tpl, today)) instantiated++;
  }
  const changed = await syncTaskNotes(ctx);
  await ctx.store.kvSet("tasks:rolledFor", today, nowIso);
  return `rolled ${moved}, instantiated ${instantiated}, wrote ${changed.length} files`;
}
