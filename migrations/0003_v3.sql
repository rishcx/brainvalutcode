-- v3: origin channel on deadlines, claim/retry on reminders, dialog state, message trace, provider usage.
ALTER TABLE deadlines ADD COLUMN origin_channel TEXT;
ALTER TABLE deadlines ADD COLUMN origin_peer    TEXT;
ALTER TABLE reminders ADD COLUMN claimed_at TEXT;
ALTER TABLE reminders ADD COLUMN claim      TEXT;
ALTER TABLE reminders ADD COLUMN attempts   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reminders ADD COLUMN last_error TEXT;

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
