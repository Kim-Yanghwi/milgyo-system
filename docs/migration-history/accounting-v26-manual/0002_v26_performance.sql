CREATE TABLE IF NOT EXISTS accounting_monthly_summary (
  fiscal_year INTEGER NOT NULL,
  period_month INTEGER NOT NULL,
  book_type_code TEXT NOT NULL DEFAULT 'general',
  entity_id TEXT NOT NULL DEFAULT 'ENTITY-HQ',
  fund_id TEXT NOT NULL DEFAULT '',
  account_code TEXT NOT NULL,
  department TEXT NOT NULL DEFAULT '',
  project TEXT NOT NULL DEFAULT '',
  debit_total INTEGER NOT NULL DEFAULT 0,
  credit_total INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (fiscal_year,period_month,book_type_code,entity_id,fund_id,account_code,department,project)
);
CREATE INDEX IF NOT EXISTS idx_acc_monthly_year_dims ON accounting_monthly_summary(fiscal_year,period_month,book_type_code,entity_id,fund_id);
CREATE INDEX IF NOT EXISTS idx_acc_monthly_account ON accounting_monthly_summary(fiscal_year,account_code,department,project);
CREATE INDEX IF NOT EXISTS idx_acc_resolution_cursor ON accounting_resolutions(fiscal_year,resolution_date DESC,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS idx_acc_journal_cursor ON accounting_journals(fiscal_year,journal_date DESC,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS idx_acc_donor_cursor ON accounting_donors(active,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS idx_acc_asset_cursor ON accounting_assets(status,acquisition_date DESC,id DESC);
CREATE INDEX IF NOT EXISTS idx_acc_card_tx_date ON accounting_card_transactions(transaction_date DESC,created_at DESC,id DESC);
DELETE FROM accounting_monthly_summary;
INSERT INTO accounting_monthly_summary (
  fiscal_year,period_month,book_type_code,entity_id,fund_id,account_code,department,project,debit_total,credit_total,updated_at
)
SELECT j.fiscal_year,CAST(substr(j.journal_date,6,2) AS INTEGER),COALESCE(d.book_type_code,'general'),COALESCE(d.entity_id,'ENTITY-HQ'),COALESCE(d.fund_id,''),l.account_code,COALESCE(l.department,''),COALESCE(l.project,''),SUM(l.debit),SUM(l.credit),CURRENT_TIMESTAMP
FROM accounting_journal_lines l
JOIN accounting_journals j ON j.id=l.journal_id
LEFT JOIN accounting_journal_line_dimensions d ON d.journal_line_id=l.id
WHERE j.status IN ('posted','reversed')
GROUP BY j.fiscal_year,CAST(substr(j.journal_date,6,2) AS INTEGER),COALESCE(d.book_type_code,'general'),COALESCE(d.entity_id,'ENTITY-HQ'),COALESCE(d.fund_id,''),l.account_code,COALESCE(l.department,''),COALESCE(l.project,'');
INSERT INTO accounting_meta(meta_key,meta_value,updated_at) VALUES ('schema_version','2026-07-26.4',CURRENT_TIMESTAMP)
ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value,updated_at=excluded.updated_at;
