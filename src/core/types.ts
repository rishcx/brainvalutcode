// The seams. Everything else is written against these; keep them small.
// ARCHITECT-OWNED: builder packages import from here and never edit this file.

/* ------------------------------------------------------------------ time */

export interface Clock {
  now(): Date;
  readonly tz: string;
}

/* --------------------------------------------------------------- network */

/** Every module that talks to the network takes one of these so tests can hand it a fake. */
export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/** Reads a secret by name. Core never touches process.env directly. */
export type EnvReader = (name: string) => string | undefined;

/* --------------------------------------------------------------- domain */

export type DeadlineSource = "github" | "gmail" | "manual" | "chat";

export type DeadlineStatus = "open" | "done" | "dismissed" | "proposed" | "stale";

export interface Deadline {
  id: string; // stable dedupe key, e.g. gh:milestone:owner/repo:3
  source: DeadlineSource;
  sourceRef: string; // URL or path a human can follow
  title: string;
  dueAt: string; // ISO 8601 UTC. Date-only sources go through time.ts#dueAtFromLocalDate.
  status: DeadlineStatus;
  confidence: number; // 1.0 = deterministic, <1 = LLM-extracted (always status "proposed")
  notePath: string;
  /** Resolved by reminders/rules.ts#categorise. Undefined on pre-v2 rows = "default". */
  category?: CategoryId;
  /** True when the source gave a real clock time; false/undefined when dueHourLocal applied. */
  timed?: boolean;
  /** v3: chat-created only; null/undefined = config.channels.defaultChannel. */
  originChannel?: ChannelId | null;
  originPeer?: string | null;
}

/** A materialised reminder row. One per (deadline, offset); UNIQUE enforced by the schema. */
export interface Reminder {
  id: number;
  deadlineId: string;
  kind: string; // offset label from config, e.g. "7d" | "2d" | "24h" | "3h" | "0"
  fireAt: string; // ISO 8601 UTC, already shifted out of quiet hours
  sentAt: string | null;
  createdAt: string;
  /** v3 delivery lease/retry (store.claimReminders / finishReminder). Legacy rows: null / 0 / null. */
  claimedAt?: string | null;
  attempts?: number;
  lastError?: string | null;
}

export interface NewReminder {
  deadlineId: string;
  kind: string;
  fireAt: string;
}

export interface JobRow {
  name: string;
  nextRunAt: string; // ISO 8601 UTC
  lastRunAt: string | null;
  lastStatus: string | null;
  lastDetail: string | null;
}

/* ------------------------------------------------------------- categories */

/** A reminder-rule id, e.g. "flight" | "github" | "assignment" | "default". */
export type CategoryId = string;

export interface ReminderRule {
  id: CategoryId;
  /** Offsets for this category, parsed by time.ts#parseOffset. Empty = use reminders.offsets. */
  offsets: string[];
  /** Lowercase substrings matched against the normalised haystack. */
  keywords: string[];
  /** Restrict the rule to these sources. Absent/empty = any source. */
  sources?: DeadlineSource[];
  /** A date-only input must be refused (ask for a time) instead of defaulting to dueHourLocal. */
  needsTime?: boolean;
}

/* ------------------------------------------------------------------ tasks */

export type TaskStatus = "open" | "done" | "dropped" | "template";

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  /** YYYY-MM-DD local: the day this task currently sits on. */
  dueDate: string;
  /** YYYY-MM-DD local: when it was created. */
  createdDate: string;
  /** YYYY-MM-DD local: the day it was FIRST due. Never changes — used for carry-over age. */
  firstDate: string;
  rollCount: number;
  doneAt: string | null; // ISO 8601 UTC
  /** null | "daily" | "weekdays" | "weekly:MO,WE,FR". Non-null only on status "template". */
  recurrence: string | null;
  source: "chat" | "vault" | "recurrence";
  notePath: string;
}

/* ----------------------------------------------------------- chat memory */

export interface ChatTurn {
  id: number;
  channel: ChannelId;
  peer: string;
  /** YYYY-MM-DD in config.timezone. The per-day memory boundary. */
  localDate: string;
  role: "user" | "assistant";
  text: string;
  at: string; // ISO 8601 UTC
}

