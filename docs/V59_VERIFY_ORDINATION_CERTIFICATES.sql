-- 수계증서 테이블 존재 확인
SELECT name FROM sqlite_master
WHERE type='table' AND name='ordination_certificates';

-- 컬럼 확인
PRAGMA table_info(ordination_certificates);

-- 인덱스 확인
SELECT name, sql FROM sqlite_master
WHERE type='index' AND tbl_name='ordination_certificates'
ORDER BY name;

-- 연도별 발급번호 중복 여부: 결과가 없어야 정상
SELECT issue_year, sequence_no, COUNT(*) AS duplicate_count
FROM ordination_certificates
GROUP BY issue_year, sequence_no
HAVING COUNT(*) > 1;

-- 요청 식별값 중복 여부: 결과가 없어야 정상
SELECT request_id, COUNT(*) AS duplicate_count
FROM ordination_certificates
WHERE request_id IS NOT NULL
GROUP BY request_id
HAVING COUNT(*) > 1;

-- 최근 발급내역 확인
SELECT certificate_no, recipient_name, dharma_name_hanja, dharma_name_korean,
       ordination_date, buddhist_year, status, issued_by_name, issued_at
FROM ordination_certificates
ORDER BY ordination_date DESC, sequence_no DESC
LIMIT 20;
