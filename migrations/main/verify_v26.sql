SELECT COUNT(*) AS outbox_table
FROM sqlite_master
WHERE type='table' AND name='accounting_outbox';

SELECT status, COUNT(*) AS count
FROM accounting_outbox
GROUP BY status
ORDER BY status;
