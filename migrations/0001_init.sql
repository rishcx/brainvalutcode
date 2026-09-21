-- Single source of truth for both SqliteStore (node:sqlite) and D1.
-- migrations/0001_init.sql must stay byte-identical to this file; a test asserts it.
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
  updated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS deadlines_status_due ON deadlines (status, due_at);

CREATE TABLE IF NOT EXISTS reminders (
  id          INTEGER PRIMARY KEY,
  deadline_id TEXT NOT NULL,
  kind        TEXT NOT NULL,
  fire_at     TEXT NOT NULL,
  sent_at     TEXT,
  created_at  TEXT NOT NULL,
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
