ALTER TABLE accounting_entities ADD COLUMN affiliation_registered_at TEXT;

CREATE TABLE IF NOT EXISTS accounting_entity_certificates (
  id TEXT PRIMARY KEY,
  certificate_no TEXT NOT NULL UNIQUE,
  entity_id TEXT NOT NULL,
  affiliation_name TEXT NOT NULL DEFAULT '대한불교밀교종',
  headquarters_address TEXT NOT NULL,
  temple_display_name TEXT NOT NULL,
  registration_date TEXT NOT NULL,
  purpose TEXT NOT NULL,
  confirmation_chairman TEXT NOT NULL,
  issuing_chairman TEXT NOT NULL,
  issue_date TEXT NOT NULL,
  buddhist_year INTEGER NOT NULL,
  valid_until TEXT NOT NULL,
  issued_by TEXT NOT NULL,
  issued_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_entity_certificates_entity_issue
  ON accounting_entity_certificates(entity_id, issue_date DESC, issued_at DESC);
CREATE INDEX IF NOT EXISTS idx_entity_certificates_issue_date
  ON accounting_entity_certificates(issue_date DESC, certificate_no);
