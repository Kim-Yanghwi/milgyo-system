-- V108 account identifier: distinct from legacy rank (grade) and login username.
-- No legacy grade/username values are rewritten. Blank values are allowed.
ALTER TABLE system_users ADD COLUMN personnel_no TEXT NOT NULL DEFAULT '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_system_users_personnel_no
  ON system_users(personnel_no COLLATE NOCASE)
  WHERE personnel_no <> '';
