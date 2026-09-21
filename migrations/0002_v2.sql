-- v2: categories and real clock times on deadlines, daily tasks, chat memory, vault index.
-- D1-safe subset only: no PRAGMA, no triggers, no time defaults, no foreign keys.
ALTER TABLE deadlines ADD COLUMN category TEXT NOT NULL DEFAULT 'default';
ALTER TABLE deadlines ADD COLUMN timed    INTEGER NOT NULL DEFAULT 0;

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
