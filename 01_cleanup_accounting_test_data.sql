-- milgyo-accounting-db 테스트 회계자료 전체 정리
-- 기준정보는 유지합니다: accounting_fiscal_years, accounting_accounts,
-- accounting_book_types, accounting_entities, accounting_funds, accounting_meta

-- 첨부 메타정보 및 하위 연결자료
DELETE FROM accounting_attachments;
DELETE FROM accounting_journal_line_dimensions;
DELETE FROM accounting_card_transactions;
DELETE FROM accounting_donations;
DELETE FROM accounting_resolution_dimensions;

-- 전표·분개·결의서
DELETE FROM accounting_journal_lines;
DELETE FROM accounting_journals;
DELETE FROM accounting_resolutions;

-- 결산·집계·감사기록
DELETE FROM accounting_branch_reports;
DELETE FROM accounting_closings;
DELETE FROM accounting_monthly_summary;
DELETE FROM accounting_audit_logs;

-- 테스트용 예산·자산·기부자·카드 기준자료
DELETE FROM accounting_budget_plans;
DELETE FROM accounting_budgets;
DELETE FROM accounting_assets;
DELETE FROM accounting_donors;
DELETE FROM accounting_cards;

-- 문서번호를 운영 시작 기준으로 다시 생성
DELETE FROM accounting_sequences;
DELETE FROM accounting_special_sequences;

-- AUTOINCREMENT 첨부번호 초기화(테이블이 존재하는 경우)
DELETE FROM sqlite_sequence WHERE name = 'accounting_attachments';
