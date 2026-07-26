CREATE TABLE IF NOT EXISTS accounting_outbox (
  id TEXT PRIMARY KEY,
  event_key TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  document_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  processed_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_accounting_outbox_pending ON accounting_outbox(status,next_attempt_at,created_at);
CREATE INDEX IF NOT EXISTS idx_accounting_outbox_document ON accounting_outbox(document_id,created_at);
