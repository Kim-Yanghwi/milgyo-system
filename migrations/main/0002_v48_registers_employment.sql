CREATE TABLE IF NOT EXISTS management_registers (
  id TEXT PRIMARY KEY,
  request_no TEXT NOT NULL UNIQUE,
  record_type TEXT NOT NULL,
  title TEXT NOT NULL,
  content_json TEXT NOT NULL DEFAULT '{}',
  applicant_user_id TEXT NOT NULL,
  applicant_name TEXT NOT NULL,
  applicant_department TEXT,
  status TEXT NOT NULL DEFAULT '신청',
  request_date TEXT NOT NULL,
  processed_by TEXT,
  processed_by_user_id TEXT,
  processed_at TEXT,
  processing_memo TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS management_register_attachments (
  id TEXT PRIMARY KEY,
  register_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  data_base64 TEXT NOT NULL DEFAULT '',
  storage_type TEXT NOT NULL DEFAULT 'd1',
  r2_key TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS employee_profiles (
  user_id TEXT PRIMARY KEY,
  name_hanja TEXT,
  birth_or_registration TEXT,
  address TEXT,
  employment_start_date TEXT,
  contact TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS employment_certificates (
  id TEXT PRIMARY KEY,
  certificate_no TEXT NOT NULL UNIQUE,
  employee_user_id TEXT NOT NULL,
  employee_name_ko TEXT NOT NULL,
  employee_name_hanja TEXT,
  birth_or_registration TEXT NOT NULL,
  address TEXT NOT NULL,
  department TEXT NOT NULL,
  position_grade TEXT NOT NULL,
  employment_start_date TEXT NOT NULL,
  employment_end_date TEXT,
  purpose TEXT NOT NULL,
  issue_date TEXT NOT NULL,
  issuer_user_id TEXT NOT NULL,
  issuer_name TEXT NOT NULL,
  manager_name TEXT,
  contact TEXT,
  status TEXT NOT NULL DEFAULT '발급',
  canceled_at TEXT,
  canceled_by_user_id TEXT,
  canceled_by_name TEXT,
  cancel_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS management_audit_logs (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  action TEXT NOT NULL,
  target_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_management_registers_type_date ON management_registers(record_type, request_date DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_management_registers_applicant ON management_registers(applicant_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_management_registers_status ON management_registers(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_management_register_attachments_record ON management_register_attachments(register_id, created_at);
CREATE INDEX IF NOT EXISTS idx_employment_certificates_employee ON employment_certificates(employee_user_id, issue_date DESC);
CREATE INDEX IF NOT EXISTS idx_employment_certificates_status ON employment_certificates(status, issue_date DESC);
CREATE INDEX IF NOT EXISTS idx_management_audit_target ON management_audit_logs(category, target_id, created_at);
