// Honest, deterministic replies for when no model answered (PLAN_V3 B.9). Web-standard APIs only.
import { quotaStatus } from "../brain/usage.ts";
import { createReminder } from "../reminders/create.ts";
import { parseReminderRequest } from "../reminders/request.ts";
import { loadRules } from "../reminders/rules.ts";
import { parseTaskCommand } from "../tasks/parse.ts";
import { replyAddTask, replyTasks } from "../tasks/service.ts";
import { localTimeOf } from "../time.ts";
import type { AgentContext, InboundMessage } from "../types.ts";
import type { DegradedReason } from "./contract.ts";

/** Fallback titles parseReminderRequest hands back when the user gave no real subject. */
const GENERIC_TITLES = new Set(["reminder", "timer", "alarm", "default"]);

const CAP_WITH_SNOOZE = "tasks, status, done 2, snooze 10m, remind me in 10 minutes to <thing>.";
const CAP = "tasks, status, done 2, remind me in 10 minutes to <thing>.";
const NO_MODEL = "I couldn't reach my language model just now. Try again in a minute, or use: " + CAP;

const cap = (t: string): string => (t.length > 400 ? t.slice(0, 400) : t);

/**
 * Order (PLAN_V3 B.9 / V3-3): (1) an explicit "remind me..." with a real subject still fires, offline. (2) the old
 * regex task commands still work. (3) otherwise an honest, cause-specific line. Never throws, never markdown,
 * <= 400 chars.
 */
export async function degradedReply(ctx: AgentContext, msg: InboundMessage, reason: DegradedReason): Promise<string> {
  try {
    const text = typeof msg.text === "string" ? msg.text : "";

    const reminder = await tryReminder(ctx, msg, text);
    if (reminder !== null) return reminder;

    const task = await tryTask(ctx, text);
    if (task !== null) return task;

    return honestLine(ctx, reason, await quotaStatus(ctx).catch(() => ({ exhausted: false, resetAt: null })));
  } catch {
    return NO_MODEL;
  }
}

async function tryReminder(ctx: AgentContext, msg: InboundMessage, text: string): Promise<string | null> {
  let req: ReturnType<typeof parseReminderRequest>;
  try {
    const rules = await loadRules(ctx);
    req = parseReminderRequest(text, rules, ctx.config.timezone, ctx.clock.now(), ctx.config.reminders.dueHourLocal);
  } catch {
    return null;
  }
  if (!req || !req.explicit) return null;

  if (GENERIC_TITLES.has(req.title.trim().toLowerCase())) {
    return cap(
      "What should I remind you about? My language model is unavailable, so please say it in one message, e.g. remind me in 10 minutes to call mom.",
    );
  }

  try {
    // origin is an extra field: reminders/create.ts (V3-1) reads it once it lands; harmless until then.
    const args = {
      title: req.title,
      dueAt: req.dueAt,
      timed: req.timed,
      category: req.category,
      explicit: req.explicit,
      relative: req.relative,
      id: `chat:${msg.id}`,
      sourceRef: msg.id,
      origin: { channel: msg.channel, peer: msg.from },
    };
    await createReminder(ctx, args);
    const when = localTimeOf(new Date(req.dueAt), ctx.config.timezone);
    return cap(`Reminder set: ${req.title}, ${when}. (offline mode)`);
  } catch {
    return null; // an invalid/past time: fall through to the honest line rather than crash
  }
}

async function tryTask(ctx: AgentContext, text: string): Promise<string | null> {
  try {
    const cmd = parseTaskCommand(text);
    if (cmd?.kind === "addTask") {
      const out = await replyAddTask(ctx, { title: cmd.title, recurrence: cmd.recurrence });
      return cap(`${out} (offline mode)`);
    }
    if (cmd?.kind === "tasks") return cap(await replyTasks(ctx));
  } catch {
    /* fall through to the honest line */
  }
  return null;
}

function honestLine(ctx: AgentContext, reason: DegradedReason, q: { exhausted: boolean; resetAt: string | null }): string {
  if (reason === "no-brain") return cap(`No language model is configured. You can use: ${CAP}`);
  if (reason === "quota") {
    const until = q.resetAt ? `until about ${localTimeOf(new Date(q.resetAt), ctx.config.timezone)}` : "for a while";
    return cap(`My language model is out of free quota ${until}. Reminders still fire. Meanwhile you can use: ${CAP_WITH_SNOOZE}`);
  }
  return NO_MODEL; // unreachable | unparseable
}