export type NewChatTurn = Omit<ChatTurn, "id">;

/* ------------------------------------------------------------ note index */

export interface NoteIndexEntry {
  path: string;
  /** Git blob sha from the tree listing: lets the indexer skip unchanged notes. */
  sha: string;
  title: string;
  /** Space-separated, deduped, capped at 400 tokens. */
  tokens: string;
}

export interface NoteIndexRow extends NoteIndexEntry {
  excerpt: string;
  updatedAt: string;
}

/* ------------------------------------------------------ chat list numbering */

/** A typed entry in kv("last:list") so `done 3` can mean a task OR a deadline. */
export interface ListRef {
  k: "d" | "t";
  id: string;
}

/* ------------------------------------------------------ v3: dialog state */

export interface DialogAction {
  tool: string;
  id: string;
  title: string;
  at: string;
}

/** One row per (channel, peer): the slot-filling dialogue (PLAN_V3 B.2). */
export interface DialogState {
  channel: ChannelId;
  peer: string;
  intent: string;
  slots: Record<string, unknown>;
  missing: string[];
  asked: string | null;
  /** The user's own messages in this dialog (provenance set), <= 3 x 300 chars. */
  sources: string[];
  lastAction: DialogAction | null;
  questions: number;
  expiresAt: string;
  updatedAt: string;
  version: number;
}

/* ------------------------------------------------------ v3: message trace */

export type TraceKind = "inbound" | "reminder" | "job";

export interface NewTrace {
  at: string;
  localDate: string;
  kind: TraceKind;
  channel: string;
  peer: string;
  msgKey: string | null;
  route: string;
  intent: string | null;
  toolsJson: string | null;
  llmCalls: number;
  model: string | null;
  provider: string | null;
  replyChars: number;
  replyPreview: string | null;
  delivery: string;
  latencyMs: number;
  stagesJson: string | null;
  flags: string | null;
  error: string | null;
}

export interface TraceRow extends NewTrace {
  id: number;
}

/** Handler -> worker; the worker adds delivery + latency and persists. */
export type TraceDraft = Omit<NewTrace, "delivery" | "latencyMs"> & { stages: Record<string, number> };

export interface InboundResult {
  reply: string | null;
  trace: TraceDraft;
  /** Present only when the caller asked to defer: turn persistence + day summary, to run AFTER the reply is sent. */
  after?: () => Promise<void>;
}

/* ----------------------------------------------------- v3: provider usage */

export interface ProviderUsage {
  day: string;
  provider: string;
  model: string;
  requests: number;
  tokensIn: number;
  tokensOut: number;
  rateLimited: number;
  remainingReq: number | null;
  remainingTok: number | null;
  cooldownUntil: string | null;
  resetAt: string | null;
  updatedAt: string;
}

export type UsageBump = Pick<ProviderUsage, "day" | "provider" | "model"> & {
  requests: number;
  tokensIn: number;
  tokensOut: number;
  rateLimited: number;
  remainingReq?: number | null;
  remainingTok?: number | null;
  cooldownUntil?: string | null;
  resetAt?: string | null;
  atIso: string;
};

/* ---------------------------------------------------------------- store */

/**
 * Derived state only: must be rebuildable from the vault repo or re-fetchable from source.
 * Async because D1 (the Worker implementation) has no synchronous API; SqliteStore just
 * returns already-resolved promises.
 */
export interface Store {
  /** A human-set terminal status (done/dismissed) must survive re-polling. */
  upsertDeadline(d: Deadline): Promise<void>;
  getDeadline(id: string): Promise<Deadline | null>;
  /** Ordered by dueAt then id. `status` filters to the listed statuses. */
  listDeadlines(filter?: { status?: DeadlineStatus[] }): Promise<Deadline[]>;
  setDeadlineStatus(id: string, status: DeadlineStatus): Promise<void>;
  /**
   * Retires deadlines that the source no longer reports. Only ids starting with `idPrefix`
   * are considered, so a poll that skipped a repo cannot stale that repo's rows.
   * Never touches done/dismissed. Returns the number of rows staled.
   */
  markStale(idPrefix: string, presentIds: string[]): Promise<number>;

