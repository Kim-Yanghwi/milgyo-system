CREATE TABLE IF NOT EXISTS accounting_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  reference_type TEXT NOT NULL,
  reference_id TEXT NOT NULL,

  file_category TEXT NOT NULL DEFAULT 'general',
  original_filename TEXT NOT NULL,
  stored_filename TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,

  content_type TEXT,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  checksum_sha256 TEXT,

  uploaded_by TEXT,
  uploaded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

  deleted_at TEXT,
  deleted_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_accounting_attachments_reference
ON accounting_attachments (
  reference_type,
  reference_id
);

CREATE INDEX IF NOT EXISTS idx_accounting_attachments_uploaded_at
ON accounting_attachments (
  uploaded_at
);

CREATE INDEX IF NOT EXISTS idx_accounting_attachments_deleted_at
ON accounting_attachments (
  deleted_at
);
