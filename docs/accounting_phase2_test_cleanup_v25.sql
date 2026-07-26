-- 종단 특화회계 2단계 테스트자료 삭제용
-- 실제 운영자료가 하나라도 존재하면 실행하지 마세요.
-- 기본 회계구분, 종단 본부, 기본 재원, 계정과목, 회계연도는 유지합니다.

-- 특화기능이 생성한 전표 차원과 전표를 먼저 삭제합니다.
DELETE FROM accounting_journal_line_dimensions
WHERE journal_line_id IN (
  SELECT l.id FROM accounting_journal_lines l
  JOIN accounting_journals j ON j.id=l.journal_id
  WHERE j.source_type IN ('donation','card')
);
DELETE FROM accounting_journal_lines
WHERE journal_id IN (SELECT id FROM accounting_journals WHERE source_type IN ('donation','card'));
DELETE FROM accounting_journals WHERE source_type IN ('donation','card');

DELETE FROM accounting_card_transactions;
DELETE FROM accounting_cards;
DELETE FROM accounting_assets;
DELETE FROM accounting_donations;
DELETE FROM accounting_donors;
DELETE FROM accounting_branch_reports;
DELETE FROM accounting_special_sequences;

-- 사용자가 추가한 재원·조직·회계구분만 삭제합니다.
DELETE FROM accounting_funds WHERE system_fund=0;
DELETE FROM accounting_entities WHERE id<>'ENTITY-HQ';
DELETE FROM accounting_book_types WHERE system_type=0;

-- 2단계 테스트 예산과 차원자료 삭제. 기존 1단계 자료는 accounting_budgets에 보존됩니다.
DELETE FROM accounting_budget_plans;
DELETE FROM accounting_resolution_dimensions;
DELETE FROM accounting_journal_line_dimensions;

-- 기본 예산을 다시 차원형 예산에 복사하려면 사이트를 새로 접속합니다.
