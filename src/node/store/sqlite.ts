// Node-only: node:sqlite cannot run in a Worker, so this lives outside src/core/**.
// The Worker's D1Store implements the same Store interface against the same schema.sql.
// ARCHITECT-OWNED: builder packages import from here and never edit this file.
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type {
  Clock,
  Deadline,
  DeadlineStatus,
  ChannelId,
  ChatTurn,
  DialogAction,
  DialogState,
  JobRow,
  NewTrace,
  ProviderUsage,
  NewChatTurn,
  NewReminder,
  NoteIndexEntry,
  NoteIndexRow,
  Reminder,
  Store,
  Task,
  TaskStatus,
  TraceRow,
  UsageBump,
} from "../../core/types.ts";

export const SCHEMA_URL = new URL("../../core/store/schema.sql", import.meta.url);
const SCHEMA = readFileSync(SCHEMA_URL, "utf8");

interface DeadlineRow {
  id: string;
  source: Deadline["source"];
  source_ref: string;
  title: string;
  due_at: string;
  status: DeadlineStatus;
  confidence: number;
  note_path: string;
  category: string;
  timed: number;
  origin_channel: ChannelId | null;
  origin_peer: string | null;
}

interface ReminderRow {
  id: number;
  deadline_id: string;
  kind: string;
  fire_at: string;
  sent_at: string | null;
  created_at: string;
  claimed_at: string | null;
  attempts: number | null;
  last_error: string | null;
}

interface JobSqlRow {
  name: string;
  next_run_at: string;
  last_run_at: string | null;
  last_status: string | null;
  last_detail: string | null;
}

const toDeadline = (r: DeadlineRow): Deadline => ({
  id: r.id,
  source: r.source,
  sourceRef: r.source_ref,
  title: r.title,
  dueAt: r.due_at,
  status: r.status,
  confidence: r.confidence,
  notePath: r.note_path,
  category: r.category,
  timed: Number(r.timed) === 1,
  originChannel: r.origin_channel ?? null,
  originPeer: r.origin_peer ?? null,
});

const toReminder = (r: ReminderRow): Reminder => ({
  id: r.id,
  deadlineId: r.deadline_id,
  kind: r.kind,
  fireAt: r.fire_at,
  sentAt: r.sent_at,
  createdAt: r.created_at,
  claimedAt: r.claimed_at ?? null,
  attempts: Number(r.attempts ?? 0),
  lastError: r.last_error ?? null,
});

const toJob = (r: JobSqlRow): JobRow => ({
  name: r.name,
  nextRunAt: r.next_run_at,
  lastRunAt: r.last_run_at,
  lastStatus: r.last_status,
  lastDetail: r.last_detail,
});


interface TaskRow {
  id: string;
  title: string;
  status: TaskStatus;
  due_date: string;
  created_date: string;
  first_date: string;
  roll_count: number;
  done_at: string | null;
  recurrence: string | null;
  source: Task["source"];
  note_path: string;
}

interface TurnRow {
  id: number;
  channel: ChannelId;
  peer: string;
  local_date: string;
  role: ChatTurn["role"];
  text: string;
  at: string;
}

interface NoteRow {
  path: string;
  sha: string;
  title: string;
  tokens: string;
  excerpt: string;
  updated_at: string;
}

const toTask = (r: TaskRow): Task => ({
  id: r.id,
  title: r.title,
  status: r.status,
  dueDate: r.due_date,
  createdDate: r.created_date,
  firstDate: r.first_date,
  rollCount: Number(r.roll_count),
  doneAt: r.done_at,
  recurrence: r.recurrence,
  source: r.source,
  notePath: r.note_path,
});

const toTurn = (r: TurnRow): ChatTurn => ({
  id: Number(r.id),
  channel: r.channel,
  peer: r.peer,
  localDate: r.local_date,
  role: r.role,
  text: r.text,
  at: r.at,
});

const toNote = (r: NoteRow): NoteIndexRow => ({
  path: r.path,
  sha: r.sha,
  title: r.title,
  tokens: r.tokens,
  excerpt: r.excerpt,
  updatedAt: r.updated_at,
});

