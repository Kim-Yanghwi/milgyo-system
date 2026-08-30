-- V91: foreign applicant web forms and history management
CREATE TABLE IF NOT EXISTS foreign_application_forms (
  id TEXT PRIMARY KEY,
  record_no TEXT NOT NULL UNIQUE,
  form_type TEXT NOT NULL,
  subject_name TEXT NOT NULL DEFAULT '',
  nationality TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '저장',
  snapshot_json TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL,
  created_by_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_printed_at TEXT,
  last_downloaded_at TEXT,
  print_count INTEGER NOT NULL DEFAULT 0,
  download_count INTEGER NOT NULL DEFAULT 0,
  canceled_at TEXT,
  canceled_by_name TEXT
);

CREATE INDEX IF NOT EXISTS idx_foreign_application_forms_type_date
ON foreign_application_forms(form_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_foreign_application_forms_subject
ON foreign_application_forms(subject_name, nationality);

CREATE INDEX IF NOT EXISTS idx_foreign_application_forms_creator
ON foreign_application_forms(created_by_user_id, created_at DESC);
