// Turns a parsed ReminderRequest into a stored deadline (and, for explicit requests, live reminder rows).
import type { Target } from "../agent/contract.ts";
import type { AgentContext, Deadline } from "../types.ts";
import { explicitOpts, materialise } from "./engine.ts";
import { loadRules } from "./rules.ts";

export type CreatedReminder = { id: string; dueAt: string; scheduled: number; status: "open" | "proposed" };

/**
 * explicit: status "open", confidence 1, reminders materialised now (the due time, plus the category rule's early
 * offsets that are still ahead; quiet hours do not apply, the user picked the time). Throws RangeError when an
 * explicit due time is already past: the parser never produces one, so this is a caller bug, never a silent late ping.
 * not explicit: status "proposed", confidence 0.9, no reminder rows until the user confirms.
 * `origin` (v3): the channel/peer this chat reminder fires on; omitted/undefined = config.channels.defaultChannel.
 */
export async function createReminder(
  ctx: AgentContext,
  r: {
    title: string;
    dueAt: string;
    timed: boolean;
    category: string;
    explicit: boolean;
    relative: boolean;
    id: string;
    sourceRef: string;
    origin?: Target;
  },
): Promise<CreatedReminder> {
  const due = new Date(r.dueAt).getTime();
  if (!Number.isFinite(due)) throw new RangeError(`invalid reminder time: ${r.dueAt}`);
  const nowMs = ctx.clock.now().getTime();
  if (r.explicit && due < nowMs) throw new RangeError("reminder time is in the past");

  const d: Deadline = {
    id: r.id,
    source: "chat",
    sourceRef: r.sourceRef,
    title: r.title,
    dueAt: new Date(due).toISOString(),
    status: r.explicit ? "open" : "proposed",
    confidence: r.explicit ? 1 : 0.9,
    notePath: "Deadlines/index.md",
    category: r.category,
    timed: r.timed,
    originChannel: r.origin?.channel ?? null,
    originPeer: r.origin?.peer ?? null,
  };
  await ctx.store.upsertDeadline(d);
  if (!r.explicit) return { id: d.id, dueAt: d.dueAt, scheduled: 0, status: "proposed" };

  const rules = await loadRules(ctx);
  const scheduled = await materialise(ctx, d, rules, explicitOpts(d, rules, nowMs));
  return { id: d.id, dueAt: d.dueAt, scheduled, status: "open" };
}
