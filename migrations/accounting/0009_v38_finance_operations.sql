-- v38: 실무 회계운영(거래 대사, 예산 변경통제, 거래처·계약, 전자기부금영수증 연계)

CREATE TABLE IF NOT EXISTS accounting_bank_accounts (
  id TEXT PRIMARY KEY,
  account_code TEXT NOT NULL UNIQUE,
  bank_name TEXT NOT NULL,
  account_alias TEXT NOT NULL,
  masked_number TEXT,
  settlement_account_code TEXT NOT NULL DEFAULT '1120',
  book_type_code TEXT NOT NULL DEFAULT 'general',
  entity_id TEXT NOT NULL DEFAULT 'ENTITY-HQ',
  fund_id TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounting_import_batches (
  id TEXT PRIMARY KEY,
  batch_no TEXT NOT NULL UNIQUE,
  source_type TEXT NOT NULL,
  source_account_id TEXT NOT NULL,
  period_start TEXT,
  period_end TEXT,
  statement_balance INTEGER,
  original_filename TEXT,
  total_rows INTEGER NOT NULL DEFAULT 0,
  imported_rows INTEGER NOT NULL DEFAULT 0,
  duplicate_rows INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'imported',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounting_import_transactions (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  external_key TEXT NOT NULL UNIQUE,
  transaction_date TEXT NOT NULL,
  posted_date TEXT,
  direction TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  counterparty TEXT NOT NULL DEFAULT '',
  amount INTEGER NOT NULL,
  tax_amount INTEGER NOT NULL DEFAULT 0,
  balance INTEGER,
  approval_no TEXT,
  original_json TEXT NOT NULL DEFAULT '{}',
  classification_account_code TEXT,
  status TEXT NOT NULL DEFAULT 'unmatched',
  suggested_type TEXT,
  suggested_id TEXT,
  suggested_score INTEGER,
  suggested_reason TEXT,
  matched_type TEXT,
  matched_id TEXT,
  matched_by TEXT,
  matched_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounting_matching_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'all',
  direction TEXT NOT NULL DEFAULT 'all',
  keyword TEXT NOT NULL,
  account_code TEXT NOT NULL,
  counterparty_alias TEXT,
  priority INTEGER NOT NULL DEFAULT 100,
  active INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounting_reconciliation_periods (
  id TEXT PRIMARY KEY,
  fiscal_year INTEGER NOT NULL,
  period_month INTEGER NOT NULL,
  source_type TEXT NOT NULL,
  source_account_id TEXT NOT NULL,
  settlement_account_code TEXT NOT NULL,
  statement_balance INTEGER,
  book_balance INTEGER,
  difference_amount INTEGER,
  transaction_count INTEGER NOT NULL DEFAULT 0,
  unmatched_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open',
  completed_by TEXT,
  completed_at TEXT,
  memo TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(fiscal_year, period_month, source_type, source_account_id)
);

CREATE TABLE IF NOT EXISTS accounting_budget_change_requests (
  id TEXT PRIMARY KEY,
  request_no TEXT NOT NULL UNIQUE,
  fiscal_year INTEGER NOT NULL,
  change_type TEXT NOT NULL,
  target_budget_id TEXT,
  source_budget_id TEXT,
  requested_amount INTEGER NOT NULL,
  reason TEXT NOT NULL,
  valid_until TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  requested_by_user_id TEXT NOT NULL,
  requested_by_name TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  reviewed_by_user_id TEXT,
  reviewed_by_name TEXT,
  reviewed_at TEXT,
  review_memo TEXT,
  consumed_by_resolution_id TEXT,
  consumed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounting_budget_versions (
  id TEXT PRIMARY KEY,
  budget_id TEXT NOT NULL,
  version_no INTEGER NOT NULL,
  snapshot_type TEXT NOT NULL,
  original_amount INTEGER NOT NULL,
  supplementary_amount INTEGER NOT NULL,
  transfer_in INTEGER NOT NULL,
  transfer_out INTEGER NOT NULL,
  memo TEXT,
  change_request_id TEXT,
  effective_by TEXT,
  effective_at TEXT NOT NULL,
  UNIQUE(budget_id, version_no)
);

CREATE TABLE IF NOT EXISTS accounting_vendors (
  id TEXT PRIMARY KEY,
  vendor_code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  business_no TEXT UNIQUE,
  representative TEXT,
  contact_name TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  bank_name TEXT,
  bank_account_masked TEXT,
  bank_account_fingerprint TEXT,
  bank_account_holder TEXT,
  conflict_checked_at TEXT,
  conflict_note TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounting_vendor_bank_changes (
  id TEXT PRIMARY KEY,
  vendor_id TEXT NOT NULL,
  old_bank_name TEXT,
  old_account_masked TEXT,
  new_bank_name TEXT NOT NULL,
  new_account_masked TEXT NOT NULL,
  new_account_fingerprint TEXT NOT NULL,
  new_account_holder TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  requested_by_user_id TEXT NOT NULL,
  requested_by_name TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  reviewed_by_user_id TEXT,
  reviewed_by_name TEXT,
  reviewed_at TEXT,
  review_memo TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounting_contracts (
  id TEXT PRIMARY KEY,
  contract_no TEXT NOT NULL UNIQUE,
  vendor_id TEXT NOT NULL,
  title TEXT NOT NULL,
  contract_type TEXT NOT NULL DEFAULT 'service',
  procurement_method TEXT NOT NULL DEFAULT 'competitive',
  contract_amount INTEGER NOT NULL,
  contract_date TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  renewal_notice_days INTEGER NOT NULL DEFAULT 30,
  department TEXT NOT NULL DEFAULT '',
  project TEXT NOT NULL DEFAULT '',
  account_code TEXT NOT NULL,
  book_type_code TEXT NOT NULL DEFAULT 'general',
  entity_id TEXT NOT NULL DEFAULT 'ENTITY-HQ',
  fund_id TEXT NOT NULL DEFAULT '',
  sole_source_reason TEXT,
  multi_quote_checked INTEGER NOT NULL DEFAULT 0,
  conflict_checked INTEGER NOT NULL DEFAULT 0,
  conflict_note TEXT,
  inspection_required INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',
  memo TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounting_contract_payments (
  id TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL,
  payment_seq INTEGER NOT NULL,
  payment_name TEXT NOT NULL,
  due_date TEXT,
  amount INTEGER NOT NULL,
  inspection_date TEXT,
  invoice_date TEXT,
  resolution_id TEXT,
  journal_id TEXT,
  status TEXT NOT NULL DEFAULT 'scheduled',
  paid_at TEXT,
  memo TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(contract_id, payment_seq),
  UNIQUE(resolution_id)
);

ALTER TABLE accounting_resolutions ADD COLUMN vendor_id TEXT;
ALTER TABLE accounting_resolutions ADD COLUMN contract_id TEXT;
ALTER TABLE accounting_resolutions ADD COLUMN budget_exception_id TEXT;

CREATE TABLE IF NOT EXISTS accounting_donation_export_batches (
  id TEXT PRIMARY KEY,
  export_no TEXT NOT NULL UNIQUE,
  fiscal_year INTEGER NOT NULL,
  export_type TEXT NOT NULL DEFAULT 'hometax_workbook',
  status TEXT NOT NULL DEFAULT 'created',
  item_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  original_result_filename TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  processed_by TEXT,
  processed_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounting_donation_export_items (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  donation_id TEXT NOT NULL,
  donation_no TEXT NOT NULL,
  export_status TEXT NOT NULL DEFAULT 'exported',
  external_receipt_no TEXT,
  result_code TEXT,
  result_message TEXT,
  processed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(batch_id, donation_id)
);

CREATE INDEX IF NOT EXISTS idx_import_tx_batch_status
  ON accounting_import_transactions(batch_id, status, transaction_date);
CREATE INDEX IF NOT EXISTS idx_import_tx_date_status
  ON accounting_import_transactions(transaction_date, status, source_type);
CREATE INDEX IF NOT EXISTS idx_reconciliation_period_status
  ON accounting_reconciliation_periods(fiscal_year, period_month, status);
CREATE INDEX IF NOT EXISTS idx_budget_change_status
  ON accounting_budget_change_requests(fiscal_year, status, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_budget_version_budget
  ON accounting_budget_versions(budget_id, version_no DESC);
CREATE INDEX IF NOT EXISTS idx_vendor_name_business
  ON accounting_vendors(name, business_no);
CREATE INDEX IF NOT EXISTS idx_vendor_bank_change_status
  ON accounting_vendor_bank_changes(status, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_contract_end_status
  ON accounting_contracts(status, end_date, vendor_id);
CREATE INDEX IF NOT EXISTS idx_contract_payment_due
  ON accounting_contract_payments(status, due_date, contract_id);
CREATE INDEX IF NOT EXISTS idx_donation_export_year_status
  ON accounting_donation_export_batches(fiscal_year, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_donation_export_item_donation
  ON accounting_donation_export_items(donation_id, export_status);

INSERT INTO accounting_meta(meta_key,meta_value,updated_at)
VALUES ('schema_version','2026-08-04.1',CURRENT_TIMESTAMP)
ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value,updated_at=excluded.updated_at;
