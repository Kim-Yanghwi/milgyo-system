-- 주의: 회계 모듈에서 만든 테스트 결의·전표·예산·마감자료와 연계 전자문서를 모두 삭제합니다.
-- 실제 운영자료가 존재하면 실행하지 마세요.

DELETE FROM document_attachments
WHERE document_id IN (SELECT document_id FROM accounting_resolutions WHERE document_id IS NOT NULL);
DELETE FROM document_approval_lines
WHERE document_id IN (SELECT document_id FROM accounting_resolutions WHERE document_id IS NOT NULL);
DELETE FROM document_approvals
WHERE document_id IN (SELECT document_id FROM accounting_resolutions WHERE document_id IS NOT NULL);
DELETE FROM documents
WHERE id IN (SELECT document_id FROM accounting_resolutions WHERE document_id IS NOT NULL);

DELETE FROM accounting_journal_lines;
DELETE FROM accounting_journals;
DELETE FROM accounting_resolutions;
DELETE FROM accounting_budgets;
DELETE FROM accounting_closings;
DELETE FROM accounting_audit_logs;
DELETE FROM accounting_sequences;

-- 기본 계정과목과 회계연도는 유지합니다.
