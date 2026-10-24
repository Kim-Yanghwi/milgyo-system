-- V109 사무국 배포 전후 점검 (읽기 전용 SELECT; DB 변경 없음)
-- Cloudflare D1의 MAIN/Preview 대상이 맞는지 먼저 확인하십시오.
-- 계정별 개인 정보 대신 부서/직책 조합과 건수만 집계합니다.
SELECT
  COALESCE(NULLIF(TRIM(department), ''), '(미지정)') AS department_value,
  COALESCE(NULLIF(TRIM(position), ''), '(미지정)') AS position_value,
  COUNT(*) AS account_count
FROM system_users
WHERE department LIKE '%사무국%'
   OR department = '사무처'
   OR position = '사무국장'
GROUP BY COALESCE(NULLIF(TRIM(department), ''), '(미지정)'), COALESCE(NULLIF(TRIM(position), ''), '(미지정)')
ORDER BY department_value, position_value;
