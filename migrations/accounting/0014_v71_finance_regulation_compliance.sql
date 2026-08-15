-- v71: 정관·재무회계규정 개정 대응
-- 수익사업, 공공조달, 고유목적사업준비금, 회계점검·즉시보고, 업무용 차량 관리

CREATE TABLE IF NOT EXISTS accounting_revenue_businesses (
  id TEXT PRIMARY KEY,
  business_no TEXT NOT NULL UNIQUE,
  fiscal_year INTEGER NOT NULL,
  title TEXT NOT NULL,
  business_type TEXT NOT NULL,
  action_type TEXT NOT NULL DEFAULT 'new',
  charter_basis TEXT NOT NULL DEFAULT '',
  start_date TEXT,
  end_date TEXT,
  expected_income INTEGER NOT NULL DEFAULT 0,
  expected_expense INTEGER NOT NULL DEFAULT 0,
  department TEXT NOT NULL DEFAULT '',
  manager_name TEXT NOT NULL DEFAULT '',
  permit_status TEXT NOT NULL DEFAULT 'review',
  tax_review_status TEXT NOT NULL DEFAULT 'review',
  routine_annual_plan INTEGER NOT NULL DEFAULT 0,
  major_purpose_impact INTEGER NOT NULL DEFAULT 0,
  basic_property_impact INTEGER NOT NULL DEFAULT 0,
  borrowing_guarantee_impact INTEGER NOT NULL DEFAULT 0,
  major_financial_burden INTEGER NOT NULL DEFAULT 0,
  approval_level TEXT NOT NULL DEFAULT 'board',
  approval_reasons TEXT NOT NULL DEFAULT '',
  decision_no TEXT,
  status TEXT NOT NULL DEFAULT 'review',
  memo TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounting_procurement_reviews (
  id TEXT PRIMARY KEY,
  review_no TEXT NOT NULL UNIQUE,
  fiscal_year INTEGER NOT NULL,
  revenue_business_id TEXT,
  contract_id TEXT,
  agency TEXT NOT NULL,
  announcement_no TEXT,
  title TEXT NOT NULL,
  bid_method TEXT NOT NULL DEFAULT 'competitive',
  bid_date TEXT,
  opening_date TEXT,
  estimated_price INTEGER NOT NULL DEFAULT 0,
  planned_bid_amount INTEGER NOT NULL DEFAULT 0,
  actual_contract_amount INTEGER NOT NULL DEFAULT 0,
  delivery_due_date TEXT,
  delivery_place TEXT,
  contract_start TEXT,
  contract_end TEXT,
  business_registration_ok INTEGER NOT NULL DEFAULT 0,
  bidding_registration_ok INTEGER NOT NULL DEFAULT 0,
  qualification_ok INTEGER NOT NULL DEFAULT 0,
  competition_ok INTEGER NOT NULL DEFAULT 0,
  sanction_clear INTEGER NOT NULL DEFAULT 0,
  charter_scope_ok INTEGER NOT NULL DEFAULT 0,
  cost_material INTEGER NOT NULL DEFAULT 0,
  cost_outsource INTEGER NOT NULL DEFAULT 0,
  cost_labor INTEGER NOT NULL DEFAULT 0,
  cost_delivery INTEGER NOT NULL DEFAULT 0,
  cost_guarantee INTEGER NOT NULL DEFAULT 0,
  cost_other INTEGER NOT NULL DEFAULT 0,
  cost_contingency INTEGER NOT NULL DEFAULT 0,
  vat_status TEXT NOT NULL DEFAULT 'review',
  purpose_reserve_review TEXT NOT NULL DEFAULT 'review',
  expected_loss INTEGER NOT NULL DEFAULT 0,
  response_plan TEXT,
  related_party INTEGER NOT NULL DEFAULT 0,
  borrowing_or_guarantee INTEGER NOT NULL DEFAULT 0,
  basic_property_collateral INTEGER NOT NULL DEFAULT 0,
  material_financial_risk INTEGER NOT NULL DEFAULT 0,
  prior_year_income_override INTEGER NOT NULL DEFAULT 0,
  approval_level TEXT NOT NULL DEFAULT 'chairman',
  approval_reasons TEXT NOT NULL DEFAULT '',
  decision_no TEXT,
  authority_permit_no TEXT,
  next_board_reported INTEGER NOT NULL DEFAULT 0,
  next_board_report_date TEXT,
  status TEXT NOT NULL DEFAULT 'review',
  memo TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounting_procurement_guarantees (
  id TEXT PRIMARY KEY,
  guarantee_no TEXT NOT NULL UNIQUE,
  procurement_review_id TEXT NOT NULL,
  guarantee_type TEXT NOT NULL,
  provider TEXT NOT NULL,
  policy_no TEXT,
  amount INTEGER NOT NULL DEFAULT 0,
  fee INTEGER NOT NULL DEFAULT 0,
  start_date TEXT,
  end_date TEXT,
  recovered INTEGER NOT NULL DEFAULT 0,
  memo TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounting_purpose_reserves (
  id TEXT PRIMARY KEY,
  reserve_no TEXT NOT NULL UNIQUE,
  fiscal_year INTEGER NOT NULL,
  set_date TEXT NOT NULL,
  set_amount INTEGER NOT NULL,
  use_deadline TEXT,
  fund_id TEXT NOT NULL DEFAULT 'FUND-RESERVE',
  tax_review_status TEXT NOT NULL DEFAULT 'review',
  reviewer TEXT,
  memo TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounting_purpose_reserve_transactions (
  id TEXT PRIMARY KEY,
  reserve_id TEXT NOT NULL,
  transaction_date TEXT NOT NULL,
  transaction_type TEXT NOT NULL,
  amount INTEGER NOT NULL,
  purpose TEXT NOT NULL,
  resolution_id TEXT,
  memo TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounting_compliance_checks (
  id TEXT PRIMARY KEY,
  check_no TEXT NOT NULL UNIQUE,
  fiscal_year INTEGER NOT NULL,
  period_type TEXT NOT NULL,
  period_key TEXT NOT NULL,
  snapshot_json TEXT NOT NULL DEFAULT '{}',
  findings TEXT,
  corrective_action TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  reported_chairman INTEGER NOT NULL DEFAULT 0,
  reported_auditor INTEGER NOT NULL DEFAULT 0,
  completed_by TEXT,
  completed_at TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounting_finance_incidents (
  id TEXT PRIMARY KEY,
  report_no TEXT NOT NULL UNIQUE,
  fiscal_year INTEGER NOT NULL,
  occurred_at TEXT NOT NULL,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT NOT NULL,
  immediate_action TEXT,
  chairman_notified INTEGER NOT NULL DEFAULT 0,
  auditor_notified INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open',
  resolved_at TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounting_vehicle_records (
  id TEXT PRIMARY KEY,
  vehicle_no TEXT NOT NULL UNIQUE,
  management_type TEXT NOT NULL,
  asset_id TEXT,
  contract_id TEXT,
  plate_no TEXT,
  model_name TEXT NOT NULL,
  primary_user TEXT,
  purpose TEXT NOT NULL,
  contract_start TEXT,
  contract_end TEXT,
  monthly_cost INTEGER NOT NULL DEFAULT 0,
  insurer TEXT,
  insurance_end TEXT,
  approval_level TEXT NOT NULL DEFAULT 'chairman',
  decision_no TEXT,
  renewal_flag INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  succession_candidate TEXT,
  succession_price INTEGER NOT NULL DEFAULT 0,
  succession_price_basis TEXT,
  succession_counterparty_consent INTEGER NOT NULL DEFAULT 0,
  succession_no_loss INTEGER NOT NULL DEFAULT 0,
  succession_decision_no TEXT,
  memo TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounting_vehicle_logs (
  id TEXT PRIMARY KEY,
  vehicle_id TEXT NOT NULL,
  use_date TEXT NOT NULL,
  purpose TEXT NOT NULL,
  route TEXT,
  distance_km REAL NOT NULL DEFAULT 0,
  driver TEXT NOT NULL,
  memo TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_revenue_business_year_status ON accounting_revenue_businesses(fiscal_year,status,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_procurement_year_status ON accounting_procurement_reviews(fiscal_year,status,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_procurement_contract ON accounting_procurement_reviews(contract_id);
CREATE INDEX IF NOT EXISTS idx_procurement_guarantee_review ON accounting_procurement_guarantees(procurement_review_id,end_date);
CREATE INDEX IF NOT EXISTS idx_purpose_reserve_year ON accounting_purpose_reserves(fiscal_year,set_date DESC);
CREATE INDEX IF NOT EXISTS idx_purpose_reserve_tx ON accounting_purpose_reserve_transactions(reserve_id,transaction_date DESC);
CREATE INDEX IF NOT EXISTS idx_compliance_check_period ON accounting_compliance_checks(fiscal_year,period_type,period_key,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_finance_incident_status ON accounting_finance_incidents(fiscal_year,status,occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_vehicle_status ON accounting_vehicle_records(status,contract_end,insurance_end);
CREATE INDEX IF NOT EXISTS idx_vehicle_log_vehicle ON accounting_vehicle_logs(vehicle_id,use_date DESC);

INSERT INTO accounting_meta(meta_key,meta_value,updated_at)
VALUES ('schema_version','2026-08-15.4',CURRENT_TIMESTAMP)
ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value,updated_at=excluded.updated_at;
