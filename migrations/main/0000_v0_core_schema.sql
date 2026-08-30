-- v0 bootstrap: core D1 schema for fresh/recovery environments.
-- Idempotent: existing production data is not modified.

CREATE TABLE IF NOT EXISTS system_users (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
  position TEXT, grade TEXT, department TEXT, role TEXT NOT NULL DEFAULT 'user',
  can_approve INTEGER NOT NULL DEFAULT 0, can_accounting INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS system_sessions (token TEXT PRIMARY KEY,user_id TEXT NOT NULL,created_at TEXT NOT NULL,expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,doc_type TEXT NOT NULL,category TEXT NOT NULL,title TEXT NOT NULL,summary TEXT NOT NULL DEFAULT '',body TEXT NOT NULL DEFAULT '',attachments_note TEXT NOT NULL DEFAULT '',
  drafter TEXT NOT NULL,drafter_user_id TEXT,drafter_position TEXT,reviewer_user_id TEXT,reviewer_name TEXT,reviewer_position TEXT,approver_user_id TEXT,approver_name TEXT,approver_position TEXT,department TEXT,recipient TEXT,via TEXT,
  approval_track TEXT NOT NULL,approval_mode TEXT NOT NULL DEFAULT '결재',status TEXT NOT NULL DEFAULT '결재대기',sent_method TEXT,sent_at TEXT,template_id TEXT,template_name TEXT,form_data_json TEXT NOT NULL DEFAULT '{}',access_scope TEXT NOT NULL DEFAULT '전체',client_request_id TEXT,submitted_at TEXT,completed_at TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS document_approvals (id TEXT PRIMARY KEY,document_id TEXT NOT NULL,action TEXT NOT NULL,approver_name TEXT NOT NULL,approver_role TEXT,memo TEXT,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS document_approval_lines (id TEXT PRIMARY KEY,document_id TEXT NOT NULL,line_order INTEGER NOT NULL,line_type TEXT NOT NULL,user_id TEXT NOT NULL,user_name TEXT NOT NULL,user_position TEXT,status TEXT NOT NULL DEFAULT '예정',acted_at TEXT,memo TEXT,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS received_documents (id TEXT PRIMARY KEY,direction TEXT NOT NULL,title TEXT NOT NULL,counterparty TEXT NOT NULL,source_system TEXT,external_doc_number TEXT,memo TEXT,department TEXT,related_document_id TEXT,handled_by TEXT NOT NULL,handled_by_user_id TEXT,received_at TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS document_dispatch_links (document_id TEXT PRIMARY KEY,registry_id TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS document_transition_locks (document_id TEXT PRIMARY KEY,lock_token TEXT NOT NULL,locked_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS document_attachments (id TEXT PRIMARY KEY,document_id TEXT NOT NULL,file_name TEXT NOT NULL,mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',size_bytes INTEGER NOT NULL DEFAULT 0,data_base64 TEXT NOT NULL DEFAULT '',storage_type TEXT NOT NULL DEFAULT 'd1',r2_key TEXT,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS received_attachments (id TEXT PRIMARY KEY,received_document_id TEXT NOT NULL,file_name TEXT NOT NULL,mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',size_bytes INTEGER NOT NULL DEFAULT 0,data_base64 TEXT NOT NULL DEFAULT '',storage_type TEXT NOT NULL DEFAULT 'd1',r2_key TEXT,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS document_templates (id TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',doc_type TEXT NOT NULL DEFAULT '기안',category TEXT NOT NULL,title_prefix TEXT NOT NULL DEFAULT '',fields_json TEXT NOT NULL DEFAULT '[]',body_template TEXT NOT NULL DEFAULT '',is_system INTEGER NOT NULL DEFAULT 0,active INTEGER NOT NULL DEFAULT 1,created_by TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS document_sequences (seq_key TEXT PRIMARY KEY,last_seq INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS admin_rate_limits (id TEXT PRIMARY KEY,rate_key TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS org_settings (id TEXT PRIMARY KEY,seal_image TEXT,logo_image TEXT,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS system_meta (meta_key TEXT PRIMARY KEY,meta_value TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_system_sessions_user ON system_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_system_sessions_expires ON system_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status);
CREATE INDEX IF NOT EXISTS idx_documents_created ON documents(created_at);
CREATE INDEX IF NOT EXISTS idx_documents_updated ON documents(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_documents_title ON documents(title);
CREATE INDEX IF NOT EXISTS idx_documents_status_created ON documents(status,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_documents_type_status_created ON documents(doc_type,status,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_documents_approver ON documents(approver_user_id,status);
CREATE INDEX IF NOT EXISTS idx_documents_reviewer ON documents(reviewer_user_id,status);
CREATE INDEX IF NOT EXISTS idx_documents_drafter ON documents(drafter_user_id,status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_request_id ON documents(client_request_id) WHERE client_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_document_approvals_doc ON document_approvals(document_id,created_at);
CREATE INDEX IF NOT EXISTS idx_document_approval_lines_doc ON document_approval_lines(document_id,line_order);
CREATE INDEX IF NOT EXISTS idx_document_approval_lines_pending ON document_approval_lines(user_id,status,document_id);
CREATE INDEX IF NOT EXISTS idx_document_approval_lines_doc_status_order ON document_approval_lines(document_id,status,line_order);
CREATE INDEX IF NOT EXISTS idx_received_documents_created ON received_documents(created_at);
CREATE INDEX IF NOT EXISTS idx_received_documents_date ON received_documents(received_at DESC,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_received_documents_direction_date ON received_documents(direction,received_at DESC,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_received_documents_handler ON received_documents(handled_by_user_id,created_at);
CREATE INDEX IF NOT EXISTS idx_received_documents_related ON received_documents(related_document_id,direction);
CREATE INDEX IF NOT EXISTS idx_dispatch_links_registry ON document_dispatch_links(registry_id);
CREATE INDEX IF NOT EXISTS idx_document_transition_locks_time ON document_transition_locks(locked_at);
CREATE INDEX IF NOT EXISTS idx_document_attachments_doc ON document_attachments(document_id,created_at);
CREATE INDEX IF NOT EXISTS idx_received_attachments_doc ON received_attachments(received_document_id,created_at);
CREATE INDEX IF NOT EXISTS idx_admin_rate_limits_key_created ON admin_rate_limits(rate_key,created_at);
