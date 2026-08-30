-- 대한불교밀교종 종단관리시스템 회계 전용 D1 초기 스키마
-- 대상 DB: milgyo-accounting-db
-- 실제 회계자료가 없는 초기 분리 단계용

CREATE TABLE IF NOT EXISTS accounting_fiscal_years (
  year INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  base_currency TEXT NOT NULL DEFAULT 'KRW',
  status TEXT NOT NULL DEFAULT 'open',
  created_by TEXT,
  created_at TEXT NOT NULL,
  closed_by TEXT,
  closed_at TEXT
);

CREATE TABLE IF NOT EXISTS accounting_accounts (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  account_type TEXT NOT NULL,
  normal_side TEXT NOT NULL,
  parent_code TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  system_account INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounting_budgets (
  id TEXT PRIMARY KEY,
  fiscal_year INTEGER NOT NULL,
  department TEXT NOT NULL DEFAULT '',
  project TEXT NOT NULL DEFAULT '',
  account_code TEXT NOT NULL,
  original_amount INTEGER NOT NULL DEFAULT 0,
  supplementary_amount INTEGER NOT NULL DEFAULT 0,
  transfer_in INTEGER NOT NULL DEFAULT 0,
  transfer_out INTEGER NOT NULL DEFAULT 0,
  memo TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(fiscal_year, department, project, account_code)
);

CREATE TABLE IF NOT EXISTS accounting_resolutions (
  id TEXT PRIMARY KEY,
  resolution_no TEXT NOT NULL UNIQUE,
  resolution_type TEXT NOT NULL,
  fiscal_year INTEGER NOT NULL,
  resolution_date TEXT NOT NULL,
  title TEXT NOT NULL,
  department TEXT NOT NULL DEFAULT '',
  project TEXT NOT NULL DEFAULT '',
  counterparty TEXT NOT NULL DEFAULT '',
  account_code TEXT NOT NULL,
  settlement_account_code TEXT NOT NULL,
  amount INTEGER NOT NULL,
  tax_amount INTEGER NOT NULL DEFAULT 0,
  payment_method TEXT,
  memo TEXT,
  document_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'draft',
  journal_id TEXT,
  created_by_user_id TEXT NOT NULL,
  created_by_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounting_journals (
  id TEXT PRIMARY KEY,
  journal_no TEXT NOT NULL UNIQUE,
  fiscal_year INTEGER NOT NULL,
  journal_date TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'posted',
  document_id TEXT,
  reversed_journal_id TEXT,
  created_by TEXT,
  approved_by TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounting_journal_lines (
  id TEXT PRIMARY KEY,
  journal_id TEXT NOT NULL,
  line_no INTEGER NOT NULL,
  account_code TEXT NOT NULL,
  debit INTEGER NOT NULL DEFAULT 0,
  credit INTEGER NOT NULL DEFAULT 0,
  department TEXT NOT NULL DEFAULT '',
  project TEXT NOT NULL DEFAULT '',
  counterparty TEXT NOT NULL DEFAULT '',
  memo TEXT,
  UNIQUE(journal_id, line_no)
);

CREATE TABLE IF NOT EXISTS accounting_closings (
  id TEXT PRIMARY KEY,
  fiscal_year INTEGER NOT NULL,
  period_month INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'closed',
  closed_by TEXT NOT NULL,
  closed_at TEXT NOT NULL,
  memo TEXT,
  UNIQUE(fiscal_year, period_month)
);

CREATE TABLE IF NOT EXISTS accounting_audit_logs (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  actor_user_id TEXT,
  actor_name TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounting_sequences (
  seq_key TEXT PRIMARY KEY,
  last_seq INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS accounting_meta (
  meta_key TEXT PRIMARY KEY,
  meta_value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounting_book_types (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  system_type INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounting_entities (
  id TEXT PRIMARY KEY,
  entity_code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  parent_id TEXT,
  department_path TEXT,
  registration_no TEXT,
  representative TEXT,
  address TEXT,
  consolidation_enabled INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounting_funds (
  id TEXT PRIMARY KEY,
  fund_code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  fund_type TEXT NOT NULL,
  purpose TEXT,
  restriction_note TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  system_fund INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounting_budget_plans (
  id TEXT PRIMARY KEY,
  fiscal_year INTEGER NOT NULL,
  book_type_code TEXT NOT NULL DEFAULT 'general',
  entity_id TEXT NOT NULL DEFAULT '',
  fund_id TEXT NOT NULL DEFAULT '',
  department TEXT NOT NULL DEFAULT '',
  project TEXT NOT NULL DEFAULT '',
  account_code TEXT NOT NULL,
  original_amount INTEGER NOT NULL DEFAULT 0,
  supplementary_amount INTEGER NOT NULL DEFAULT 0,
  transfer_in INTEGER NOT NULL DEFAULT 0,
  transfer_out INTEGER NOT NULL DEFAULT 0,
  memo TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(fiscal_year, book_type_code, entity_id, fund_id, department, project, account_code)
);

CREATE TABLE IF NOT EXISTS accounting_resolution_dimensions (
  resolution_id TEXT PRIMARY KEY,
  book_type_code TEXT NOT NULL DEFAULT 'general',
  entity_id TEXT NOT NULL DEFAULT '',
  fund_id TEXT NOT NULL DEFAULT '',
  source_category TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounting_journal_line_dimensions (
  journal_line_id TEXT PRIMARY KEY,
  book_type_code TEXT NOT NULL DEFAULT 'general',
  entity_id TEXT NOT NULL DEFAULT '',
  fund_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounting_donors (
  id TEXT PRIMARY KEY,
  donor_no TEXT NOT NULL UNIQUE,
  donor_type TEXT NOT NULL,
  name TEXT NOT NULL,
  identifier_masked TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  receipt_consent INTEGER NOT NULL DEFAULT 0,
  memo TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounting_donations (
  id TEXT PRIMARY KEY,
  donation_no TEXT NOT NULL UNIQUE,
  fiscal_year INTEGER NOT NULL,
  donation_date TEXT NOT NULL,
  donor_id TEXT,
  donation_category TEXT NOT NULL,
  book_type_code TEXT NOT NULL DEFAULT 'general',
  entity_id TEXT NOT NULL DEFAULT '',
  fund_id TEXT NOT NULL DEFAULT '',
  amount INTEGER NOT NULL,
  payment_method TEXT,
  account_code TEXT NOT NULL DEFAULT '4200',
  settlement_account_code TEXT NOT NULL DEFAULT '1120',
  purpose TEXT,
  memo TEXT,
  receipt_requested INTEGER NOT NULL DEFAULT 0,
  receipt_status TEXT NOT NULL DEFAULT 'not_requested',
  receipt_no TEXT,
  receipt_issued_at TEXT,
  receipt_cancelled_at TEXT,
  journal_id TEXT,
  status TEXT NOT NULL DEFAULT 'registered',
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounting_assets (
  id TEXT PRIMARY KEY,
  asset_no TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  acquisition_date TEXT NOT NULL,
  acquisition_cost INTEGER NOT NULL,
  useful_life_months INTEGER NOT NULL DEFAULT 0,
  depreciation_method TEXT NOT NULL DEFAULT 'straight_line',
  residual_value INTEGER NOT NULL DEFAULT 0,
  book_type_code TEXT NOT NULL DEFAULT 'general',
  entity_id TEXT NOT NULL DEFAULT '',
  fund_id TEXT NOT NULL DEFAULT '',
  department TEXT NOT NULL DEFAULT '',
  location TEXT,
  custodian TEXT,
  asset_account_code TEXT NOT NULL DEFAULT '1500',
  status TEXT NOT NULL DEFAULT 'in_use',
  disposal_date TEXT,
  disposal_amount INTEGER,
  memo TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounting_cards (
  id TEXT PRIMARY KEY,
  card_code TEXT NOT NULL UNIQUE,
  card_label TEXT NOT NULL,
  issuer TEXT,
  masked_number TEXT,
  holder TEXT,
  book_type_code TEXT NOT NULL DEFAULT 'general',
  entity_id TEXT NOT NULL DEFAULT '',
  department TEXT NOT NULL DEFAULT '',
  settlement_account_code TEXT NOT NULL DEFAULT '2110',
  active INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounting_card_transactions (
  id TEXT PRIMARY KEY,
  transaction_no TEXT NOT NULL UNIQUE,
  card_id TEXT NOT NULL,
  transaction_date TEXT NOT NULL,
  merchant TEXT NOT NULL,
  amount INTEGER NOT NULL,
  tax_amount INTEGER NOT NULL DEFAULT 0,
  account_code TEXT,
  book_type_code TEXT NOT NULL DEFAULT 'general',
  entity_id TEXT NOT NULL DEFAULT '',
  fund_id TEXT NOT NULL DEFAULT '',
  department TEXT NOT NULL DEFAULT '',
  project TEXT NOT NULL DEFAULT '',
  memo TEXT,
  status TEXT NOT NULL DEFAULT 'unmatched',
  resolution_id TEXT,
  journal_id TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounting_branch_reports (
  id TEXT PRIMARY KEY,
  fiscal_year INTEGER NOT NULL,
  period_type TEXT NOT NULL,
  period_key TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  book_type_code TEXT NOT NULL DEFAULT 'general',
  income_total INTEGER NOT NULL DEFAULT 0,
  expense_total INTEGER NOT NULL DEFAULT 0,
  asset_total INTEGER NOT NULL DEFAULT 0,
  liability_total INTEGER NOT NULL DEFAULT 0,
  cash_balance INTEGER NOT NULL DEFAULT 0,
  donation_total INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft',
  detail_json TEXT NOT NULL DEFAULT '{}',
  memo TEXT,
  submitted_by TEXT,
  submitted_at TEXT,
  reviewed_by TEXT,
  reviewed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(fiscal_year, period_type, period_key, entity_id, book_type_code)
);

CREATE TABLE IF NOT EXISTS accounting_special_sequences (
  seq_key TEXT PRIMARY KEY,
  last_seq INTEGER NOT NULL DEFAULT 0
);

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

-- v27 이전 회계 첨부파일 기본 테이블입니다.
-- 후속 0004_v27_attachment_operations.sql이 운영정책·보존·검사 열을 추가하므로,
-- 신규 환경에서도 기준 스키마와 마이그레이션을 순서대로 재현할 수 있어야 합니다.
CREATE TABLE IF NOT EXISTS accounting_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reference_type TEXT NOT NULL,
  reference_id TEXT NOT NULL,
  file_category TEXT NOT NULL DEFAULT 'general',
  original_filename TEXT NOT NULL,
  stored_filename TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  size_bytes INTEGER NOT NULL,
  checksum_sha256 TEXT,
  uploaded_by TEXT NOT NULL,
  uploaded_at TEXT NOT NULL,
  deleted_by TEXT,
  deleted_at TEXT,
  CHECK (size_bytes >= 0)
);

CREATE INDEX IF NOT EXISTS idx_accounting_attachments_reference
  ON accounting_attachments(reference_type,reference_id,uploaded_at DESC,id DESC);

CREATE INDEX IF NOT EXISTS idx_acc_budget_year
  ON accounting_budgets (fiscal_year, department, account_code);
CREATE INDEX IF NOT EXISTS idx_acc_resolution_status
  ON accounting_resolutions (status, resolution_date DESC);
CREATE INDEX IF NOT EXISTS idx_acc_resolution_document
  ON accounting_resolutions (document_id);
CREATE INDEX IF NOT EXISTS idx_acc_journal_date
  ON accounting_journals (fiscal_year, journal_date DESC);
CREATE INDEX IF NOT EXISTS idx_acc_line_account
  ON accounting_journal_lines (account_code, journal_id);
CREATE INDEX IF NOT EXISTS idx_acc_line_department
  ON accounting_journal_lines (department, project);
CREATE INDEX IF NOT EXISTS idx_acc_budget_plan_dims
  ON accounting_budget_plans (fiscal_year, book_type_code, entity_id, fund_id, account_code);
CREATE INDEX IF NOT EXISTS idx_acc_resolution_dims
  ON accounting_resolution_dimensions (book_type_code, entity_id, fund_id);
CREATE INDEX IF NOT EXISTS idx_acc_journal_line_dims
  ON accounting_journal_line_dimensions (book_type_code, entity_id, fund_id);
CREATE INDEX IF NOT EXISTS idx_acc_donation_date
  ON accounting_donations (fiscal_year, donation_date DESC);
CREATE INDEX IF NOT EXISTS idx_acc_donation_donor
  ON accounting_donations (donor_id);
CREATE INDEX IF NOT EXISTS idx_acc_asset_entity
  ON accounting_assets (entity_id, status);
CREATE INDEX IF NOT EXISTS idx_acc_card_tx_status
  ON accounting_card_transactions (status, transaction_date DESC);
CREATE INDEX IF NOT EXISTS idx_acc_branch_period
  ON accounting_branch_reports (fiscal_year, period_type, period_key, status);

INSERT OR IGNORE INTO accounting_fiscal_years
(year, name, start_date, end_date, base_currency, status, created_by, created_at)
VALUES
(2026, '2026 회계연도', '2026-01-01', '2026-12-31', 'KRW', 'open', 'system', CURRENT_TIMESTAMP),
(2027, '2027 회계연도', '2027-01-01', '2027-12-31', 'KRW', 'open', 'system', CURRENT_TIMESTAMP),
(2028, '2028 회계연도', '2028-01-01', '2028-12-31', 'KRW', 'open', 'system', CURRENT_TIMESTAMP),
(2029, '2029 회계연도', '2029-01-01', '2029-12-31', 'KRW', 'open', 'system', CURRENT_TIMESTAMP),
(2030, '2030 회계연도', '2030-01-01', '2030-12-31', 'KRW', 'open', 'system', CURRENT_TIMESTAMP);

INSERT OR IGNORE INTO accounting_accounts
(code, name, account_type, normal_side, parent_code, active, system_account, created_at, updated_at)
VALUES
('1000','자산','asset','debit',NULL,1,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
('1100','현금및현금성자산','asset','debit','1000',1,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
('1110','현금','asset','debit','1100',1,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
('1120','보통예금','asset','debit','1100',1,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
('1140','부가가치세대급금','asset','debit','1000',1,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
('1200','미수금','asset','debit','1000',1,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
('1300','선급금','asset','debit','1000',1,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
('1500','유형자산','asset','debit','1000',1,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
('2000','부채','liability','credit',NULL,1,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
('2100','미지급금','liability','credit','2000',1,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
('2110','법인카드미지급금','liability','credit','2100',1,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
('2200','예수금','liability','credit','2000',1,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
('2210','부가가치세예수금','liability','credit','2200',1,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
('2220','소득세예수금','liability','credit','2200',1,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
('2230','지방소득세예수금','liability','credit','2200',1,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
('3000','순자산','equity','credit',NULL,1,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
('3100','기본순자산','equity','credit','3000',1,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
('3200','이월잉여금','equity','credit','3000',1,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
('4000','수입','revenue','credit',NULL,1,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
('4100','회비수입','revenue','credit','4000',1,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
('4200','후원금·보시금수입','revenue','credit','4000',1,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
('4210','목적지정기부금수입','revenue','credit','4200',1,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
('4300','교육·법회·의례수입','revenue','credit','4000',1,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
('4400','보조금·지원금수입','revenue','credit','4000',1,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
('4900','기타수입','revenue','credit','4000',1,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
('5000','지출','expense','debit',NULL,1,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
('5100','인건비','expense','debit','5000',1,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
('5200','임차료','expense','debit','5000',1,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
('5300','공공요금·제세공과금','expense','debit','5000',1,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
('5400','사무용품·소모품비','expense','debit','5000',1,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
('5500','여비·교통비','expense','debit','5000',1,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
('5600','회의비·업무추진비','expense','debit','5000',1,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
('5700','교육·연수비','expense','debit','5000',1,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
('5800','법회·의례·포교사업비','expense','debit','5000',1,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
('5900','기타운영비','expense','debit','5000',1,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
('6100','목적사업비','expense','debit','5000',1,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
('6200','시설비·수선비','expense','debit','5000',1,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
('6300','지원금·보조금지출','expense','debit','5000',1,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);

INSERT OR IGNORE INTO accounting_book_types
(code, name, description, active, system_type, created_at, updated_at)
VALUES
('general','일반회계','종단의 일반적인 목적사업과 운영 활동을 관리합니다.',1,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
('purpose','목적사업회계','지정 목적·기금·보조사업 등 사용처가 제한된 회계를 관리합니다.',1,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
('revenue','수익사업회계','수익사업에서 발생하는 수입·지출과 자산을 구분 관리합니다.',1,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);

INSERT OR IGNORE INTO accounting_entities
(id, entity_code, name, entity_type, parent_id, department_path, consolidation_enabled, active, created_by, created_at, updated_at)
VALUES
('ENTITY-HQ','HQ','종단 본부','headquarters',NULL,'사무처',1,1,'system',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);

INSERT OR IGNORE INTO accounting_funds
(id, fund_code, name, fund_type, purpose, active, system_fund, created_by, created_at, updated_at)
VALUES
('FUND-GENERAL','FUND-GENERAL','일반재원','unrestricted','사용 목적이 별도로 제한되지 않은 일반재원',1,1,'system',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
('FUND-DESIGNATED','FUND-DESIGNATED','목적지정 기부금','designated_donation','기부자가 사용 목적을 지정한 기부금',1,1,'system',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
('FUND-GRANT','FUND-GRANT','보조금·지원금','grant','국가·지자체·기관의 보조금 및 지원금',1,1,'system',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
('FUND-RESERVE','FUND-RESERVE','적립금·준비금','reserve','장래 사업과 시설을 위한 적립 재원',1,1,'system',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);

INSERT OR IGNORE INTO accounting_meta (meta_key, meta_value, updated_at)
VALUES ('schema_version', '2026-07-26.4', CURRENT_TIMESTAMP);
