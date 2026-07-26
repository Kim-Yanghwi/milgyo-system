-- v26 회계 테스트 거래자료 초기화
-- 회계연도, 계정과목, 회계구분, 조직, 재원 등 기준정보는 유지합니다.

-- 전표 분개 차원
DELETE FROM accounting_journal_line_dimensions;

-- 분개 및 전표
DELETE FROM accounting_journal_lines;
DELETE FROM accounting_journals;

-- 결의 차원 및 결의서
DELETE FROM accounting_resolution_dimensions;
DELETE FROM accounting_resolutions;

-- 대시보드 및 결산용 월별 집계
DELETE FROM accounting_monthly_summary;

-- 테스트 회계 감사기록
DELETE FROM accounting_audit_logs;

-- 결의번호·전표번호 순번 초기화
DELETE FROM accounting_sequences;
