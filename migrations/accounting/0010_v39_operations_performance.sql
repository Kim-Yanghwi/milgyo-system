-- v39: 회계 실무관리 조회 성능 보강

CREATE INDEX IF NOT EXISTS idx_import_tx_status_date
  ON accounting_import_transactions(status, transaction_date DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_import_batch_created
  ON accounting_import_batches(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_reconciliation_year_month
  ON accounting_reconciliation_periods(fiscal_year, period_month DESC, source_type, source_account_id);

CREATE INDEX IF NOT EXISTS idx_contract_year_status
  ON accounting_contracts(contract_date, status, end_date, vendor_id);

CREATE INDEX IF NOT EXISTS idx_contract_budget_dimensions
  ON accounting_contracts(
    contract_date, status, account_code, department, project,
    book_type_code, entity_id, fund_id
  );

CREATE INDEX IF NOT EXISTS idx_contract_payment_contract_status
  ON accounting_contract_payments(contract_id, status, amount);

CREATE INDEX IF NOT EXISTS idx_vendor_active_name
  ON accounting_vendors(active, name);

CREATE INDEX IF NOT EXISTS idx_donation_receipt_candidates
  ON accounting_donations(fiscal_year, receipt_status, donation_date, donation_no);

