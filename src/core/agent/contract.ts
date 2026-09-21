// v3 agent contract: types and constants only, no logic (PLAN_V3 B.3).
// ARCHITECT-OWNED: builder packages import from here and never edit this file.
import type { ChannelId } from "../types.ts";

export const TOOL_NAMES = [
  "create_reminder",
  "reschedule_reminder",
  "cancel_reminder",
  "snooze_reminder",
  "list_reminders",
  "add_tasks",
  "complete_task",
  "drop_task",
  "list_tasks",
  "list_deadlines",
  "github_involvement",
  "search_notes",
  "add_note",
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export const INTENTS = [...TOOL_NAMES, "smalltalk", "help", "unsupported"] as const;
export type Intent = (typeof INTENTS)[number];

/** Tools that write; only these are subject to provenance (spans of the user's own words). */
export const MUTATING: ReadonlySet<ToolName> = new Set<ToolName>([
  "create_reminder",
  "reschedule_reminder",
  "cancel_reminder",
  "snooze_reminder",
  "add_tasks",
  "complete_task",
  "drop_task",
  "add_note",
]);

/** Max tool calls per plan. */
export const MAX_TOOLS = 4;
/** Max add_tasks items per call. */
export const MAX_ITEMS = 10;
/** Max chars of a verbatim span arg (what, when_text, items[].text, ref.text). */
export const MAX_SPAN = 200;
/** Max chars of search_notes.query. */
export const MAX_QUERY = 100;
/** Max chars of add_note.text (a note is longer than a reminder subject, still a verbatim span). */
export const MAX_NOTE = 1000;

/** How a tool names an existing item: a number from the last list on this channel, a span, or the last action. */
export interface Ref {
  index?: number;
  text?: string;
  last?: true;
}

/** Where a reply or a reminder goes. */
export interface Target {
  channel: ChannelId;
  peer: string;
}

export interface ToolCall {
  name: ToolName;
  args: Record<string, unknown>;
}

export interface Plan {
  intent: Intent;
  tools: ToolCall[];
  say: string;
  compose: boolean;
}

export interface ToolResult {
  ok: boolean;
  /** Code-rendered text; the only way an outcome is ever stated. */
  render: string;
  data?: unknown;
  missing?: string[];
  flags?: string[];
  entityId?: string;
  title?: string;
}

/** msg_trace.route values. "reminder" is written by the delivery path (V3-1), "legacy" by the v2 respond path. */
export type Route = "fast" | "dialog" | "plan" | "plan+compose" | "degraded" | "dropped" | "legacy" | "reminder";

export type DegradedReason = "no-brain" | "quota" | "unreachable" | "unparseable";

// Later: handle.ts (V3-2) runAgent(ctx, msg): Promise<InboundResult>
//        degraded.ts (V3-3) degradedReply(ctx, msg, reason: DegradedReason): Promise<string>
