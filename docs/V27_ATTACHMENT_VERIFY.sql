-- v27 첨부파일 운영기능 적용 확인

SELECT meta_key, meta_value, updated_at
FROM accounting_meta
WHERE meta_key = 'schema_version';

PRAGMA table_info(accounting_attachments);

SELECT id, allowed_extensions, max_file_bytes, max_files_per_reference,
       max_total_bytes_per_reference, retention_days, require_delete_reason,
       updated_by, updated_at
FROM accounting_attachment_policy;

SELECT name
FROM sqlite_master
WHERE type = 'table'
  AND name IN (
    'accounting_attachment_policy',
    'accounting_attachment_integrity_issues',
    'accounting_attachment_operations'
  )
ORDER BY name;

SELECT reference_type,
       COUNT(*) AS active_files,
       COALESCE(SUM(size_bytes), 0) AS active_bytes
FROM accounting_attachments
WHERE deleted_at IS NULL
GROUP BY reference_type
ORDER BY reference_type;

SELECT status, issue_type, COUNT(*) AS issue_count
FROM accounting_attachment_integrity_issues
GROUP BY status, issue_type
ORDER BY status, issue_type;

SELECT status, operation_type, COUNT(*) AS operation_count
FROM accounting_attachment_operations
GROUP BY status, operation_type
ORDER BY status, operation_type;