interface DialogRow {
  channel: ChannelId;
  peer: string;
  intent: string;
  slots_json: string;
  missing_json: string;
  asked: string | null;
  sources_json: string;
  last_action_json: string | null;
  questions: number;
  expires_at: string;
  updated_at: string;
  version: number;
}

interface TraceSqlRow {
  id: number;
  at: string;
  local_date: string;
  kind: TraceRow["kind"];
  channel: string;
  peer: string;
  msg_key: string | null;
  route: string;
  intent: string | null;
  tools_json: string | null;
  llm_calls: number;
  model: string | null;
  provider: string | null;
  reply_chars: number;
  reply_preview: string | null;
  delivery: string;
  latency_ms: number;
  stages_json: string | null;
  flags: string | null;
  error: string | null;
}

interface UsageRow {
  day: string;
  provider: string;
  model: string;
  requests: number;
  tokens_in: number;
  tokens_out: number;
  rate_limited: number;
  remaining_req: number | null;
  remaining_tok: number | null;
  cooldown_until: string | null;
  reset_at: string | null;
  updated_at: string;
}

/** A corrupt JSON column must not take the whole dialog down: fall back to the empty shape. */
function parseJson<T>(raw: string | null, fb: T, ok: (v: unknown) => boolean): T {
  if (raw === null) return fb;
  try {
    const v: unknown = JSON.parse(raw);
    return ok(v) ? (v as T) : fb;
  } catch {
    return fb;
  }
}

const isObj = (v: unknown): boolean => !!v && typeof v === "object" && !Array.isArray(v);
const isStrs = (v: unknown): boolean => Array.isArray(v) && v.every((x) => typeof x === "string");

const toDialog = (r: DialogRow): DialogState => ({
  channel: r.channel,
  peer: r.peer,
  intent: r.intent,
  slots: parseJson<Record<string, unknown>>(r.slots_json, {}, isObj),
  missing: parseJson<string[]>(r.missing_json, [], isStrs),
  asked: r.asked,
  sources: parseJson<string[]>(r.sources_json, [], isStrs),
  lastAction: parseJson<DialogAction | null>(r.last_action_json, null, isObj),
  questions: Number(r.questions),
  expiresAt: r.expires_at,
  updatedAt: r.updated_at,
  version: Number(r.version),
});

const toTrace = (r: TraceSqlRow): TraceRow => ({
  id: Number(r.id),
  at: r.at,
  localDate: r.local_date,
  kind: r.kind,
  channel: r.channel,
  peer: r.peer,
  msgKey: r.msg_key,
  route: r.route,
  intent: r.intent,
  toolsJson: r.tools_json,
  llmCalls: Number(r.llm_calls),
  model: r.model,
  provider: r.provider,
  replyChars: Number(r.reply_chars),
  replyPreview: r.reply_preview,
  delivery: r.delivery,
  latencyMs: Number(r.latency_ms),
  stagesJson: r.stages_json,
  flags: r.flags,
  error: r.error,
});

const numOrNull = (v: number | null): number | null => (v === null ? null : Number(v));

const toUsage = (r: UsageRow): ProviderUsage => ({
  day: r.day,
  provider: r.provider,
  model: r.model,
  requests: Number(r.requests),
  tokensIn: Number(r.tokens_in),
  tokensOut: Number(r.tokens_out),
  rateLimited: Number(r.rate_limited),
  remainingReq: numOrNull(r.remaining_req),
  remainingTok: numOrNull(r.remaining_tok),
  cooldownUntil: r.cooldown_until,
  resetAt: r.reset_at,
  updatedAt: r.updated_at,
});

/** listTrace bounds. */
const clampTraceLimit = (n: number): number => Math.min(200, Math.max(1, Math.trunc(n) || 1));

/** Column order shared by every dialog write. */
const DIALOG_COLS =
  "channel, peer, intent, slots_json, missing_json, asked, sources_json, last_action_json, questions, expires_at, updated_at";

const dialogArgs = (d: Omit<DialogState, "version">): unknown[] => [
  d.channel,
  d.peer,
  d.intent,
  JSON.stringify(d.slots ?? {}),
  JSON.stringify(d.missing ?? []),
  d.asked ?? null,
  JSON.stringify(d.sources ?? []),
  d.lastAction ? JSON.stringify(d.lastAction) : null,
  Math.trunc(d.questions ?? 0),
  d.expiresAt,
  d.updatedAt,
];

