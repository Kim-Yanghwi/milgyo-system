-- V100: 승적원부 (비공개) 및 승적증명서 발급대장. 메인 DB(DB)에 적용합니다.
CREATE TABLE IF NOT EXISTS monastic_registry (
  id TEXT PRIMARY KEY,
  register_no TEXT NOT NULL UNIQUE,
  monastic_no TEXT NOT NULL UNIQUE,
  dharma_name_ko TEXT NOT NULL,
  dharma_name_hanja TEXT NOT NULL DEFAULT '',
  lay_name TEXT NOT NULL DEFAULT '',
  birth_date TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK(status IN ('재적','제적','기타')),
  temple TEXT NOT NULL DEFAULT '',
  acquired_date TEXT NOT NULL,
  mentor_name TEXT NOT NULL DEFAULT '',
  position_title TEXT NOT NULL DEFAULT '',
  contact TEXT NOT NULL DEFAULT '',
  managing_office TEXT NOT NULL DEFAULT '',
  first_registered_date TEXT NOT NULL,
  last_verified_date TEXT NOT NULL,
  ordination_json TEXT NOT NULL DEFAULT '[]',
  career_json TEXT NOT NULL DEFAULT '[]',
  access_scope TEXT NOT NULL DEFAULT '승적관리 담당자',
  processing_basis TEXT NOT NULL DEFAULT '',
  sensitive_basis TEXT NOT NULL DEFAULT '',
  retention_period TEXT NOT NULL DEFAULT '',
  storage_location TEXT NOT NULL DEFAULT '',
  prepared_by TEXT NOT NULL DEFAULT '',
  reviewed_by TEXT NOT NULL DEFAULT '',
  approved_by TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  created_by_user_id TEXT NOT NULL,
  updated_by_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_monastic_registry_status ON monastic_registry(status,updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_monastic_registry_name ON monastic_registry(dharma_name_ko,monastic_no);
CREATE TABLE IF NOT EXISTS monastic_registry_changes (
  id TEXT PRIMARY KEY,
  registry_id TEXT NOT NULL REFERENCES monastic_registry(id) ON DELETE RESTRICT,
  change_date TEXT NOT NULL,
  change_type TEXT NOT NULL,
  before_json TEXT NOT NULL DEFAULT '{}',
  after_json TEXT NOT NULL DEFAULT '{}',
  evidence_note TEXT NOT NULL DEFAULT '',
  approved_by TEXT NOT NULL DEFAULT '',
  actor_user_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_monastic_registry_changes_record ON monastic_registry_changes(registry_id,created_at DESC);
CREATE TABLE IF NOT EXISTS monastic_registry_attachments (
  id TEXT PRIMARY KEY,
  registry_id TEXT NOT NULL REFERENCES monastic_registry(id) ON DELETE RESTRICT,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK(size_bytes > 0),
  storage_type TEXT NOT NULL CHECK(storage_type IN ('d1','r2')),
  data_base64 TEXT NOT NULL DEFAULT '',
  r2_key TEXT,
  evidence_type TEXT NOT NULL DEFAULT '',
  issuing_authority TEXT NOT NULL DEFAULT '',
  verified_date TEXT NOT NULL DEFAULT '',
  actor_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_monastic_registry_attachments_record ON monastic_registry_attachments(registry_id,created_at DESC);
CREATE TABLE IF NOT EXISTS monastic_certificates (
  id TEXT PRIMARY KEY,
  certificate_no TEXT NOT NULL UNIQUE,
  request_id TEXT NOT NULL,
  registry_id TEXT NOT NULL REFERENCES monastic_registry(id) ON DELETE RESTRICT,
  certificate_snapshot TEXT NOT NULL,
  issue_date TEXT NOT NULL,
  purpose TEXT NOT NULL,
  signatory_title TEXT NOT NULL,
  signatory_user_id TEXT NOT NULL,
  signatory_name TEXT NOT NULL,
  include_logo_sq_seal INTEGER NOT NULL DEFAULT 0,
  manager_name TEXT NOT NULL DEFAULT '',
  contact TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '발급' CHECK(status IN ('발급','취소')),
  issued_by_user_id TEXT NOT NULL,
  issued_by_name TEXT NOT NULL,
  canceled_at TEXT,
  canceled_by_user_id TEXT,
  canceled_by_name TEXT,
  cancel_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(request_id,issued_by_user_id)
);
CREATE INDEX IF NOT EXISTS idx_monastic_certificates_registry ON monastic_certificates(registry_id,issue_date DESC);
CREATE INDEX IF NOT EXISTS idx_monastic_certificates_status ON monastic_certificates(status,issue_date DESC);
