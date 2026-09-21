-- Single source of truth for both SqliteStore (node:sqlite) and D1.
-- The migrations/*.sql files, applied in filename order, must yield the same schema objects as this
-- file; a test compares normalised sqlite_master rows.
-- D1-safe subset only: CREATE TABLE/INDEX IF NOT EXISTS, TEXT/INTEGER/REAL, no PRAGMA,
-- no triggers, and no time defaults (all timestamps are supplied by the injected Clock).

CREATE TABLE IF NOT EXISTS deadlines (
  id          TEXT PRIMARY KEY,
  source      TEXT NOT NULL,
  source_ref  TEXT NOT NULL,
  title       TEXT NOT NULL,
  due_at      TEXT NOT NULL,
  status      TEXT NOT NULL,
  confidence  REAL NOT NULL,
  note_path   TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  category    TEXT NOT NULL DEFAULT 'default',
  timed       INTEGER NOT NULL DEFAULT 0,
  origin_channel TEXT,
  origin_peer    TEXT
);

CREATE INDEX IF NOT EXISTS deadlines_status_due ON deadlines (status, due_at);

CREATE TABLE IF NOT EXISTS reminders (
  id          INTEGER PRIMARY KEY,
  deadline_id TEXT NOT NULL,
  kind        TEXT NOT NULL,
  fire_at     TEXT NOT NULL,
  sent_at     TEXT,
  created_at  TEXT NOT NULL,
  claimed_at  TEXT,
  claim       TEXT,
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  UNIQUE (deadline_id, kind)
);

CREATE INDEX IF NOT EXISTS reminders_pending ON reminders (sent_at, fire_at);

CREATE TABLE IF NOT EXISTS processed (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cache (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kv (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  name         TEXT PRIMARY KEY,
  next_run_at  TEXT NOT NULL,
  last_run_at  TEXT,
  last_status  TEXT,
  last_detail  TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  status       TEXT NOT NULL,
  due_date     TEXT NOT NULL,
  created_date TEXT NOT NULL,
  first_date   TEXT NOT NULL,
  roll_count   INTEGER NOT NULL DEFAULT 0,
  done_at      TEXT,
  recurrence   TEXT,
  source       TEXT NOT NULL,
  note_path    TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_day ON tasks (due_date, status);

CREATE TABLE IF NOT EXISTS chat_turns (
  id         INTEGER PRIMARY KEY,
  channel    TEXT NOT NULL,
  peer       TEXT NOT NULL,
  local_date TEXT NOT NULL,
  role       TEXT NOT NULL,
  text       TEXT NOT NULL,
  at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_turns_day ON chat_turns (channel, peer, local_date, at);

CREATE TABLE IF NOT EXISTS note_index (
  path       TEXT PRIMARY KEY,
  sha        TEXT NOT NULL,
  title      TEXT NOT NULL,
  tokens     TEXT NOT NULL,
  excerpt    TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- v3 (migrations/0003_v3.sql): dialog state, message trace, provider usage.
CREATE TABLE IF NOT EXISTS dialog (
  channel TEXT NOT NULL, peer TEXT NOT NULL, intent TEXT NOT NULL,
  slots_json TEXT NOT NULL, missing_json TEXT NOT NULL, asked TEXT, sources_json TEXT NOT NULL,
  last_action_json TEXT, questions INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (channel, peer)
);

CREATE TABLE IF NOT EXISTS msg_trace (
  id INTEGER PRIMARY KEY, at TEXT NOT NULL, local_date TEXT NOT NULL, kind TEXT NOT NULL,
  channel TEXT NOT NULL, peer TEXT NOT NULL, msg_key TEXT, route TEXT NOT NULL, intent TEXT, tools_json TEXT,
  llm_calls INTEGER NOT NULL DEFAULT 0, model TEXT, provider TEXT,
  reply_chars INTEGER NOT NULL DEFAULT 0, reply_preview TEXT, delivery TEXT NOT NULL,
  latency_ms INTEGER NOT NULL, stages_json TEXT, flags TEXT, error TEXT
);
CREATE INDEX IF NOT EXISTS msg_trace_at ON msg_trace (at);

CREATE TABLE IF NOT EXISTS provider_usage (
  day TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0, tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0,
  rate_limited INTEGER NOT NULL DEFAULT 0, remaining_req INTEGER, remaining_tok INTEGER,
  cooldown_until TEXT, reset_at TEXT, updated_at TEXT NOT NULL,
  PRIMARY KEY (day, provider, model)
);
