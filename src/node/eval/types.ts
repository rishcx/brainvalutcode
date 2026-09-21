// V3-4 evaluation harness: scenario data shapes and outcomes.
// Scenario/Turn are PLAN_V3 C.1 verbatim, plus:
//  - `requires` (not in C.1): gates a scenario on a not-yet-landed phase (eval.test.ts / run.ts skip it as
//    "not-run" instead of failing) until the named phase's entry point can be imported.
//  - `direct` (not in C.1): PLAN_V3 C.3 notes S1/D5/D6 "may call the jobs directly instead of the handler";
//    when set, runScenario bypasses the Handler entirely and calls this against the seeded AgentContext.
import type {
  AgentContext,
  Brain,
  ChannelId,
  Deadline,
  InboundMessage,
  InboundResult,
  NoteIndexRow,
  Task,
} from "../../core/types.ts";

/** The system under test, injected so the harness builds before V3-2 lands (brief "Contracts"). */
export type Handler = (ctx: AgentContext, msg: InboundMessage) => Promise<InboundResult>;

export interface TurnExpect {
  route?: "fast" | "dialog" | "plan" | "plan+compose" | "degraded";
  /** Exact in fake mode, `<=` in live mode. */
  llmCalls?: number;
  /** Tool names executed (after validation), from the trace's toolsJson. */
  tools?: string[];
  reply?: { includes?: string[]; excludes?: string[]; matches?: string; maxChars?: number };
  db?: {
    /** Open task titles, order-free. */
    tasks?: string[];
    reminders?: { title: string; dueLocal: string; channel?: ChannelId }[];
    /** No task/deadline rows created or removed this turn. */
    noNewRows?: boolean;
  };
  dialog?: { missing?: string[]; cleared?: boolean };
  sentTo?: { channel: ChannelId; peer: string }[];
  /** Messages the reminder job delivered this turn (everything sent except the reply itself): how many, and
   * substrings EVERY one must contain (a fired reminder must say WHAT it is for and how to act on it). */
  delivered?: { count?: number; includes?: string[]; excludes?: string[] };
}

export interface Turn {
  channel?: ChannelId;
  text: string;
  /** Time that passes BEFORE this turn's message: the clock advances, the due-reminder job runs at the new
   * instant (as the minute cron would), then the message is handled. Sweep sends count toward this turn. */
  advanceMs?: number;
  /** Fake-mode PLAN script. A string is returned raw (junk-JSON tests); an array is consumed in order
   * (retry tests); absent => this turn must not call the LLM for "plan". */
  plan?: unknown;
  /** Fake-mode COMPOSE script; absent => this turn must not call the LLM for "compose". */
  compose?: string;
  expect: TurnExpect;
}

export interface ScenarioSeed {
  tasks?: Partial<Task>[];
  deadlines?: Partial<Deadline>[];
  notes?: NoteIndexRow[];
  /** kv `gh:involvement` shape (sources/involvement.ts#InvolvementSnapshot). */
  involvement?: unknown;
  /** kv/store dialog shape (types.ts#DialogState, minus `version`). */
  dialog?: Record<string, unknown>;
}

export interface Scenario {
  id: string;
  tags: string[];
  /** FixedClock instant. */
  at: string;
  tz?: string;
  seed?: ScenarioSeed;
  turns: Turn[];
  /** Gates this scenario until the named phase's entry point exists. See harness.ts#readiness. */
  requires?: "v3-2" | "v3-3";
  /** Edge case (brief): "channels disabled in a scenario's configPatch". Merged over the harness's own
   * base config (chat.engine "v3", both channels enabled); e.g. D4 disables whatsapp to force the fallback. */
  configPatch?: Record<string, unknown>;
  /** U5/U6 "all models 429": run the REAL brain chain (createBrain) with a Groq key present and every Groq model's
   * usage row exhausted until `resetAt`, over a fetch that counts attempts and never reaches the network. llmCalls
   * is then the number of HTTP attempts, so `llmCalls: 0` proves no model was even tried. */
  providerQuota?: { exhausted: true; resetAt: string };
  /** S1/D5/D6: bypass the handler and drive a job/store call directly against the seeded ctx. */
  direct?: (ctx: AgentContext) => Promise<{ failures: string[] }>;
}

export interface TurnOutcome {
  reply: string | null;
  route: string;
  llmCalls: number;
  tools: string[];
  sentTo: { channel: string; peer: string }[];
  /** Texts the reminder job sent this turn (sweep sends; excludes the reply). */
  delivered: string[];
  ms: number;
  failures: string[];
}

export interface ScenarioOutcome {
  id: string;
  status: "pass" | "fail" | "not-run";
  turns: TurnOutcome[];
  calls: number;
}

/** Re-exported so scenario/check modules have one import path for the eval-only Brain alias. */
export type { Brain };