/** Insert when absent (version 1); take over an expired row (version + 1); otherwise a no-op (0 changes). */
const PUT_DIALOG_NEW = `INSERT INTO dialog (${DIALOG_COLS}, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  ON CONFLICT(channel, peer) DO UPDATE SET
    intent = excluded.intent, slots_json = excluded.slots_json, missing_json = excluded.missing_json,
    asked = excluded.asked, sources_json = excluded.sources_json, last_action_json = excluded.last_action_json,
    questions = excluded.questions, expires_at = excluded.expires_at, updated_at = excluded.updated_at,
    version = dialog.version + 1
  WHERE dialog.expires_at <= excluded.updated_at`;

const PUT_DIALOG_CAS = `UPDATE dialog SET
    intent = ?, slots_json = ?, missing_json = ?, asked = ?, sources_json = ?, last_action_json = ?,
    questions = ?, expires_at = ?, updated_at = ?, version = version + 1
  WHERE channel = ? AND peer = ? AND version = ?`;

/** [sql args for PUT_DIALOG_CAS] given the dialog and the expected version. */
const casArgs = (d: Omit<DialogState, "version">, v: number): unknown[] => {
  const a = dialogArgs(d);
  return [...a.slice(2), d.channel, d.peer, v];
};

const TRACE_INSERT = `INSERT INTO msg_trace (at, local_date, kind, channel, peer, msg_key, route, intent, tools_json, llm_calls,
    model, provider, reply_chars, reply_preview, delivery, latency_ms, stages_json, flags, error)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const traceArgs = (t: NewTrace): unknown[] => [
  t.at,
  t.localDate,
  t.kind,
  t.channel,
  t.peer,
  t.msgKey ?? null,
  t.route,
  t.intent ?? null,
  t.toolsJson ?? null,
  Math.trunc(t.llmCalls ?? 0),
  t.model ?? null,
  t.provider ?? null,
  Math.trunc(t.replyChars ?? 0),
  t.replyPreview ?? null,
  t.delivery,
  Math.max(0, Math.round(t.latencyMs ?? 0)),
  t.stagesJson ?? null,
  t.flags ?? null,
  t.error ?? null,
];

/** Counters add; each optional field overwrites only when its "provided" flag is 1. */
const BUMP_USAGE = `INSERT INTO provider_usage (day, provider, model, requests, tokens_in, tokens_out, rate_limited,
    remaining_req, remaining_tok, cooldown_until, reset_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(day, provider, model) DO UPDATE SET
    requests = provider_usage.requests + excluded.requests,
    tokens_in = provider_usage.tokens_in + excluded.tokens_in,
    tokens_out = provider_usage.tokens_out + excluded.tokens_out,
    rate_limited = provider_usage.rate_limited + excluded.rate_limited,
    remaining_req = CASE WHEN ? = 1 THEN excluded.remaining_req ELSE provider_usage.remaining_req END,
    remaining_tok = CASE WHEN ? = 1 THEN excluded.remaining_tok ELSE provider_usage.remaining_tok END,
    cooldown_until = CASE WHEN ? = 1 THEN excluded.cooldown_until ELSE provider_usage.cooldown_until END,
    reset_at = CASE WHEN ? = 1 THEN excluded.reset_at ELSE provider_usage.reset_at END,
    updated_at = excluded.updated_at`;

const has = (v: unknown): number => (v === undefined ? 0 : 1);
const int = (v: number | null | undefined): number | null =>
  typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null;

const usageArgs = (u: UsageBump): unknown[] => [
  u.day,
  u.provider,
  u.model,
  int(u.requests) ?? 0,
  int(u.tokensIn) ?? 0,
  int(u.tokensOut) ?? 0,
  int(u.rateLimited) ?? 0,
  int(u.remainingReq),
  int(u.remainingTok),
  u.cooldownUntil ?? null,
  u.resetAt ?? null,
  u.atIso,
  has(u.remainingReq),
  has(u.remainingTok),
  has(u.cooldownUntil),
  has(u.resetAt),
];

/** Newest turns kept per (channel, peer, local_date): a runaway loop must not fill the store. */
const MAX_TURNS_PER_PEER_DAY = 200;

/** `?,?,?` for a variadic IN (...) list. Empty lists are handled by the callers. */
const marks = (n: number): string => new Array(n).fill("?").join(",");

export class SqliteStore implements Store {
  private readonly db: DatabaseSync;
  private readonly clock: Clock;

  /** The clock is injected so stored timestamps are as deterministic as the rest. */
  constructor(file: string, clock: Clock) {
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(SCHEMA);
    this.clock = clock;
  }

  private now(): string {
    return this.clock.now().toISOString();
  }

  /* ------------------------------------------------------------ deadlines */

  async upsertDeadline(d: Deadline): Promise<void> {
    // A human-set terminal status must survive re-polling.
    this.db
      .prepare(
        `INSERT INTO deadlines (id, source, source_ref, title, due_at, status, confidence, note_path, updated_at, category, timed, origin_channel, origin_peer)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           source_ref = excluded.source_ref, title = excluded.title, due_at = excluded.due_at,
           confidence = excluded.confidence, note_path = excluded.note_path, updated_at = excluded.updated_at,
           category = excluded.category, timed = excluded.timed,
           origin_channel = COALESCE(excluded.origin_channel, deadlines.origin_channel),
           origin_peer = COALESCE(excluded.origin_peer, deadlines.origin_peer),
           status = CASE WHEN deadlines.status IN ('done','dismissed') THEN deadlines.status ELSE excluded.status END`,
      )
      .run(
        d.id, d.source, d.sourceRef, d.title, d.dueAt, d.status, d.confidence, d.notePath, this.now(),
        d.category ?? "default", d.timed ? 1 : 0, d.originChannel ?? null, d.originPeer ?? null,
      );
  }

  async getDeadline(id: string): Promise<Deadline | null> {
    const row = this.db.prepare("SELECT * FROM deadlines WHERE id = ?").get(id) as unknown as
      | DeadlineRow
      | undefined;
    return row ? toDeadline(row) : null;
  }

  async listDeadlines(filter?: { status?: DeadlineStatus[] }): Promise<Deadline[]> {
    const st = filter?.status;
    if (st && st.length === 0) return [];
    const sql = st
      ? `SELECT * FROM deadlines WHERE status IN (${marks(st.length)}) ORDER BY due_at, id`
      : "SELECT * FROM deadlines ORDER BY due_at, id";
    const rows = this.db.prepare(sql).all(...(st ?? [])) as unknown as DeadlineRow[];
    return rows.map(toDeadline);
  }

  async setDeadlineStatus(id: string, status: DeadlineStatus): Promise<void> {
    this.db
      .prepare("UPDATE deadlines SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, this.now(), id);
  }

  async markStale(idPrefix: string, presentIds: string[]): Promise<number> {
    // substr(), not LIKE: a repo name containing _ or % would make LIKE over-match.
    const sql =
      `UPDATE deadlines SET status = 'stale', updated_at = ?
       WHERE substr(id, 1, ?) = ? AND status IN ('open','proposed')` +
      (presentIds.length ? ` AND id NOT IN (${marks(presentIds.length)})` : "");
    const r = this.db.prepare(sql).run(this.now(), idPrefix.length, idPrefix, ...presentIds);
    return Number(r.changes);
  }

  /* ------------------------------------------------------------ reminders */

  async upsertReminder(r: NewReminder): Promise<void> {
    // Re-materialising an already-sent reminder must not resurrect it, so sent_at is kept.
    this.db
      .prepare(
        `INSERT INTO reminders (deadline_id, kind, fire_at, sent_at, created_at)
         VALUES (?, ?, ?, NULL, ?)
         ON CONFLICT(deadline_id, kind) DO UPDATE SET fire_at = excluded.fire_at`,
      )
      .run(r.deadlineId, r.kind, r.fireAt, this.now());
  }

  async dueReminders(nowIso: string): Promise<Reminder[]> {
    const rows = this.db
      .prepare("SELECT * FROM reminders WHERE sent_at IS NULL AND fire_at <= ? ORDER BY fire_at, id")
      .all(nowIso) as unknown as ReminderRow[];
    return rows.map(toReminder);
  }

  async markRemindersSent(ids: number[], atIso: string): Promise<void> {
    if (!ids.length) return;
    this.db
      .prepare(`UPDATE reminders SET sent_at = ? WHERE id IN (${marks(ids.length)}) AND sent_at IS NULL`)
      .run(atIso, ...ids);
  }

  async listReminders(deadlineId: string): Promise<Reminder[]> {
    const rows = this.db
      .prepare("SELECT * FROM reminders WHERE deadline_id = ? ORDER BY fire_at, id")
      .all(deadlineId) as unknown as ReminderRow[];
    return rows.map(toReminder);
  }

  async deleteUnsentReminders(deadlineId: string): Promise<void> {
    this.db.prepare("DELETE FROM reminders WHERE deadline_id = ? AND sent_at IS NULL").run(deadlineId);
  }

  /* ------------------------------------------------------------ processed */

  async markProcessed(id: string, atIso: string): Promise<boolean> {
    const r = this.db.prepare("INSERT OR IGNORE INTO processed (id, at) VALUES (?, ?)").run(id, atIso);
    return Number(r.changes) === 1;
  }

  /* ---------------------------------------------------------------- cache */

  async cacheGet(key: string, nowIso: string): Promise<string | null> {
    const row = this.db
      .prepare("SELECT value FROM cache WHERE key = ? AND expires_at > ?")
      .get(key, nowIso) as unknown as { value: string } | undefined;
    return row ? row.value : null;
  }

  async cacheSet(key: string, value: string, expiresAtIso: string): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO cache (key, value, expires_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`,
      )
      .run(key, value, expiresAtIso);
  }

  async cachePurge(nowIso: string): Promise<number> {
    return Number(this.db.prepare("DELETE FROM cache WHERE expires_at <= ?").run(nowIso).changes);
  }

  /* ------------------------------------------------------------------- kv */

  async kvGet(key: string): Promise<string | null> {
    const row = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as unknown as
      | { value: string }
      | undefined;
    return row ? row.value : null;
  }

  async kvSet(key: string, value: string, atIso: string): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, atIso);
  }

  /* ----------------------------------------------------------------- jobs */

  async getJob(name: string): Promise<JobRow | null> {
    const row = this.db.prepare("SELECT * FROM jobs WHERE name = ?").get(name) as unknown as
      | JobSqlRow
      | undefined;
    return row ? toJob(row) : null;
  }

  async listJobs(): Promise<JobRow[]> {
    return (this.db.prepare("SELECT * FROM jobs ORDER BY name").all() as unknown as JobSqlRow[]).map(toJob);
  }

  async dueJobs(nowIso: string): Promise<JobRow[]> {
    const rows = this.db
      .prepare("SELECT * FROM jobs WHERE next_run_at <= ? ORDER BY next_run_at, name")
      .all(nowIso) as unknown as JobSqlRow[];
    return rows.map(toJob);
  }

  async ensureJob(name: string, nextRunAtIso: string): Promise<void> {
    this.db.prepare("INSERT OR IGNORE INTO jobs (name, next_run_at) VALUES (?, ?)").run(name, nextRunAtIso);
  }

  async setJobNextRun(name: string, nextRunAtIso: string): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO jobs (name, next_run_at) VALUES (?, ?)
         ON CONFLICT(name) DO UPDATE SET next_run_at = excluded.next_run_at`,
      )
      .run(name, nextRunAtIso);
  }

  async recordJobRun(name: string, atIso: string, status: string, detail: string): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO jobs (name, next_run_at, last_run_at, last_status, last_detail) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           last_run_at = excluded.last_run_at, last_status = excluded.last_status, last_detail = excluded.last_detail`,
      )
      .run(name, atIso, atIso, status, detail.slice(0, 500));
  }

  /* ---------------------------------------------------------------- tasks */

  async upsertTask(t: Task): Promise<void> {
    // created_date and first_date are set on insert and never updated.
    this.db
      .prepare(
        `INSERT INTO tasks (id, title, status, due_date, created_date, first_date, roll_count, done_at, recurrence, source, note_path, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title, status = excluded.status, due_date = excluded.due_date,
           roll_count = excluded.roll_count, done_at = excluded.done_at, recurrence = excluded.recurrence,
           source = excluded.source, note_path = excluded.note_path, updated_at = excluded.updated_at`,
      )
      .run(t.id, t.title, t.status, t.dueDate, t.createdDate, t.firstDate, t.rollCount, t.doneAt, t.recurrence, t.source, t.notePath, this.now());
  }

  async getTask(id: string): Promise<Task | null> {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as unknown as TaskRow | undefined;
    return row ? toTask(row) : null;
  }

  async listTasks(f?: { dueDate?: string; dueOnOrBefore?: string; status?: TaskStatus[] }): Promise<Task[]> {
    const w: string[] = [];
    const args: unknown[] = [];
    if (f?.status) {
      if (f.status.length === 0) return [];
      w.push(`status IN (${marks(f.status.length)})`);
      args.push(...f.status);
    }
    if (f?.dueDate !== undefined) {
      w.push("due_date = ?");
      args.push(f.dueDate);
    } else if (f?.dueOnOrBefore !== undefined) {
      w.push("due_date <= ?");
      args.push(f.dueOnOrBefore);
    }
    const sql = `SELECT * FROM tasks${w.length ? ` WHERE ${w.join(" AND ")}` : ""} ORDER BY due_date, id`;
    const rows = this.db.prepare(sql).all(...(args as never[])) as unknown as TaskRow[];
    return rows.map(toTask);
  }

  async setTaskStatus(id: string, status: TaskStatus, doneAtIso: string | null): Promise<void> {
    this.db
      .prepare("UPDATE tasks SET status = ?, done_at = ?, updated_at = ? WHERE id = ?")
      .run(status, doneAtIso, this.now(), id);
  }

  async rollOpenTasks(toDate: string, nowIso: string): Promise<number> {
    const r = this.db
      .prepare(
        "UPDATE tasks SET due_date = ?, roll_count = roll_count + 1, updated_at = ? WHERE status = 'open' AND due_date < ?",
      )
      .run(toDate, nowIso, toDate);
    return Number(r.changes);
  }

  /* ----------------------------------------------------------- chat memory */

  async appendTurn(t: NewChatTurn): Promise<void> {
    this.db
      .prepare("INSERT INTO chat_turns (channel, peer, local_date, role, text, at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(t.channel, t.peer, t.localDate, t.role, t.text, t.at);
    this.db
      .prepare(
        `DELETE FROM chat_turns WHERE channel = ? AND peer = ? AND local_date = ?
         AND id NOT IN (SELECT id FROM chat_turns WHERE channel = ? AND peer = ? AND local_date = ? ORDER BY at DESC, id DESC LIMIT ?)`,
      )
      .run(t.channel, t.peer, t.localDate, t.channel, t.peer, t.localDate, MAX_TURNS_PER_PEER_DAY);
  }

  async turnsForDay(channel: ChannelId, peer: string, localDate: string): Promise<ChatTurn[]> {
    const rows = this.db
      .prepare("SELECT * FROM chat_turns WHERE channel = ? AND peer = ? AND local_date = ? ORDER BY at, id")
      .all(channel, peer, localDate) as unknown as TurnRow[];
    return rows.map(toTurn);
  }

  async purgeTurnsBefore(localDate: string): Promise<number> {
    return Number(this.db.prepare("DELETE FROM chat_turns WHERE local_date < ?").run(localDate).changes);
  }

  /* ----------------------------------------------------------- note index */

  async listNoteIndex(): Promise<NoteIndexEntry[]> {
    return this.db.prepare("SELECT path, sha, title, tokens FROM note_index ORDER BY path").all() as unknown as NoteIndexEntry[];
  }

  async getNoteExcerpts(paths: string[]): Promise<NoteIndexRow[]> {
    if (paths.length === 0) return [];
    const rows = this.db
      .prepare(`SELECT * FROM note_index WHERE path IN (${marks(paths.length)}) ORDER BY path`)
      .all(...paths) as unknown as NoteRow[];
    return rows.map(toNote);
  }

  async upsertNote(n: NoteIndexRow): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO note_index (path, sha, title, tokens, excerpt, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           sha = excluded.sha, title = excluded.title, tokens = excluded.tokens,
           excerpt = excluded.excerpt, updated_at = excluded.updated_at`,
      )
      .run(n.path, n.sha, n.title, n.tokens, n.excerpt, n.updatedAt);
  }

  async deleteNotes(paths: string[]): Promise<number> {
    if (paths.length === 0) return 0;
    return Number(this.db.prepare(`DELETE FROM note_index WHERE path IN (${marks(paths.length)})`).run(...paths).changes);
  }

  /* --------------------------------------------------------- dialog (v3) */

  async getDialog(channel: ChannelId, peer: string): Promise<DialogState | null> {
    const row = this.db.prepare("SELECT * FROM dialog WHERE channel = ? AND peer = ?").get(channel, peer) as unknown as
      | DialogRow
      | undefined;
    return row ? toDialog(row) : null;
  }

  async putDialog(d: Omit<DialogState, "version">, expectVersion: number | null): Promise<boolean> {
    const r =
      expectVersion === null
        ? this.db.prepare(PUT_DIALOG_NEW).run(...(dialogArgs(d) as never[]))
        : this.db.prepare(PUT_DIALOG_CAS).run(...(casArgs(d, expectVersion) as never[]));
    return Number(r.changes) === 1;
  }

  async clearDialog(channel: ChannelId, peer: string): Promise<void> {
    this.db.prepare("DELETE FROM dialog WHERE channel = ? AND peer = ?").run(channel, peer);
  }

  /* ----------------------------------------------------------- trace (v3) */

  async appendTrace(t: NewTrace): Promise<void> {
    this.db.prepare(TRACE_INSERT).run(...(traceArgs(t) as never[]));
  }

  async listTrace(limit: number): Promise<TraceRow[]> {
    const rows = this.db
      .prepare("SELECT * FROM msg_trace ORDER BY id DESC LIMIT ?")
      .all(clampTraceLimit(limit)) as unknown as TraceSqlRow[];
    return rows.map(toTrace);
  }

  async purgeTraceBefore(atIso: string): Promise<number> {
    return Number(this.db.prepare("DELETE FROM msg_trace WHERE at < ?").run(atIso).changes);
  }

  /* ----------------------------------------------- reminder delivery (v3) */

  async claimReminders(ids: number[], claim: string, nowIso: string, staleBeforeIso: string): Promise<number[]> {
    if (ids.length === 0) return [];
    this.db
      .prepare(
        `UPDATE reminders SET claim = ?, claimed_at = ?
         WHERE id IN (${marks(ids.length)}) AND sent_at IS NULL AND (claimed_at IS NULL OR claimed_at < ?)`,
      )
      .run(claim, nowIso, ...ids, staleBeforeIso);
    const rows = this.db
      .prepare(`SELECT id FROM reminders WHERE claim = ? AND id IN (${marks(ids.length)}) ORDER BY id`)
      .all(claim, ...ids) as unknown as { id: number }[];
    return rows.map((r) => Number(r.id));
  }

  async finishReminder(id: number, claim: string, outcome: { sentAt: string } | { error: string }): Promise<void> {
    if ("sentAt" in outcome) {
      this.db.prepare("UPDATE reminders SET sent_at = ? WHERE id = ? AND claim = ?").run(outcome.sentAt, id, claim);
      return;
    }
    this.db
      .prepare(
        `UPDATE reminders SET claim = NULL, claimed_at = NULL, attempts = attempts + 1, last_error = ?
         WHERE id = ? AND claim = ?`,
      )
      .run(String(outcome.error).slice(0, 200), id, claim);
  }

  /* ---------------------------------------------------- provider usage (v3) */

  async getUsage(day: string): Promise<ProviderUsage[]> {
    const rows = this.db
      .prepare("SELECT * FROM provider_usage WHERE day = ? ORDER BY provider, model")
      .all(day) as unknown as UsageRow[];
    return rows.map(toUsage);
  }

  async bumpUsage(u: UsageBump): Promise<void> {
    this.db.prepare(BUMP_USAGE).run(...(usageArgs(u) as never[]));
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
