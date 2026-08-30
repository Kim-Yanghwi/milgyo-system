-- v83 pre-open performance hardening
-- Performance-only migration: no schema_version bump is required because no table/column contract changes.

CREATE INDEX IF NOT EXISTS idx_import_tx_match_target
  ON accounting_import_transactions(status, matched_type, matched_id);

CREATE INDEX IF NOT EXISTS idx_donations_auto_match
  ON accounting_donations(amount, status, donation_date, created_at);

CREATE INDEX IF NOT EXISTS idx_resolutions_auto_match
  ON accounting_resolutions(resolution_type, status, amount, resolution_date, created_at);

CREATE INDEX IF NOT EXISTS idx_card_transactions_auto_match
  ON accounting_card_transactions(card_id, status, amount, transaction_date, created_at);
