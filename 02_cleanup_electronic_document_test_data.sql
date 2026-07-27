-- milgyo-system-db 테스트 전자문서자료 전체 정리
-- 사용자, 세션, 조직설정, 문서서식, 시스템 메타정보는 유지합니다.

-- 회계 연계 대기열
DELETE FROM accounting_outbox;

-- 접수·발송 및 첨부자료
DELETE FROM received_attachments;
DELETE FROM document_attachments;
DELETE FROM document_dispatch_links;
DELETE FROM received_documents;

-- 결재선·결재이력·전자문서
DELETE FROM document_approval_lines;
DELETE FROM document_approvals;
DELETE FROM documents;

-- 운영 첫 문서번호부터 다시 시작
DELETE FROM document_sequences;

-- 테스트 중 누적된 관리자 요청 제한 기록만 초기화
DELETE FROM admin_rate_limits;
