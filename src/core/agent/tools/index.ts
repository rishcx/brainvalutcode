// Tool registry (PLAN_V3 B.3). Every executor renders its own outcome text; none throws (wrapped here).
import type { AgentContext, DialogState, InboundMessage } from "../../types.ts";
import type { Target, ToolName, ToolResult } from "../contract.ts";
import { addNote } from "./notes.ts";
import { githubInvolvement, listDeadlines, searchNotes } from "./read.ts";
import { cancelReminder, createReminderTool, listReminders, rescheduleReminder, snoozeReminderTool } from "./reminders.ts";
import { addTasks, completeTaskTool, dropTaskTool, listTasks } from "./tasks.ts";

export interface ToolEnv {
  msg: InboundMessage;
  who: Target;
  /** Provenance set: the current message + the user's own dialog answers. Never memory or tool data. */
  sources: string[];
  dialog: DialogState | null;
  now: Date;
  /** Position of this call in the plan: keeps ids unique when one message creates two reminders. */
  index?: number;
}

export type ToolFn = (ctx: AgentContext, args: Record<string, unknown>, env: ToolEnv) => Promise<ToolResult>;

/** Missing-slot results carry the slots gathered so far here, for the dialog row. */
export interface MissingData {
  slots: Record<string, unknown>;
}

function safe(fn: ToolFn): ToolFn {
  return async (ctx, args, env) => {
    try {
      return await fn(ctx, args, env);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      return { ok: false, render: "Something went wrong with that. Nothing was changed.", flags: [`tool_error:${m.slice(0, 60)}`] };
    }
  };
}

export const TOOLS: Record<ToolName, ToolFn> = {
  create_reminder: safe(createReminderTool),
  reschedule_reminder: safe(rescheduleReminder),
  cancel_reminder: safe(cancelReminder),
  snooze_reminder: safe(snoozeReminderTool),
  list_reminders: safe(listReminders),
  add_tasks: safe(addTasks),
  complete_task: safe(completeTaskTool),
  drop_task: safe(dropTaskTool),
  list_tasks: safe(listTasks),
  list_deadlines: safe(listDeadlines),
  github_involvement: safe(githubInvolvement),
  search_notes: safe(searchNotes),
  add_note: safe(addNote),
};
