CREATE TABLE IF NOT EXISTS appointment_award_certificates (
  id TEXT PRIMARY KEY,
  serial_no TEXT NOT NULL,
  document_type TEXT NOT NULL,
  header_position TEXT NOT NULL DEFAULT '',
  recipient_name TEXT NOT NULL,
  dharma_name TEXT NOT NULL DEFAULT '',
  body_organization TEXT NOT NULL DEFAULT '',
  appointment_position TEXT NOT NULL DEFAULT '',
  commendation_text TEXT NOT NULL DEFAULT '',
  buddhist_year INTEGER NOT NULL,
  issue_month INTEGER NOT NULL,
  issue_day INTEGER NOT NULL,
  issuer_type TEXT NOT NULL,
  issuer_user_id TEXT NOT NULL,
  issuer_name TEXT NOT NULL,
  manager_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '발급',
  canceled_at TEXT,
  canceled_by_user_id TEXT,
  canceled_by_name TEXT,
  cancel_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_appointment_award_serial_no
  ON appointment_award_certificates(serial_no);

CREATE INDEX IF NOT EXISTS idx_appointment_award_created_at
  ON appointment_award_certificates(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_appointment_award_recipient
  ON appointment_award_certificates(recipient_name, dharma_name);
