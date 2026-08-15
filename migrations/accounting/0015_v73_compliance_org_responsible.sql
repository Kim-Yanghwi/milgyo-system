-- v73: 규정대응 화면 조직도 연계 및 공공조달 책임자 관리
ALTER TABLE accounting_procurement_reviews ADD COLUMN responsible_user_id TEXT;
ALTER TABLE accounting_procurement_reviews ADD COLUMN responsible_name TEXT;

CREATE INDEX IF NOT EXISTS idx_procurement_responsible
ON accounting_procurement_reviews(responsible_user_id, fiscal_year, status);

INSERT INTO accounting_meta(meta_key,meta_value,updated_at)
VALUES ('schema_version','2026-08-16.1',CURRENT_TIMESTAMP)
ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value,updated_at=excluded.updated_at;