  /** Idempotent on (deadline_id, kind): re-materialising an unchanged reminder is a no-op. */
  upsertReminder(r: NewReminder): Promise<void>;
  /** Unsent reminders with fireAt <= nowIso, oldest first. */
  dueReminders(nowIso: string): Promise<Reminder[]>;
  markRemindersSent(ids: number[], atIso: string): Promise<void>;
  listReminders(deadlineId: string): Promise<Reminder[]>;
  /** Drops unsent reminders for a deadline (due date moved, or it was completed). */
  deleteUnsentReminders(deadlineId: string): Promise<void>;

  /** INSERT OR IGNORE. Returns true only the first time an id is seen (webhook idempotency). */
  markProcessed(id: string, atIso: string): Promise<boolean>;

  /** Returns null for a miss or an entry whose expiresAt <= nowIso. */
  cacheGet(key: string, nowIso: string): Promise<string | null>;
  cacheSet(key: string, value: string, expiresAtIso: string): Promise<void>;
  cachePurge(nowIso: string): Promise<number>;

  kvGet(key: string): Promise<string | null>;
  kvSet(key: string, value: string, atIso: string): Promise<void>;

  getJob(name: string): Promise<JobRow | null>;
  listJobs(): Promise<JobRow[]>;
  /** Jobs whose nextRunAt <= nowIso. */
  dueJobs(nowIso: string): Promise<JobRow[]>;
  /** Creates the row if missing; never moves an existing nextRunAt. */
  ensureJob(name: string, nextRunAtIso: string): Promise<void>;
  setJobNextRun(name: string, nextRunAtIso: string): Promise<void>;
  recordJobRun(name: string, atIso: string, status: string, detail: string): Promise<void>;

  /* tasks */
  upsertTask(t: Task): Promise<void>;
  getTask(id: string): Promise<Task | null>;
  /** Ordered by due_date, then id. */
  listTasks(f?: { dueDate?: string; dueOnOrBefore?: string; status?: TaskStatus[] }): Promise<Task[]>;
  setTaskStatus(id: string, status: TaskStatus, doneAtIso: string | null): Promise<void>;
  /** Moves every open task with due_date < toDate onto toDate, roll_count += 1. Returns rows moved. */
  rollOpenTasks(toDate: string, nowIso: string): Promise<number>;

  /* chat memory */
  appendTurn(t: NewChatTurn): Promise<void>;
  /** Chronological (oldest first). */
  turnsForDay(channel: ChannelId, peer: string, localDate: string): Promise<ChatTurn[]>;
  /** Deletes turns with local_date < localDate. Returns rows deleted. */
  purgeTurnsBefore(localDate: string): Promise<number>;

  /* vault index */
  /** Every row WITHOUT its excerpt — keeps the scan cheap. Ordered by path. */
  listNoteIndex(): Promise<NoteIndexEntry[]>;
  /** Only the named paths, with excerpts. Empty input returns []. */
  getNoteExcerpts(paths: string[]): Promise<NoteIndexRow[]>;
  upsertNote(n: NoteIndexRow): Promise<void>;
  deleteNotes(paths: string[]): Promise<number>;

  /* v3: dialog state */
  getDialog(channel: ChannelId, peer: string): Promise<DialogState | null>;
  /**
   * CAS. null => insert if absent or expired (expires_at <= d.updatedAt); else update where version = expectVersion.
   * Stored version = previous + 1 (a fresh insert stores 1). false on conflict.
   */
  putDialog(d: Omit<DialogState, "version">, expectVersion: number | null): Promise<boolean>;
  clearDialog(channel: ChannelId, peer: string): Promise<void>;

  /* v3: message trace */
  appendTrace(t: NewTrace): Promise<void>;
  /** Newest first; limit clamped 1..200. */
  listTrace(limit: number): Promise<TraceRow[]>;
  /** Deletes rows with at < atIso. Returns rows deleted. */
  purgeTraceBefore(atIso: string): Promise<number>;

