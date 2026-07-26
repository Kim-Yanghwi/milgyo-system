-- 종단관리시스템(system.milgyo.org) D1 초기 설치 스키마
-- 기존 운영 DB는 functions/_shared/helpers.ts의 ensureTables()가 필요한 테이블·컬럼을 자동 보완합니다.

CREATE TABLE IF NOT EXISTS system_users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  position TEXT,
  grade TEXT,
  department TEXT,
  role TEXT NOT NULL DEFAULT 'user',
  can_approve INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS system_sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  doc_type TEXT NOT NULL,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  attachments_note TEXT NOT NULL DEFAULT '',
  drafter TEXT NOT NULL,
  drafter_user_id TEXT,
  drafter_position TEXT,
  reviewer_user_id TEXT,
  reviewer_name TEXT,
  reviewer_position TEXT,
  approver_user_id TEXT,
  approver_name TEXT,
  approver_position TEXT,
  department TEXT,
  recipient TEXT,
  via TEXT,
  approval_track TEXT NOT NULL,
  approval_mode TEXT NOT NULL DEFAULT '결재',
  status TEXT NOT NULL DEFAULT '결재대기',
  sent_method TEXT,
  sent_at TEXT,
  template_id TEXT,
  template_name TEXT,
  form_data_json TEXT NOT NULL DEFAULT '{}',
  access_scope TEXT NOT NULL DEFAULT '전체',
  client_request_id TEXT,
  submitted_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS document_approvals (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  action TEXT NOT NULL,
  approver_name TEXT NOT NULL,
  approver_role TEXT,
  memo TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS document_approval_lines (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  line_order INTEGER NOT NULL,
  line_type TEXT NOT NULL,
  user_id TEXT NOT NULL,
  user_name TEXT NOT NULL,
  user_position TEXT,
  status TEXT NOT NULL DEFAULT '예정',
  acted_at TEXT,
  memo TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS received_documents (
  id TEXT PRIMARY KEY,
  direction TEXT NOT NULL,
  title TEXT NOT NULL,
  counterparty TEXT NOT NULL,
  source_system TEXT,
  external_doc_number TEXT,
  memo TEXT,
  department TEXT,
  related_document_id TEXT,
  handled_by TEXT NOT NULL,
  handled_by_user_id TEXT,
  received_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS document_dispatch_links (
  document_id TEXT PRIMARY KEY,
  registry_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS document_attachments (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  data_base64 TEXT NOT NULL,
  storage_type TEXT NOT NULL DEFAULT 'd1',
  r2_key TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS received_attachments (
  id TEXT PRIMARY KEY,
  received_document_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  data_base64 TEXT NOT NULL,
  storage_type TEXT NOT NULL DEFAULT 'd1',
  r2_key TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS document_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  doc_type TEXT NOT NULL DEFAULT '기안',
  category TEXT NOT NULL,
  title_prefix TEXT NOT NULL DEFAULT '',
  fields_json TEXT NOT NULL DEFAULT '[]',
  body_template TEXT NOT NULL DEFAULT '',
  is_system INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS document_sequences (
  seq_key TEXT PRIMARY KEY,
  last_seq INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS admin_rate_limits (
  id TEXT PRIMARY KEY,
  rate_key TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS org_settings (
  id TEXT PRIMARY KEY,
  seal_image TEXT,
  logo_image TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_documents_status ON documents (status);
CREATE INDEX IF NOT EXISTS idx_documents_created ON documents (created_at);
CREATE INDEX IF NOT EXISTS idx_documents_updated ON documents (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_documents_title ON documents (title);
CREATE INDEX IF NOT EXISTS idx_documents_status_created ON documents (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_documents_type_status_created ON documents (doc_type, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_documents_approver ON documents (approver_user_id, status);
CREATE INDEX IF NOT EXISTS idx_documents_reviewer ON documents (reviewer_user_id, status);
CREATE INDEX IF NOT EXISTS idx_documents_drafter ON documents (drafter_user_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_request_id ON documents (client_request_id) WHERE client_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_document_approvals_doc ON document_approvals (document_id, created_at);
CREATE INDEX IF NOT EXISTS idx_document_approval_lines_doc ON document_approval_lines (document_id, line_order);
CREATE INDEX IF NOT EXISTS idx_document_approval_lines_pending ON document_approval_lines (user_id, status, document_id);
CREATE INDEX IF NOT EXISTS idx_document_approval_lines_doc_status_order ON document_approval_lines (document_id, status, line_order);
CREATE INDEX IF NOT EXISTS idx_received_documents_created ON received_documents (created_at);
CREATE INDEX IF NOT EXISTS idx_received_documents_date ON received_documents (received_at DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_received_documents_direction_date ON received_documents (direction, received_at DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_received_documents_handler ON received_documents (handled_by_user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_received_documents_related ON received_documents (related_document_id, direction);
CREATE INDEX IF NOT EXISTS idx_dispatch_links_registry ON document_dispatch_links (registry_id);
CREATE INDEX IF NOT EXISTS idx_document_attachments_doc ON document_attachments (document_id, created_at);
CREATE INDEX IF NOT EXISTS idx_received_attachments_doc ON received_attachments (received_document_id, created_at);
CREATE INDEX IF NOT EXISTS idx_system_sessions_user ON system_sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_admin_rate_limits_key_created ON admin_rate_limits (rate_key, created_at);

CREATE TABLE IF NOT EXISTS system_meta (
  meta_key TEXT PRIMARY KEY,
  meta_value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO system_meta (meta_key, meta_value, updated_at)
VALUES ('schema_version', '2026-07-25.8', CURRENT_TIMESTAMP)
ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value, updated_at=excluded.updated_at;

-- v20 종단 회계관리 모듈
CREATE TABLE IF NOT EXISTS accounting_fiscal_years (
  year INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  base_currency TEXT NOT NULL DEFAULT 'KRW',
  status TEXT NOT NULL DEFAULT 'open',
  created_by TEXT,
  created_at TEXT NOT NULL,
  closed_by TEXT,
  closed_at TEXT
);
CREATE TABLE IF NOT EXISTS accounting_accounts (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  account_type TEXT NOT NULL,
  normal_side TEXT NOT NULL,
  parent_code TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  system_account INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS accounting_budgets (
  id TEXT PRIMARY KEY,
  fiscal_year INTEGER NOT NULL,
  department TEXT NOT NULL DEFAULT '',
  project TEXT NOT NULL DEFAULT '',
  account_code TEXT NOT NULL,
  original_amount INTEGER NOT NULL DEFAULT 0,
  supplementary_amount INTEGER NOT NULL DEFAULT 0,
  transfer_in INTEGER NOT NULL DEFAULT 0,
  transfer_out INTEGER NOT NULL DEFAULT 0,
  memo TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(fiscal_year, department, project, account_code)
);
CREATE TABLE IF NOT EXISTS accounting_resolutions (
  id TEXT PRIMARY KEY,
  resolution_no TEXT NOT NULL UNIQUE,
  resolution_type TEXT NOT NULL,
  fiscal_year INTEGER NOT NULL,
  resolution_date TEXT NOT NULL,
  title TEXT NOT NULL,
  department TEXT NOT NULL DEFAULT '',
  project TEXT NOT NULL DEFAULT '',
  counterparty TEXT NOT NULL DEFAULT '',
  account_code TEXT NOT NULL,
  settlement_account_code TEXT NOT NULL,
  amount INTEGER NOT NULL,
  tax_amount INTEGER NOT NULL DEFAULT 0,
  payment_method TEXT,
  memo TEXT,
  document_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'draft',
  journal_id TEXT,
  created_by_user_id TEXT NOT NULL,
  created_by_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS accounting_journals (
  id TEXT PRIMARY KEY,
  journal_no TEXT NOT NULL UNIQUE,
  fiscal_year INTEGER NOT NULL,
  journal_date TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'posted',
  document_id TEXT,
  reversed_journal_id TEXT,
  created_by TEXT,
  approved_by TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS accounting_journal_lines (
  id TEXT PRIMARY KEY,
  journal_id TEXT NOT NULL,
  line_no INTEGER NOT NULL,
  account_code TEXT NOT NULL,
  debit INTEGER NOT NULL DEFAULT 0,
  credit INTEGER NOT NULL DEFAULT 0,
  department TEXT NOT NULL DEFAULT '',
  project TEXT NOT NULL DEFAULT '',
  counterparty TEXT NOT NULL DEFAULT '',
  memo TEXT,
  UNIQUE(journal_id, line_no)
);
CREATE TABLE IF NOT EXISTS accounting_closings (
  id TEXT PRIMARY KEY,
  fiscal_year INTEGER NOT NULL,
  period_month INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'closed',
  closed_by TEXT NOT NULL,
  closed_at TEXT NOT NULL,
  memo TEXT,
  UNIQUE(fiscal_year, period_month)
);
CREATE TABLE IF NOT EXISTS accounting_audit_logs (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  actor_user_id TEXT,
  actor_name TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS accounting_sequences (
  seq_key TEXT PRIMARY KEY,
  last_seq INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS accounting_meta (
  meta_key TEXT PRIMARY KEY,
  meta_value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
