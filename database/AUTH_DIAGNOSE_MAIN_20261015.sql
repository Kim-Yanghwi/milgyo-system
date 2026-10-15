-- READ ONLY. Choose the MAIN production database (milgyo-system-db).
-- No user names, password hashes, session tokens, documents or account entries are returned.
-- The first five objects are required by the login/authentication implementation.
-- The index is included because it is part of the same V97 migration.
WITH expected(type, name) AS (
  VALUES
    ('table', 'system_users'),
    ('table', 'system_sessions'),
    ('table', 'auth_rate_buckets'),
    ('trigger', 'trg_security_revoke_user_sessions'),
    ('trigger', 'trg_security_delete_user_sessions'),
    ('index', 'idx_auth_rate_buckets_expiry')
)
SELECT e.type AS object_type, e.name AS object_name,
       CASE WHEN s.name IS NULL THEN 'MISSING' ELSE 'OK' END AS status,
       s.tbl_name AS target_table
FROM expected e
LEFT JOIN sqlite_master s ON s.type=e.type AND s.name=e.name
ORDER BY e.type, e.name;

-- These PRAGMAs return column definitions only, never credential values.
PRAGMA table_info(system_users);
PRAGMA table_info(system_sessions);
PRAGMA table_info(auth_rate_buckets);
