CREATE TABLE IF NOT EXISTS document_transition_locks (document_id TEXT PRIMARY KEY,lock_token TEXT NOT NULL,locked_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_document_transition_locks_time ON document_transition_locks(locked_at);
