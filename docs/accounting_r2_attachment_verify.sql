-- 회계 전용 R2 첨부파일 메타데이터 테이블 점검

SELECT COUNT(*) AS table_count
FROM sqlite_master
WHERE type='table' AND name='accounting_attachments';

PRAGMA table_info(accounting_attachments);

SELECT name, sql
FROM sqlite_master
WHERE type='index' AND tbl_name='accounting_attachments'
ORDER BY name;

SELECT
  reference_type,
  reference_id,
  COUNT(*) AS active_file_count,
  COALESCE(SUM(size_bytes),0) AS active_total_bytes
FROM accounting_attachments
WHERE deleted_at IS NULL
GROUP BY reference_type, reference_id
ORDER BY reference_type, reference_id;

SELECT
  COUNT(*) AS active_files,
  COALESCE(SUM(size_bytes),0) AS active_bytes,
  SUM(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END) AS deleted_records
FROM accounting_attachments;
