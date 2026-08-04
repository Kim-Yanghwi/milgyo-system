PRAGMA defer_foreign_keys=TRUE;
CREATE TABLE accounting_fiscal_years (
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
INSERT INTO "accounting_fiscal_years" ("year","name","start_date","end_date","base_currency","status","created_by","created_at","closed_by","closed_at") VALUES(2026,'2026 회계연도','2026-01-01','2026-12-31','KRW','open','system','2026-07-26 12:32:16',NULL,NULL);
INSERT INTO "accounting_fiscal_years" ("year","name","start_date","end_date","base_currency","status","created_by","created_at","closed_by","closed_at") VALUES(2027,'2027 회계연도','2027-01-01','2027-12-31','KRW','open','system','2026-07-26 12:32:16',NULL,NULL);
INSERT INTO "accounting_fiscal_years" ("year","name","start_date","end_date","base_currency","status","created_by","created_at","closed_by","closed_at") VALUES(2028,'2028 회계연도','2028-01-01','2028-12-31','KRW','open','system','2026-07-26 12:32:16',NULL,NULL);
INSERT INTO "accounting_fiscal_years" ("year","name","start_date","end_date","base_currency","status","created_by","created_at","closed_by","closed_at") VALUES(2029,'2029 회계연도','2029-01-01','2029-12-31','KRW','open','system','2026-07-26 12:32:16',NULL,NULL);
INSERT INTO "accounting_fiscal_years" ("year","name","start_date","end_date","base_currency","status","created_by","created_at","closed_by","closed_at") VALUES(2030,'2030 회계연도','2030-01-01','2030-12-31','KRW','open','system','2026-07-26 12:32:16',NULL,NULL);
CREATE TABLE accounting_accounts (
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
INSERT INTO "accounting_accounts" ("code","name","account_type","normal_side","parent_code","active","system_account","created_at","updated_at") VALUES('1000','자산','asset','debit',NULL,1,1,'2026-07-26 12:32:16','2026-07-26 12:32:16');
INSERT INTO "accounting_accounts" ("code","name","account_type","normal_side","parent_code","active","system_account","created_at","updated_at") VALUES('1100','현금및현금성자산','asset','debit','1000',1,1,'2026-07-26 12:32:16','2026-07-26 12:32:16');
INSERT INTO "accounting_accounts" ("code","name","account_type","normal_side","parent_code","active","system_account","created_at","updated_at") VALUES('1110','현금','asset','debit','1100',1,1,'2026-07-26 12:32:16','2026-07-26 12:32:16');
INSERT INTO "accounting_accounts" ("code","name","account_type","normal_side","parent_code","active","system_account","created_at","updated_at") VALUES('1120','보통예금','asset','debit','1100',1,1,'2026-07-26 12:32:16','2026-07-26 12:32:16');
INSERT INTO "accounting_accounts" ("code","name","account_type","normal_side","parent_code","active","system_account","created_at","updated_at") VALUES('1130','법인카드미결제','asset','debit','1100',1,1,'2026-07-26 12:32:16','2026-07-26 12:32:16');
INSERT INTO "accounting_accounts" ("code","name","account_type","normal_side","parent_code","active","system_account","created_at","updated_at") VALUES('1200','미수금','asset','debit','1000',1,1,'2026-07-26 12:32:16','2026-07-26 12:32:16');
INSERT INTO "accounting_accounts" ("code","name","account_type","normal_side","parent_code","active","system_account","created_at","updated_at") VALUES('1300','선급금','asset','debit','1000',1,1,'2026-07-26 12:32:16','2026-07-26 12:32:16');
INSERT INTO "accounting_accounts" ("code","name","account_type","normal_side","parent_code","active","system_account","created_at","updated_at") VALUES('1500','유형자산','asset','debit','1000',1,1,'2026-07-26 12:32:16','2026-07-26 12:32:16');
INSERT INTO "accounting_accounts" ("code","name","account_type","normal_side","parent_code","active","system_account","created_at","updated_at") VALUES('2000','부채','liability','credit',NULL,1,1,'2026-07-26 12:32:16','2026-07-26 12:32:16');
INSERT INTO "accounting_accounts" ("code","name","account_type","normal_side","parent_code","active","system_account","created_at","updated_at") VALUES('2100','미지급금','liability','credit','2000',1,1,'2026-07-26 12:32:16','2026-07-26 12:32:16');
INSERT INTO "accounting_accounts" ("code","name","account_type","normal_side","parent_code","active","system_account","created_at","updated_at") VALUES('2200','예수금','liability','credit','2000',1,1,'2026-07-26 12:32:16','2026-07-26 12:32:16');
INSERT INTO "accounting_accounts" ("code","name","account_type","normal_side","parent_code","active","system_account","created_at","updated_at") VALUES('3000','순자산','equity','credit',NULL,1,1,'2026-07-26 12:32:16','2026-07-26 12:32:16');
INSERT INTO "accounting_accounts" ("code","name","account_type","normal_side","parent_code","active","system_account","created_at","updated_at") VALUES('3100','기본순자산','equity','credit','3000',1,1,'2026-07-26 12:32:16','2026-07-26 12:32:16');
INSERT INTO "accounting_accounts" ("code","name","account_type","normal_side","parent_code","active","system_account","created_at","updated_at") VALUES('3200','이월잉여금','equity','credit','3000',1,1,'2026-07-26 12:32:16','2026-07-26 12:32:16');
INSERT INTO "accounting_accounts" ("code","name","account_type","normal_side","parent_code","active","system_account","created_at","updated_at") VALUES('4000','수입','revenue','credit',NULL,1,1,'2026-07-26 12:32:16','2026-07-26 12:32:16');
INSERT INTO "accounting_accounts" ("code","name","account_type","normal_side","parent_code","active","system_account","created_at","updated_at") VALUES('4100','회비수입','revenue','credit','4000',1,1,'2026-07-26 12:32:16','2026-07-26 12:32:16');
INSERT INTO "accounting_accounts" ("code","name","account_type","normal_side","parent_code","active","system_account","created_at","updated_at") VALUES('4200','후원금·보시금수입','revenue','credit','4000',1,1,'2026-07-26 12:32:16','2026-07-26 12:32:16');
INSERT INTO "accounting_accounts" ("code","name","account_type","normal_side","parent_code","active","system_account","created_at","updated_at") VALUES('4210','목적지정기부금수입','revenue','credit','4200',1,1,'2026-07-26 12:32:16','2026-07-26 12:32:16');
INSERT INTO "accounting_accounts" ("code","name","account_type","normal_side","parent_code","active","system_account","created_at","updated_at") VALUES('4300','교육·법회·의례수입','revenue','credit','4000',1,1,'2026-07-26 12:32:16','2026-07-26 12:32:16');
INSERT INTO "accounting_accounts" ("code","name","account_type","normal_side","parent_code","active","system_account","created_at","updated_at") VALUES('4400','보조금·지원금수입','revenue','credit','4000',1,1,'2026-07-26 12:32:16','2026-07-26 12:32:16');
INSERT INTO "accounting_accounts" ("code","name","account_type","normal_side","parent_code","active","system_account","created_at","updated_at") VALUES('4900','기타수입','revenue','credit','4000',1,1,'2026-07-26 12:32:16','2026-07-26 12:32:16');
INSERT INTO "accounting_accounts" ("code","name","account_type","normal_side","parent_code","active","system_account","created_at","updated_at") VALUES('5000','지출','expense','debit',NULL,1,1,'2026-07-26 12:32:16','2026-07-26 12:32:16');
INSERT INTO "accounting_accounts" ("code","name","account_type","normal_side","parent_code","active","system_account","created_at","updated_at") VALUES('5100','인건비','expense','debit','5000',1,1,'2026-07-26 12:32:16','2026-07-26 12:32:16');
INSERT INTO "accounting_accounts" ("code","name","account_type","normal_side","parent_code","active","system_account","created_at","updated_at") VALUES('5200','임차료','expense','debit','5000',1,1,'2026-07-26 12:32:16','2026-07-26 12:32:16');
INSERT INTO "accounting_accounts" ("code","name","account_type","normal_side","parent_code","active","system_account","created_at","updated_at") VALUES('5300','공공요금·제세공과금','expense','debit','5000',1,1,'2026-07-26 12:32:16','2026-07-26 12:32:16');
INSERT INTO "accounting_accounts" ("code","name","account_type","normal_side","parent_code","active","system_account","created_at","updated_at") VALUES('5400','사무용품·소모품비','expense','debit','5000',1,1,'2026-07-26 12:32:16','2026-07-26 12:32:16');
INSERT INTO "accounting_accounts" ("code","name","account_type","normal_side","parent_code","active","system_account","created_at","updated_at") VALUES('5500','여비·교통비','expense','debit','5000',1,1,'2026-07-26 12:32:16','2026-07-26 12:32:16');
INSERT INTO "accounting_accounts" ("code","name","account_type","normal_side","parent_code","active","system_account","created_at","updated_at") VALUES('5600','회의비·업무추진비','expense','debit','5000',1,1,'2026-07-26 12:32:16','2026-07-26 12:32:16');
INSERT INTO "accounting_accounts" ("code","name","account_type","normal_side","parent_code","active","system_account","created_at","updated_at") VALUES('5700','교육·연수비','expense','debit','5000',1,1,'2026-07-26 12:32:16','2026-07-26 12:32:16');
INSERT INTO "accounting_accounts" ("code","name","account_type","normal_side","parent_code","active","system_account","created_at","updated_at") VALUES('5800','법회·의례·포교사업비','expense','debit','5000',1,1,'2026-07-26 12:32:16','2026-07-26 12:32:16');
INSERT INTO "accounting_accounts" ("code","name","account_type","normal_side","parent_code","active","system_account","created_at","updated_at") VALUES('5900','기타운영비','expense','debit','5000',1,1,'2026-07-26 12:32:16','2026-07-26 12:32:16');
INSERT INTO "accounting_accounts" ("code","name","account_type","normal_side","parent_code","active","system_account","created_at","updated_at") VALUES('6100','목적사업비','expense','debit','5000',1,1,'2026-07-26 12:32:16','2026-07-26 12:32:16');
INSERT INTO "accounting_accounts" ("code","name","account_type","normal_side","parent_code","active","system_account","created_at","updated_at") VALUES('6200','시설비·수선비','expense','debit','5000',1,1,'2026-07-26 12:32:16','2026-07-26 12:32:16');
INSERT INTO "accounting_accounts" ("code","name","account_type","normal_side","parent_code","active","system_account","created_at","updated_at") VALUES('6300','지원금·보조금지출','expense','debit','5000',1,1,'2026-07-26 12:32:16','2026-07-26 12:32:16');
CREATE TABLE accounting_budgets (
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
CREATE TABLE accounting_resolutions (
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
CREATE TABLE accounting_journals (
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
CREATE TABLE accounting_journal_lines (
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
CREATE TABLE accounting_closings (
  id TEXT PRIMARY KEY,
  fiscal_year INTEGER NOT NULL,
  period_month INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'closed',
  closed_by TEXT NOT NULL,
  closed_at TEXT NOT NULL,
  memo TEXT,
  UNIQUE(fiscal_year, period_month)
);
CREATE TABLE accounting_audit_logs (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  actor_user_id TEXT,
  actor_name TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE TABLE accounting_sequences (
  seq_key TEXT PRIMARY KEY,
  last_seq INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE accounting_meta (
  meta_key TEXT PRIMARY KEY,
  meta_value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO "accounting_meta" ("meta_key","meta_value","updated_at") VALUES('schema_version','2026-07-30.2','2026-07-30 10:24:54');
CREATE TABLE accounting_book_types (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  system_type INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO "accounting_book_types" ("code","name","description","active","system_type","created_at","updated_at") VALUES('general','일반회계','종단의 일반적인 목적사업과 운영 활동을 관리합니다.',1,1,'2026-07-26 12:32:16','2026-07-26 12:32:16');
INSERT INTO "accounting_book_types" ("code","name","description","active","system_type","created_at","updated_at") VALUES('purpose','목적사업회계','지정 목적·기금·보조사업 등 사용처가 제한된 회계를 관리합니다.',1,1,'2026-07-26 12:32:16','2026-07-26 12:32:16');
INSERT INTO "accounting_book_types" ("code","name","description","active","system_type","created_at","updated_at") VALUES('revenue','수익사업회계','수익사업에서 발생하는 수입·지출과 자산을 구분 관리합니다.',1,1,'2026-07-26 12:32:16','2026-07-26 12:32:16');
CREATE TABLE accounting_entities (
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
, affiliation_registered_at TEXT);
INSERT INTO "accounting_entities" ("id","entity_code","name","entity_type","parent_id","department_path","registration_no","representative","address","consolidation_enabled","active","created_by","created_at","updated_at","affiliation_registered_at") VALUES('ENTITY-HQ','HQ','종단 본부','headquarters',NULL,'사무국',NULL,NULL,NULL,1,1,'system','2026-07-26 12:32:16','2026-07-30T22:22:05.742Z','2027-07-30');
CREATE TABLE accounting_funds (
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
INSERT INTO "accounting_funds" ("id","fund_code","name","fund_type","purpose","restriction_note","active","system_fund","created_by","created_at","updated_at") VALUES('FUND-GENERAL','FUND-GENERAL','일반재원','unrestricted','사용 목적이 별도로 제한되지 않은 일반재원',NULL,1,1,'system','2026-07-26 12:32:16','2026-07-26 12:32:16');
INSERT INTO "accounting_funds" ("id","fund_code","name","fund_type","purpose","restriction_note","active","system_fund","created_by","created_at","updated_at") VALUES('FUND-DESIGNATED','FUND-DESIGNATED','목적지정 기부금','designated_donation','기부자가 사용 목적을 지정한 기부금',NULL,1,1,'system','2026-07-26 12:32:16','2026-07-26 12:32:16');
INSERT INTO "accounting_funds" ("id","fund_code","name","fund_type","purpose","restriction_note","active","system_fund","created_by","created_at","updated_at") VALUES('FUND-GRANT','FUND-GRANT','보조금·지원금','grant','국가·지자체·기관의 보조금 및 지원금',NULL,1,1,'system','2026-07-26 12:32:16','2026-07-26 12:32:16');
INSERT INTO "accounting_funds" ("id","fund_code","name","fund_type","purpose","restriction_note","active","system_fund","created_by","created_at","updated_at") VALUES('FUND-RESERVE','FUND-RESERVE','적립금·준비금','reserve','장래 사업과 시설을 위한 적립 재원',NULL,1,1,'system','2026-07-26 12:32:16','2026-07-26 12:32:16');
CREATE TABLE accounting_budget_plans (
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
CREATE TABLE accounting_resolution_dimensions (
  resolution_id TEXT PRIMARY KEY,
  book_type_code TEXT NOT NULL DEFAULT 'general',
  entity_id TEXT NOT NULL DEFAULT '',
  fund_id TEXT NOT NULL DEFAULT '',
  source_category TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE accounting_journal_line_dimensions (
  journal_line_id TEXT PRIMARY KEY,
  book_type_code TEXT NOT NULL DEFAULT 'general',
  entity_id TEXT NOT NULL DEFAULT '',
  fund_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE accounting_donors (
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
CREATE TABLE accounting_donations (
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
, receipt_donation_type TEXT NOT NULL DEFAULT '소득세법 제34조 제1항 기부금중 종교단체 기부금', receipt_donation_code TEXT NOT NULL DEFAULT '41', receipt_description TEXT, receipt_org_name TEXT, receipt_org_registration_no TEXT, receipt_org_address TEXT, receipt_collector_name TEXT, receipt_collector_registration_no TEXT, receipt_collector_address TEXT, receipt_issuer_title TEXT NOT NULL DEFAULT '주지', receipt_issuer_name TEXT, receipt_issuer_phone TEXT, receipt_items_json TEXT NOT NULL DEFAULT '[]');
CREATE TABLE accounting_assets (
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
CREATE TABLE accounting_cards (
  id TEXT PRIMARY KEY,
  card_code TEXT NOT NULL UNIQUE,
  card_label TEXT NOT NULL,
  issuer TEXT,
  masked_number TEXT,
  holder TEXT,
  book_type_code TEXT NOT NULL DEFAULT 'general',
  entity_id TEXT NOT NULL DEFAULT '',
  department TEXT NOT NULL DEFAULT '',
  settlement_account_code TEXT NOT NULL DEFAULT '1130',
  active INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE accounting_card_transactions (
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
CREATE TABLE accounting_branch_reports (
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
CREATE TABLE accounting_special_sequences (
  seq_key TEXT PRIMARY KEY,
  last_seq INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE accounting_monthly_summary (
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
CREATE TABLE accounting_attachments (   id INTEGER PRIMARY KEY AUTOINCREMENT,    reference_type TEXT NOT NULL,   reference_id TEXT NOT NULL,    file_category TEXT NOT NULL DEFAULT 'general',   original_filename TEXT NOT NULL,   stored_filename TEXT NOT NULL,   object_key TEXT NOT NULL UNIQUE,    content_type TEXT,   size_bytes INTEGER NOT NULL DEFAULT 0,   checksum_sha256 TEXT,    uploaded_by TEXT,   uploaded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,    deleted_at TEXT,   deleted_by TEXT , delete_reason TEXT, retention_until TEXT, scan_status TEXT NOT NULL DEFAULT 'legacy_unscanned', scan_message TEXT, delete_status TEXT NOT NULL DEFAULT 'active', delete_error TEXT, last_checked_at TEXT);
CREATE TABLE IF NOT EXISTS "d1_migrations"(
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		name       TEXT UNIQUE,
		applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);
INSERT INTO "d1_migrations" ("id","name","applied_at") VALUES(1,'0004_v27_attachment_operations.sql','2026-07-29 11:35:03');
INSERT INTO "d1_migrations" ("id","name","applied_at") VALUES(2,'0005_v34_performance_indexes.sql','2026-07-30 10:24:54');
INSERT INTO "d1_migrations" ("id","name","applied_at") VALUES(3,'0006_v35_donation_receipt_form.sql','2026-07-30 11:52:30');
INSERT INTO "d1_migrations" ("id","name","applied_at") VALUES(4,'0007_v36_donation_receipt_items.sql','2026-07-30 12:42:44');
INSERT INTO "d1_migrations" ("id","name","applied_at") VALUES(5,'0008_v37_affiliation_certificates.sql','2026-07-30 13:24:07');
CREATE TABLE accounting_attachment_policy (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  allowed_extensions TEXT NOT NULL,
  max_file_bytes INTEGER NOT NULL,
  max_files_per_reference INTEGER NOT NULL,
  max_total_bytes_per_reference INTEGER NOT NULL,
  retention_days INTEGER NOT NULL,
  require_delete_reason INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT,
  updated_at TEXT NOT NULL
);
INSERT INTO "accounting_attachment_policy" ("id","allowed_extensions","max_file_bytes","max_files_per_reference","max_total_bytes_per_reference","retention_days","require_delete_reason","updated_by","updated_at") VALUES(1,'pdf,jpg,jpeg,png,hwp,hwpx,doc,docx,xls,xlsx,csv,txt',4194304,10,20971520,3650,1,'김양휘','2026-07-30T01:59:06.099Z');
CREATE TABLE accounting_attachment_integrity_issues (
  id TEXT PRIMARY KEY,
  issue_key TEXT NOT NULL UNIQUE,
  issue_type TEXT NOT NULL,
  attachment_id INTEGER,
  object_key TEXT NOT NULL,
  reference_type TEXT,
  reference_id TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  details_json TEXT NOT NULL DEFAULT '{}',
  detected_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT,
  resolution_action TEXT
);
CREATE TABLE accounting_attachment_operations (
  id TEXT PRIMARY KEY,
  operation_type TEXT NOT NULL,
  attachment_id INTEGER,
  object_key TEXT NOT NULL,
  reference_type TEXT,
  reference_id TEXT,
  status TEXT NOT NULL DEFAULT 'failed',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_attempt_at TEXT,
  completed_at TEXT
);
CREATE TABLE accounting_entity_certificates (
  id TEXT PRIMARY KEY,
  certificate_no TEXT NOT NULL UNIQUE,
  entity_id TEXT NOT NULL,
  affiliation_name TEXT NOT NULL DEFAULT '대한불교밀교종',
  headquarters_address TEXT NOT NULL,
  temple_display_name TEXT NOT NULL,
  registration_date TEXT NOT NULL,
  purpose TEXT NOT NULL,
  confirmation_chairman TEXT NOT NULL,
  issuing_chairman TEXT NOT NULL,
  issue_date TEXT NOT NULL,
  buddhist_year INTEGER NOT NULL,
  valid_until TEXT NOT NULL,
  issued_by TEXT NOT NULL,
  issued_at TEXT NOT NULL
);
DELETE FROM sqlite_sequence;
INSERT INTO "sqlite_sequence" ("name","seq") VALUES('accounting_attachments',5);
INSERT INTO "sqlite_sequence" ("name","seq") VALUES('d1_migrations',5);
CREATE INDEX idx_acc_budget_year
  ON accounting_budgets (fiscal_year, department, account_code);
CREATE INDEX idx_acc_resolution_status
  ON accounting_resolutions (status, resolution_date DESC);
CREATE INDEX idx_acc_resolution_document
  ON accounting_resolutions (document_id);
CREATE INDEX idx_acc_journal_date
  ON accounting_journals (fiscal_year, journal_date DESC);
CREATE INDEX idx_acc_line_account
  ON accounting_journal_lines (account_code, journal_id);
CREATE INDEX idx_acc_line_department
  ON accounting_journal_lines (department, project);
CREATE INDEX idx_acc_budget_plan_dims
  ON accounting_budget_plans (fiscal_year, book_type_code, entity_id, fund_id, account_code);
CREATE INDEX idx_acc_resolution_dims
  ON accounting_resolution_dimensions (book_type_code, entity_id, fund_id);
CREATE INDEX idx_acc_journal_line_dims
  ON accounting_journal_line_dimensions (book_type_code, entity_id, fund_id);
CREATE INDEX idx_acc_donation_date
  ON accounting_donations (fiscal_year, donation_date DESC);
CREATE INDEX idx_acc_donation_donor
  ON accounting_donations (donor_id);
CREATE INDEX idx_acc_asset_entity
  ON accounting_assets (entity_id, status);
CREATE INDEX idx_acc_card_tx_status
  ON accounting_card_transactions (status, transaction_date DESC);
CREATE INDEX idx_acc_branch_period
  ON accounting_branch_reports (fiscal_year, period_type, period_key, status);
CREATE INDEX idx_acc_monthly_year_dims ON accounting_monthly_summary(fiscal_year,period_month,book_type_code,entity_id,fund_id);
CREATE INDEX idx_acc_monthly_account ON accounting_monthly_summary(fiscal_year,account_code,department,project);
CREATE INDEX idx_acc_resolution_cursor ON accounting_resolutions(fiscal_year,resolution_date DESC,created_at DESC,id DESC);
CREATE INDEX idx_acc_journal_cursor ON accounting_journals(fiscal_year,journal_date DESC,created_at DESC,id DESC);
CREATE INDEX idx_acc_donor_cursor ON accounting_donors(active,created_at DESC,id DESC);
CREATE INDEX idx_acc_asset_cursor ON accounting_assets(status,acquisition_date DESC,id DESC);
CREATE INDEX idx_acc_card_tx_date ON accounting_card_transactions(transaction_date DESC,created_at DESC,id DESC);
CREATE INDEX idx_accounting_attachments_reference ON accounting_attachments (   reference_type,   reference_id );
CREATE INDEX idx_accounting_attachments_uploaded_at ON accounting_attachments (   uploaded_at );
CREATE INDEX idx_accounting_attachments_deleted_at ON accounting_attachments (   deleted_at );
CREATE INDEX idx_accounting_attachments_delete_status
ON accounting_attachments (delete_status, deleted_at);
CREATE INDEX idx_accounting_attachments_retention
ON accounting_attachments (retention_until, deleted_at);
CREATE INDEX idx_attachment_integrity_status
ON accounting_attachment_integrity_issues (status, issue_type, last_seen_at);
CREATE INDEX idx_attachment_operations_status
ON accounting_attachment_operations (status, updated_at);
CREATE INDEX idx_acc_attach_active_reference
ON accounting_attachments(reference_type, reference_id, deleted_at, uploaded_at DESC, id DESC);
CREATE INDEX idx_acc_card_tx_card
ON accounting_card_transactions(card_id, transaction_date DESC, created_at DESC, id DESC);
CREATE INDEX idx_acc_card_tx_year_date
ON accounting_card_transactions(transaction_date DESC, created_at DESC, id DESC);
CREATE INDEX idx_acc_donation_year_receipt
ON accounting_donations(fiscal_year, receipt_status, donation_date DESC, created_at DESC, id DESC);
CREATE INDEX idx_acc_asset_status_date
ON accounting_assets(status, acquisition_date DESC, id DESC);
CREATE INDEX idx_acc_branch_year_period_status
ON accounting_branch_reports(fiscal_year, period_type, period_key, status, entity_id);
CREATE INDEX idx_accounting_donations_receipt_no
  ON accounting_donations(receipt_no, receipt_status);
CREATE INDEX idx_accounting_donations_receipt_items
  ON accounting_donations(receipt_status, donation_date);
CREATE INDEX idx_entity_certificates_entity_issue
  ON accounting_entity_certificates(entity_id, issue_date DESC, issued_at DESC);
CREATE INDEX idx_entity_certificates_issue_date
  ON accounting_entity_certificates(issue_date DESC, certificate_no);
