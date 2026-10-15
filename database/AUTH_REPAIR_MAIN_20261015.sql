-- MAIN DATABASE ONLY: milgyo-system-db / binding DB.
-- Back up the database first. Do NOT run on ACCOUNTING_DB.
-- Prerequisite: existing system_users and system_sessions with the columns below.
-- If either SELECT fails, STOP: check the database identity/base schema, do not create
-- replacement users, reset passwords or run every historical migration blindly.
SELECT id, password_hash, active, role, can_approve, can_accounting
  FROM system_users LIMIT 0;
SELECT token, user_id, created_at, expires_at
  FROM system_sessions LIMIT 0;

-- The body below is identical to migrations/main/0012_v97_security_sessions.sql.
-- CREATE ... IF NOT EXISTS adds missing objects; it does not rewrite an existing
-- object with the same name. A malformed existing object requires separate review.
-- V97 security-only migration. Idempotent; run ONLY against DB (main), not ACCOUNTING_DB.
-- Does not alter users, passwords, document data, accounting data or existing session rows.
CREATE TABLE IF NOT EXISTS auth_rate_buckets (
  bucket_key TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_rate_buckets_expiry ON auth_rate_buckets(expires_at);
-- Revoke sessions atomically for changes that affect credentials or authorization.
CREATE TRIGGER IF NOT EXISTS trg_security_revoke_user_sessions
AFTER UPDATE OF password_hash,active,role,can_approve,can_accounting ON system_users
WHEN OLD.password_hash IS NOT NEW.password_hash OR OLD.active IS NOT NEW.active
  OR OLD.role IS NOT NEW.role OR OLD.can_approve IS NOT NEW.can_approve
  OR OLD.can_accounting IS NOT NEW.can_accounting
BEGIN
  DELETE FROM system_sessions WHERE CAST(user_id AS TEXT)=CAST(NEW.id AS TEXT);
END;
CREATE TRIGGER IF NOT EXISTS trg_security_delete_user_sessions
AFTER DELETE ON system_users
BEGIN
  DELETE FROM system_sessions WHERE CAST(user_id AS TEXT)=CAST(OLD.id AS TEXT);
END;