  /* v3: reminder delivery lease */
  /** Sets claim+claimed_at on rows with sent_at IS NULL AND (claimed_at IS NULL OR claimed_at < staleBeforeIso). Returns ids won. */
  claimReminders(ids: number[], claim: string, nowIso: string, staleBeforeIso: string): Promise<number[]>;
  /** Only where claim matches. ok: sent_at = sentAt. error: claim/claimed_at NULL, attempts + 1, last_error = error (<= 200). */
  finishReminder(id: number, claim: string, outcome: { sentAt: string } | { error: string }): Promise<void>;

  /* v3: provider usage */
  /** Rows for one day, ordered by provider, model. */
  getUsage(day: string): Promise<ProviderUsage[]>;
  /** Additive upsert on (day, provider, model); optional fields overwrite only when provided (not undefined). */
  bumpUsage(u: UsageBump): Promise<void>;

  close(): Promise<void>;
}

/* ---------------------------------------------------------------- vault */

export interface VaultFile {
  path: string;
  content: string;
}

/**
 * Reads are NOT gated by the write allowlist: human notes are the Q&A retrieval corpus.
 * Reads are still confined to the vault root (no traversal outside it).
 */
export interface VaultReader {
  readFile(path: string): Promise<string | null>;
  /** Vault-relative paths under `prefix` (recursive), sorted. Excludes dotfiles/dot-dirs. */
  listFiles(prefix?: string): Promise<string[]>;
}

export interface VaultWriter extends VaultReader {
  /**
   * Refuses the whole batch if any path is not agent-owned (vault/paths.ts#assertWritable).
   * Writes only files whose content changed. Returns the changed paths.
   */
  writeFiles(message: string, files: VaultFile[]): Promise<string[]>;
}

/* ---------------------------------------------------------------- brain */

/** `local` entries hold the user's personal quota and must never run unattended. */
export type BrainEntryKind = "omniroute" | "openrouter" | "groq" | "deterministic";

export interface BrainEntry {
  kind: BrainEntryKind;
  /** Stable identifier surfaced by `ask --explain`, e.g. "omniroute" or "openrouter". */
  name: string;
  baseUrl?: string;
  /** Name of the env var holding the API key. Never the key itself. */
  keyEnv?: string;
  /** Ordered: first is primary, rest are same-entry fallbacks. Never hardcode ids in logic. */
  models: string[];
  /** True = Mac/CLI only. Excluded from the chain whenever allowLocalGateway is false. */
  local: boolean;
  /** v3: the provider supports `response_format: json_object`. */
  jsonMode?: boolean;
  /** v3: extra request-body fields; may be a per-model map keyed by model id or "*" (V3-3 extraBodyFor). */
  extraBody?: Record<string, unknown>;
  /** Only use this entry for these request purposes (e.g. ["compose","summary"]). Absent = every purpose. */
  purposes?: string[];
}

export interface BrainRequest {
  prompt: string;
  system?: string;
  maxTokens?: number;
  temperature?: number;
  /** When set, the request asks for JSON and the result text must parse as JSON. */
  jsonSchema?: unknown;
  /** Overrides config.brain.cacheTtlMs. 0 disables both read and write of the cache. */
  cacheTtlMs?: number;
  /** v3: provider JSON mode; sent only when the entry has jsonMode (V3-3). */
  responseFormat?: "json_object";
  /** v3: merged into the request body (never overrides model/messages/max_tokens/response_format). */
  extraBody?: Record<string, unknown>;
  /** v3: per-attempt timeout; never above the budget left. */
  timeoutMs?: number;
  /** v3: plan|compose|summary use the chat budgets (config.chat.llmBudgetMs / perAttemptMs). */
  purpose?: "plan" | "compose" | "summary" | "digest" | "other";
}

export interface BrainResult {
  text: string;
  /** BrainEntry.name that answered; "deterministic" when the final fallback produced it. */
  entry: string;
  model: string;
  cached: boolean;
  ms: number;
  /** v3: token usage reported by the provider. */
  usage?: { in: number; out: number };
  /** v3: rate-limit headers of the answering call. */
  rate?: { remainingReq?: number; remainingTok?: number; resetAt?: string; retryAfterMs?: number };
}

