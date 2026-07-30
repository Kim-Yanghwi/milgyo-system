-- v34: 회계 조회·첨부파일 처리에 자주 사용되는 조건의 복합 인덱스
CREATE INDEX IF NOT EXISTS idx_acc_attach_active_reference
ON accounting_attachments(reference_type, reference_id, deleted_at, uploaded_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_acc_card_tx_card
ON accounting_card_transactions(card_id, transaction_date DESC, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_acc_card_tx_year_date
ON accounting_card_transactions(transaction_date DESC, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_acc_donation_year_receipt
ON accounting_donations(fiscal_year, receipt_status, donation_date DESC, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_acc_asset_status_date
ON accounting_assets(status, acquisition_date DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_acc_branch_year_period_status
ON accounting_branch_reports(fiscal_year, period_type, period_key, status, entity_id);

INSERT INTO accounting_meta(meta_key,meta_value,updated_at)
VALUES ('schema_version','2026-07-30.2',CURRENT_TIMESTAMP)
ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value,updated_at=excluded.updated_at;
