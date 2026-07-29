-- v27 회계 첨부파일 운영정책, 무결성 점검, 재처리 관리

ALTER TABLE accounting_attachments ADD COLUMN delete_reason TEXT;
ALTER TABLE accounting_attachments ADD COLUMN retention_until TEXT;
ALTER TABLE accounting_attachments ADD COLUMN scan_status TEXT NOT NULL DEFAULT 'legacy_unscanned';
ALTER TABLE accounting_attachments ADD COLUMN scan_message TEXT;
ALTER TABLE accounting_attachments ADD COLUMN delete_status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE accounting_attachments ADD COLUMN delete_error TEXT;
ALTER TABLE accounting_attachments ADD COLUMN last_checked_at TEXT;

CREATE INDEX IF NOT EXISTS idx_accounting_attachments_delete_status
ON accounting_attachments (delete_status, deleted_at);

CREATE INDEX IF NOT EXISTS idx_accounting_attachments_retention
ON accounting_attachments (retention_until, deleted_at);

CREATE TABLE IF NOT EXISTS accounting_attachment_policy (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  allowed_extensions TEXT NOT NULL,
  max_file_bytes INTEGER NOT NULL,
  max_files_per_reference INTEGER NOT NULL,
  max_total_bytes_per_reference INTEGER NOT NULL,
  retention_days INTEGER NOT NULL,
  require_delete_reason INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO accounting_attachment_policy (
  id, allowed_extensions, max_file_bytes, max_files_per_reference,
  max_total_bytes_per_reference, retention_days, require_delete_reason,
  updated_by, updated_at
) VALUES (
  1, 'pdf,jpg,jpeg,png,hwp,hwpx,doc,docx,xls,xlsx,csv,txt',
  4194304, 10, 20971520, 3650, 1, 'system', CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS accounting_attachment_integrity_issues (
  id TEXT PRIMARY KEY,
  issue_key TEXT NOT NULL UNIQUE,
  issue_type TEXT NOT NULL,
  attachment_id INTEGER,
  object_key TEXT NOT NULL,
  reference_type TEXT,
  reference_id TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  details_json TEXT NOT NULL DEFAULT '{}',
  detected_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT,
  resolution_action TEXT
);

CREATE INDEX IF NOT EXISTS idx_attachment_integrity_status
ON accounting_attachment_integrity_issues (status, issue_type, last_seen_at);

CREATE TABLE IF NOT EXISTS accounting_attachment_operations (
  id TEXT PRIMARY KEY,
  operation_type TEXT NOT NULL,
  attachment_id INTEGER,
  object_key TEXT NOT NULL,
  reference_type TEXT,
  reference_id TEXT,
  status TEXT NOT NULL DEFAULT 'failed',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_attempt_at TEXT,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_attachment_operations_status
ON accounting_attachment_operations (status, updated_at);

UPDATE accounting_attachments
SET retention_until = COALESCE(retention_until, datetime(uploaded_at, '+3650 days'))
WHERE retention_until IS NULL;

UPDATE accounting_attachments
SET scan_message = COALESCE(scan_message, 'v27 도입 이전 등록파일: 확장자·파일 시그니처 재검사 전')
WHERE scan_status = 'legacy_unscanned';

UPDATE accounting_attachments
SET delete_status = CASE WHEN deleted_at IS NULL THEN 'active' ELSE 'deleted' END
WHERE delete_status IS NULL OR delete_status = '';

INSERT INTO accounting_meta (meta_key, meta_value, updated_at)
VALUES ('schema_version', '2026-07-29.1', CURRENT_TIMESTAMP)
ON CONFLICT(meta_key) DO UPDATE SET
  meta_value = excluded.meta_value,
  updated_at = excluded.updated_at;