export interface Brain {
  complete(req: BrainRequest): Promise<BrainResult>;
}

/* -------------------------------------------------------------- channels */

export type ChannelId = "telegram" | "whatsapp";

export interface Channel {
  readonly id: ChannelId;
  /** Chunks at 4096 chars and sends in order. Resolves only once every chunk is accepted. */
  send(text: string): Promise<void>;
  /** v3: send to one allowlisted peer only (replies, reminders). */
  sendTo?(peer: string, text: string): Promise<void>;
  /** v3: typing indicator for one peer only. */
  typing?(peer: string): Promise<void>;
}

export interface InboundMessage {
  channel: ChannelId;
  /** Provider message id; the idempotency key for `processed`. */
  id: string;
  /** Chat id / WA id. Must be on the channel's allowlist or the message is dropped. */
  from: string;
  text: string;
  at: string; // ISO 8601 UTC
}

export type Command =
  | { kind: "status" }
  | { kind: "ask"; question: string }
  | { kind: "remind"; title: string; dueAt: string; category: CategoryId; timed: boolean }
  | { kind: "done"; index: number }
  | { kind: "doneNamed"; title: string }
  | { kind: "drop"; index: number }
  | { kind: "confirm"; index: number }
  | { kind: "tasks" }
  | { kind: "addTask"; title: string; recurrence: string | null }
  | { kind: "rules" }
  | { kind: "help" };

/**
 * Handles one verified inbound message and returns the reply text (null = stay silent).
 * Implemented by package C, called by package D's worker and by the CLI.
 */
export type InboundHandler = (ctx: AgentContext, msg: InboundMessage) => Promise<string | null>;

/** The ingress half of a channel: transport auth and payload parsing, both over the RAW body. */
export interface WebhookAdapter {
  /** Constant-time verification (shared secret / HMAC). False => respond 403 and do nothing. */
  verify(req: Request, rawBody: string, ctx: AgentContext): Promise<boolean>;
  /** Parsed messages, already filtered to the configured allowlist. Never throws on junk. */
  parse(rawBody: string, ctx: AgentContext): Promise<InboundMessage[]>;
}

/** Wiring the Worker receives at the integration step; every field is optional until then. */
export interface WorkerDeps {
  telegram?: WebhookAdapter;
  whatsapp?: WebhookAdapter;
  onInbound?: InboundHandler;
  /** v3: preferred over onInbound when set; the worker sends the reply and persists the trace. */
  onInboundV3?: (ctx: AgentContext, msg: InboundMessage) => Promise<InboundResult>;
}

/* ----------------------------------------------------------------- gmail */

/** `format=metadata` only: no body, no attachments, ever. */
export interface GmailMessage {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  date: string; // raw Date header
  snippet: string;
  labelIds: string[];
  internalDate: string; // ms since epoch, as a string
}

/**
 * The ONLY shape a Gmail message may take on its way to an LLM prompt.
 * Every field is already redacted; deterministic date extraction runs on the RAW
 * subject BEFORE this is built, because redact() eats long digit runs.
 */
export interface GmailPayload {
  subject: string;
  from: string;
  date: string;
  snippet: string;
}

/* ---------------------------------------------------------------- github */

export interface Milestone {
  number: number;
  title: string;
  dueOn: string | null;
  openIssues: number;
  url: string;
}

export interface Item {
  number: number;
  title: string;
  url: string;
  updatedAt: string;
  author: string;
}

export interface RepoSnapshot {
  fullName: string;
  private: boolean;
  defaultBranch: string;
  pushedAt: string;
  openIssues: number;
  openPrs: number;
  myOpenPrs: number;
  issues: Item[]; // newest-updated first, capped
  prs: Item[];
  milestones: Milestone[];
}

export interface GithubSnapshot {
  login: string;
  repos: RepoSnapshot[];
  reviewRequested: (Item & { repo: string })[];
  /** Repos the poll asked for but could not read (404/rate limit). Never staled. */
  skipped: string[];
}

/* ---------------------------------------------------------------- config */

export interface QuietHours {
  start: string; // "HH:MM" local
  end: string; // "HH:MM" local
}

