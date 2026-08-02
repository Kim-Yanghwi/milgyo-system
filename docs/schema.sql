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
VALUES ('schema_version', '2026-08-01.14', CURRENT_TIMESTAMP)
ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value, updated_at=excluded.updated_at;

-- v26 회계 전용 DB 연계 대기열
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

-- v48 대장관리 및 임·직원 재직증명서
CREATE TABLE IF NOT EXISTS management_registers (
  id TEXT PRIMARY KEY, request_no TEXT NOT NULL UNIQUE, record_type TEXT NOT NULL, title TEXT NOT NULL,
  content_json TEXT NOT NULL DEFAULT '{}', applicant_user_id TEXT NOT NULL, applicant_name TEXT NOT NULL,
  applicant_department TEXT, status TEXT NOT NULL DEFAULT '신청', request_date TEXT NOT NULL,
  processed_by TEXT, processed_by_user_id TEXT, processed_at TEXT, processing_memo TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS management_register_attachments (
  id TEXT PRIMARY KEY, register_id TEXT NOT NULL, file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT 'application/octet-stream', size_bytes INTEGER NOT NULL DEFAULT 0,
  data_base64 TEXT NOT NULL DEFAULT '', storage_type TEXT NOT NULL DEFAULT 'd1', r2_key TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS employee_profiles (
  user_id TEXT PRIMARY KEY, name_hanja TEXT, birth_or_registration TEXT, address TEXT,
  employment_start_date TEXT, contact TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS employment_certificates (
  id TEXT PRIMARY KEY, certificate_no TEXT NOT NULL UNIQUE, employee_user_id TEXT NOT NULL,
  employee_name_ko TEXT NOT NULL, employee_name_hanja TEXT, birth_or_registration TEXT NOT NULL,
  address TEXT NOT NULL, department TEXT NOT NULL, position_grade TEXT NOT NULL,
  employment_start_date TEXT NOT NULL, employment_end_date TEXT, purpose TEXT NOT NULL,
  issue_date TEXT NOT NULL, issuer_user_id TEXT NOT NULL, issuer_name TEXT NOT NULL,
  manager_name TEXT, contact TEXT, status TEXT NOT NULL DEFAULT '발급', canceled_at TEXT,
  canceled_by_user_id TEXT, canceled_by_name TEXT, cancel_reason TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS management_audit_logs (
  id TEXT PRIMARY KEY, category TEXT NOT NULL, action TEXT NOT NULL, target_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL, actor_name TEXT NOT NULL, details_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
);


-- v59 수계증서 발급·대장
CREATE TABLE IF NOT EXISTS ordination_certificates (
  id TEXT PRIMARY KEY,
  certificate_no TEXT NOT NULL UNIQUE,
  request_id TEXT,
  issue_year INTEGER NOT NULL,
  sequence_no INTEGER NOT NULL,
  recipient_name TEXT NOT NULL,
  birth_calendar TEXT NOT NULL,
  birth_date TEXT NOT NULL,
  dharma_name_hanja TEXT NOT NULL,
  dharma_name_korean TEXT NOT NULL,
  ordination_date TEXT NOT NULL,
  buddhist_year INTEGER NOT NULL,
  teacher_name TEXT NOT NULL,
  preceptor_name TEXT NOT NULL,
  witness_name TEXT NOT NULL,
  organization_name TEXT NOT NULL,
  temple_name TEXT NOT NULL,
  issuer_name TEXT NOT NULL,
  closing_text TEXT NOT NULL DEFAULT '合掌',
  note TEXT NOT NULL DEFAULT '',
  template_version TEXT NOT NULL DEFAULT 'ordination-v1',
  certificate_snapshot TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT '발급',
  issued_by_user_id TEXT NOT NULL,
  issued_by_name TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  canceled_at TEXT,
  canceled_by_user_id TEXT,
  canceled_by_name TEXT,
  cancel_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(issue_year, sequence_no)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ordination_certificates_request
  ON ordination_certificates(request_id) WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ordination_certificates_date ON ordination_certificates(ordination_date DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ordination_certificates_recipient ON ordination_certificates(recipient_name, ordination_date DESC);
CREATE INDEX IF NOT EXISTS idx_ordination_certificates_dharma ON ordination_certificates(dharma_name_korean, dharma_name_hanja, ordination_date DESC);
CREATE INDEX IF NOT EXISTS idx_ordination_certificates_status ON ordination_certificates(status, ordination_date DESC);
