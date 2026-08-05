-- v61: 재직증명서 발급명의 직함·계정 선택값을 발급 시점 기준으로 보존
ALTER TABLE employment_certificates
  ADD COLUMN signatory_title TEXT NOT NULL DEFAULT '이사장';

ALTER TABLE employment_certificates
  ADD COLUMN signatory_user_id TEXT;

ALTER TABLE employment_certificates
  ADD COLUMN signatory_name TEXT NOT NULL DEFAULT '김양휘';