export interface Config {
  timezone: string;
  github: { maxRepos: number; repos: string[]; involvement: { enabled: boolean; maxPerBucket: number } };
  brain: {
    entries: BrainEntry[];
    /** Per-call wall budget across the whole chain. */
    budgetMs: number;
    cacheTtlMs: number;
    /** v3: max chat requests per UTC day per entry name; no key = unlimited. */
    dailyBudget: Record<string, number>;
  };
  reminders: {
    /** Offset labels understood by time.ts#parseOffset, e.g. ["7d","2d","24h","3h","0"]. */
    offsets: string[];
    quietHours: QuietHours;
    /** Local hour a date-only deadline is due at. */
    dueHourLocal: number;
    /** Per-category overrides; the top-level `offsets` is the reserved "default" category. */
    rules: ReminderRule[];
  };
  tasks: { enabled: boolean; maxPerDay: number; rolloverLocalTime: string };
  chat: {
    enabled: boolean;
    /** A name; the prompt text lives in brain/prompts.ts. */
    persona: string;
    /**
     * What is written to the vault about your conversations (Threads/<date>.md). "summary" = one short agent-written
     * summary per day (default, more private); "full" = the whole transcript. Conversation memory itself always lives
     * in D1 for retainDays regardless.
     */
    transcript: "summary" | "full";
    memory: { verbatimChars: number; summaryChars: number; summariseAboveChars: number; retainDays: number };
    context: { snapshotChars: number; notesChars: number; userChars: number };
    maxReplyTokens: number;
    /** v3 kill switch: "legacy" keeps the v2 respond path. */
    engine: "v3" | "legacy";
    /** Minutes an idle slot-filling dialog stays active (1..120). */
    dialogTtlMin: number;
    /** Wall budget for one chat LLM chain call (>= 2000). */
    llmBudgetMs: number;
    /** Per-attempt cap inside llmBudgetMs (1000..llmBudgetMs). */
    perAttemptMs: number;
    /** msg_trace retention in days. */
    traceRetainDays: number;
  };
  index: { batch: number; maxNotes: number };
  gmail: { enabled: boolean; query: string; maxMessages: number };
  channels: {
    telegram: { enabled: boolean; allowedChatIds: string[] };
    whatsapp: { enabled: boolean; allowedWaIds: string[]; templateName: string; templateLanguage: string };
    /** v3: where non-chat reminders go (and the fallback target). */
    defaultChannel: ChannelId;
  };
  qa: { maxNotes: number; maxChars: number };
}

/* ------------------------------------------------------------------ jobs */

/** Cadence, evaluated by the single 15-minute cron against the `jobs` table. */
export type Schedule = { everyMinutes: number } | { dailyAtLocal: string };

export interface JobSpec {
  name: string;
  schedule: Schedule;
  run(ctx: AgentContext): Promise<string>;
}

/**
 * Everything a job is allowed to reach. Built by cli.ts (runtime "cli") or worker.ts
 * (runtime "worker"); jobs never construct clients of their own.
 */
export interface AgentContext {
  store: Store;
  vault: VaultWriter;
  clock: Clock;
  fetch: Fetcher;
  config: Config;
  env: EnvReader;
  runtime: "cli" | "worker";
  /** Absent until package A is wired in; jobs must degrade deterministically without it. */
  brain?: Brain;
  /** Absent/empty until package C is wired in; a sweep with no channel is a no-op. */
  channels?: Channel[];
  /** Lazy: jobs that never touch GitHub must not trigger a token lookup. */
  githubToken(): Promise<string>;
  /** Worker only: outbound requests made so far in this invocation (free plan allows 50). */
  requestCount?(): number;
}

/* ------------------------------------------------- cloudflare (minimal) */
// Hand-rolled instead of @cloudflare/workers-types: zero runtime deps, and D1Store
// implements Store, so the shapes are part of the shared contract.

export interface D1Result<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta?: { changes?: number; last_row_id?: number };
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>;
  exec(query: string): Promise<{ count: number; duration: number }>;
}

export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

export interface ScheduledController {
  readonly scheduledTime: number;
  readonly cron: string;
}
