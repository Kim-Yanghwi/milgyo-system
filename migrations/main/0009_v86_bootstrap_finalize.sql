-- v86: finalize the migration-managed main schema for fresh/recovery databases.
-- Runtime ensureTables will seed/update built-in templates in one set-based D1 query.
INSERT INTO system_meta (meta_key, meta_value, updated_at)
VALUES ('schema_version', '2026-08-15.17', CURRENT_TIMESTAMP)
ON CONFLICT(meta_key) DO UPDATE SET
  meta_value = excluded.meta_value,
  updated_at = excluded.updated_at;
