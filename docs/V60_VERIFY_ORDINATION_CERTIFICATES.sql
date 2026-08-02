-- V60 신규 컬럼 확인
SELECT name, type, notnull, dflt_value
FROM pragma_table_info('ordination_certificates')
WHERE name IN ('include_top_seal', 'top_seal_key')
ORDER BY name;

-- 기대값
-- include_top_seal | INTEGER | 1 | 1
-- top_seal_key     | TEXT    | 1 | 'hyangcheonsa'

-- 신규 발급본의 도장 선택값·템플릿 확인
SELECT certificate_no,
       include_top_seal,
       top_seal_key,
       template_version,
       issued_at
FROM ordination_certificates
ORDER BY issued_at DESC
LIMIT 20;

-- 잘못된 도장 표시값 확인: 결과가 없어야 정상
SELECT id, certificate_no, include_top_seal
FROM ordination_certificates
WHERE include_top_seal NOT IN (0, 1) OR include_top_seal IS NULL;

-- 비어 있는 도장 키 확인: 결과가 없어야 정상
SELECT id, certificate_no, top_seal_key
FROM ordination_certificates
WHERE top_seal_key IS NULL OR TRIM(top_seal_key) = '';

-- 요청 식별값·연도별 순번 중복 확인: 결과가 없어야 정상
SELECT request_id, COUNT(*) AS duplicate_count
FROM ordination_certificates
WHERE request_id IS NOT NULL
GROUP BY request_id
HAVING COUNT(*) > 1;

SELECT issue_year, sequence_no, COUNT(*) AS duplicate_count
FROM ordination_certificates
GROUP BY issue_year, sequence_no
HAVING COUNT(*) > 1;
