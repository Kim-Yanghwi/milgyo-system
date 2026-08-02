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
CREATE INDEX IF NOT EXISTS idx_ordination_certificates_date
  ON ordination_certificates(ordination_date DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ordination_certificates_recipient
  ON ordination_certificates(recipient_name, ordination_date DESC);
CREATE INDEX IF NOT EXISTS idx_ordination_certificates_dharma
  ON ordination_certificates(dharma_name_korean, dharma_name_hanja, ordination_date DESC);
CREATE INDEX IF NOT EXISTS idx_ordination_certificates_status
  ON ordination_certificates(status, ordination_date DESC);
