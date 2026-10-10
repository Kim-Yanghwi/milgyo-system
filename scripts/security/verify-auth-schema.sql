-- READ ONLY. Main management DB only. Expected count: 3 (one table, two triggers).
SELECT COUNT(*) AS security_objects FROM sqlite_master
WHERE (type='table' AND name='auth_rate_buckets')
OR (type='trigger' AND name IN ('trg_security_revoke_user_sessions','trg_security_delete_user_sessions'));
