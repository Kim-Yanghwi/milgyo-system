-- v63: 세무자료 관리, 부가가치세·원천징수 보조장부, 세무사 제출 패키지,
--      법인카드 미결제계정의 부채 분류 및 카드대금 결제 이력

-- 1130은 과거 자산계정으로 잘못 생성된 법인카드 미결제계정입니다.
-- 새 부채계정 2110을 생성한 뒤 기존 회계자료의 참조와 월집계를 손실 없이 이관합니다.
INSERT OR IGNORE INTO accounting_accounts
(code,name,account_type,normal_side,parent_code,active,system_account,created_at,updated_at)
VALUES
('2110','법인카드미지급금','liability','credit','2100',1,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
('1140','부가가치세대급금','asset','debit','1000',1,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
('2210','부가가치세예수금','liability','credit','2200',1,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
('2220','소득세예수금','liability','credit','2200',1,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
('2230','지방소득세예수금','liability','credit','2200',1,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);

-- 동일 코드가 사용자 정의 계정으로 먼저 존재하더라도 카드 미지급금의 성격은
-- 반드시 부채/대변으로 통일합니다. 이름과 상위계정도 표준값으로 바로잡습니다.
UPDATE accounting_accounts
SET name='법인카드미지급금',account_type='liability',normal_side='credit',
    parent_code='2100',active=1,system_account=1,updated_at=CURRENT_TIMESTAMP
WHERE code='2110';

UPDATE accounting_accounts
SET name='사용중지-법인카드미결제(구계정)',active=0,updated_at=CURRENT_TIMESTAMP
WHERE code='1130';

UPDATE accounting_cards SET settlement_account_code='2110' WHERE settlement_account_code='1130';
UPDATE accounting_resolutions SET settlement_account_code='2110'
WHERE settlement_account_code='1130' AND payment_method='법인카드';
-- 현금·예금 정산계정, 자산대장 계정은 각 필드의 성격에 맞는
-- 기본 자산계정으로 보정합니다. 부채계정 2110으로 일괄 치환하지 않습니다.
UPDATE accounting_bank_accounts SET settlement_account_code='1120' WHERE settlement_account_code='1130';
UPDATE accounting_donations SET settlement_account_code='1120' WHERE settlement_account_code='1130';
-- 분류계정은 비용·수익 계정이어야 하므로 1130을 미지급금으로 임의 치환하지 않습니다.
UPDATE accounting_matching_rules SET active=0,updated_at=CURRENT_TIMESTAMP WHERE account_code='1130';
UPDATE accounting_import_transactions
SET classification_account_code=NULL,status=CASE WHEN status IN ('suggested','unmatched') THEN 'unmatched' ELSE status END,
    suggested_type=NULL,suggested_id=NULL,suggested_score=NULL,
    suggested_reason='v63: 구 법인카드계정 분류 재검토 필요',updated_at=CURRENT_TIMESTAMP
WHERE classification_account_code='1130' AND status IN ('suggested','unmatched');
UPDATE accounting_assets SET asset_account_code='1500' WHERE asset_account_code='1130';
-- 계약·카드사용의 지출계정은 임의의 비용계정으로 바꾸면 오분류가 되므로
-- 비정상 1130 참조가 있다면 자동검증에서 차단하고 담당자가 원계정을 확인하게 합니다.
UPDATE accounting_journal_lines
SET account_code='2110'
WHERE account_code='1130' AND journal_id IN (
  SELECT j.id FROM accounting_journals j
  LEFT JOIN accounting_resolutions r ON j.source_type='resolution' AND j.source_id=r.id
  WHERE j.source_type='card'
     OR (j.source_type='resolution' AND r.payment_method='법인카드')
);

-- 월집계는 v64 마이그레이션에서 원전표 기준으로 전면 재산출합니다.

CREATE TABLE IF NOT EXISTS accounting_card_payments (
  id TEXT PRIMARY KEY,
  payment_no TEXT NOT NULL UNIQUE,
  fiscal_year INTEGER NOT NULL,
  card_id TEXT NOT NULL,
  payment_date TEXT NOT NULL,
  amount INTEGER NOT NULL,
  payable_account_code TEXT NOT NULL DEFAULT '2110',
  bank_account_code TEXT NOT NULL DEFAULT '1120',
  book_type_code TEXT NOT NULL DEFAULT 'general',
  entity_id TEXT NOT NULL DEFAULT 'ENTITY-HQ',
  fund_id TEXT NOT NULL DEFAULT '',
  journal_id TEXT NOT NULL UNIQUE,
  memo TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (amount > 0),
  CHECK (fiscal_year BETWEEN 2000 AND 2200),
  CHECK (fiscal_year = CAST(substr(payment_date,1,4) AS INTEGER))
);

CREATE TABLE IF NOT EXISTS accounting_tax_profiles (
  id TEXT PRIMARY KEY,
  fiscal_year INTEGER NOT NULL,
  entity_id TEXT NOT NULL DEFAULT 'ENTITY-HQ',
  legal_name TEXT NOT NULL,
  organization_type TEXT NOT NULL DEFAULT 'religious_organization',
  registration_no TEXT,
  corporate_registration_no TEXT,
  tax_office_name TEXT,
  public_interest_status INTEGER NOT NULL DEFAULT 0,
  qualified_donation_status TEXT NOT NULL DEFAULT 'not_confirmed',
  qualified_from TEXT,
  qualified_to TEXT,
  revenue_business_enabled INTEGER NOT NULL DEFAULT 0,
  vat_business_type TEXT NOT NULL DEFAULT 'not_confirmed',
  vat_reporting_cycle TEXT NOT NULL DEFAULT 'not_confirmed',
  withholding_enabled INTEGER NOT NULL DEFAULT 0,
  religious_income_method TEXT NOT NULL DEFAULT 'not_set',
  electronic_donation_required INTEGER NOT NULL DEFAULT 0,
  tax_agent_name TEXT,
  tax_agent_contact TEXT,
  tax_agent_email TEXT,
  profile_status TEXT NOT NULL DEFAULT 'draft',
  memo TEXT,
  confirmed_by TEXT,
  confirmed_at TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(fiscal_year,entity_id),
  CHECK (organization_type IN ('religious_organization','nonprofit_corporation','public_interest_corporation','other')),
  CHECK (qualified_donation_status IN ('not_confirmed','qualified','not_qualified','expired')),
  CHECK (vat_business_type IN ('not_confirmed','exempt','general','simplified','mixed','not_applicable')),
  CHECK (vat_reporting_cycle IN ('not_confirmed','quarterly','semiannual','annual','not_applicable')),
  CHECK (religious_income_method IN ('not_set','religious_income','earned_income','mixed','not_applicable')),
  CHECK (profile_status IN ('draft','confirmed')),
  CHECK (profile_status<>'confirmed' OR (
    LENGTH(TRIM(COALESCE(registration_no,'')))>0
    AND qualified_donation_status<>'not_confirmed'
    AND vat_business_type<>'not_confirmed'
    AND vat_reporting_cycle<>'not_confirmed'
    AND religious_income_method<>'not_set'
    AND confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL
  )),
  CHECK (vat_business_type<>'not_applicable' OR vat_reporting_cycle='not_applicable'),
  CHECK (vat_business_type NOT IN ('general','simplified','mixed') OR vat_reporting_cycle<>'not_applicable')
);

CREATE TABLE IF NOT EXISTS accounting_vat_records (
  id TEXT PRIMARY KEY,
  fiscal_year INTEGER NOT NULL,
  transaction_date TEXT NOT NULL,
  direction TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'manual',
  source_id TEXT NOT NULL DEFAULT '',
  book_type_code TEXT NOT NULL DEFAULT 'general',
  entity_id TEXT NOT NULL DEFAULT 'ENTITY-HQ',
  fund_id TEXT NOT NULL DEFAULT '',
  counterparty_name TEXT NOT NULL DEFAULT '',
  counterparty_business_no TEXT,
  evidence_type TEXT NOT NULL DEFAULT 'other',
  evidence_no TEXT,
  total_amount INTEGER NOT NULL,
  supply_amount INTEGER NOT NULL,
  vat_amount INTEGER NOT NULL DEFAULT 0,
  tax_type TEXT NOT NULL DEFAULT 'taxable',
  deduction_status TEXT NOT NULL DEFAULT 'pending',
  non_deductible_reason TEXT,
  filing_period TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  memo TEXT,
  confirmed_by TEXT,
  confirmed_at TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (direction IN ('purchase','sale')),
  CHECK (source_type IN ('manual','resolution','card_transaction','import_transaction','donation','journal')),
  CHECK (evidence_type IN ('tax_invoice','invoice','card','cash_receipt','receipt','other','none')),
  CHECK (tax_type IN ('taxable','zero_rated','exempt','non_taxable')),
  CHECK (deduction_status IN ('pending','deductible','non_deductible','not_applicable')),
  CHECK (status IN ('draft','confirmed','cancelled')),
  CHECK (fiscal_year BETWEEN 2000 AND 2200),
  CHECK (fiscal_year = CAST(substr(transaction_date,1,4) AS INTEGER)),
  CHECK ((source_type='manual' AND source_id='') OR (source_type<>'manual' AND source_id<>'')),
  CHECK (substr(filing_period,1,4)=printf('%04d',fiscal_year)),
  CHECK (total_amount > 0),
  CHECK (supply_amount >= 0 AND vat_amount >= 0),
  CHECK (total_amount = supply_amount + vat_amount),
  CHECK (tax_type = 'taxable' OR vat_amount = 0),
  CHECK (direction <> 'sale' OR deduction_status = 'not_applicable'),
  CHECK (status<>'confirmed' OR direction<>'purchase' OR deduction_status<>'pending'),
  CHECK (status<>'confirmed' OR (confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL)),
  CHECK (direction <> 'purchase' OR deduction_status <> 'non_deductible'
    OR LENGTH(TRIM(COALESCE(non_deductible_reason,''))) > 0)
);

CREATE TABLE IF NOT EXISTS accounting_tax_payees (
  id TEXT PRIMARY KEY,
  payee_no TEXT NOT NULL UNIQUE,
  payee_type TEXT NOT NULL,
  name TEXT NOT NULL,
  identifier_masked TEXT,
  business_no TEXT,
  contact TEXT,
  resident_status TEXT NOT NULL DEFAULT 'resident',
  active INTEGER NOT NULL DEFAULT 1,
  memo TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (payee_type IN ('employee','religious_worker','lecturer','freelancer','vendor','other')),
  CHECK (resident_status IN ('resident','nonresident','corporation','not_applicable')),
  CHECK (active IN (0,1))
);

CREATE TABLE IF NOT EXISTS accounting_withholding_records (
  id TEXT PRIMARY KEY,
  payment_no TEXT NOT NULL UNIQUE,
  fiscal_year INTEGER NOT NULL,
  payment_date TEXT NOT NULL,
  payee_id TEXT NOT NULL,
  income_type TEXT NOT NULL,
  religious_income_method TEXT NOT NULL DEFAULT 'not_applicable',
  source_resolution_id TEXT,
  book_type_code TEXT NOT NULL DEFAULT 'general',
  entity_id TEXT NOT NULL DEFAULT 'ENTITY-HQ',
  fund_id TEXT NOT NULL DEFAULT '',
  gross_amount INTEGER NOT NULL,
  tax_exempt_amount INTEGER NOT NULL DEFAULT 0,
  necessary_expense INTEGER NOT NULL DEFAULT 0,
  taxable_amount INTEGER NOT NULL,
  income_tax INTEGER NOT NULL DEFAULT 0,
  local_income_tax INTEGER NOT NULL DEFAULT 0,
  other_deduction INTEGER NOT NULL DEFAULT 0,
  net_amount INTEGER NOT NULL,
  filing_month TEXT NOT NULL,
  filing_due_date TEXT,
  filing_status TEXT NOT NULL DEFAULT 'unfiled',
  filed_at TEXT,
  paid_at TEXT,
  memo TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (income_type IN ('earned','religious','business','other','retirement','nonresident','other_income')),
  CHECK (religious_income_method IN ('not_applicable','religious_income','earned_income')),
  CHECK (filing_status IN ('unfiled','filed','paid','cancelled')),
  CHECK (fiscal_year BETWEEN 2000 AND 2200),
  CHECK (fiscal_year = CAST(substr(payment_date,1,4) AS INTEGER)),
  CHECK (gross_amount > 0),
  CHECK (tax_exempt_amount >= 0 AND necessary_expense >= 0 AND taxable_amount >= 0),
  CHECK (income_tax >= 0 AND local_income_tax >= 0 AND other_deduction >= 0 AND net_amount >= 0),
  CHECK (tax_exempt_amount + necessary_expense <= gross_amount),
  CHECK (taxable_amount <= gross_amount),
  CHECK (net_amount = gross_amount - income_tax - local_income_tax - other_deduction),
  CHECK (income_type = 'religious' OR religious_income_method = 'not_applicable'),
  CHECK (income_type <> 'religious' OR religious_income_method <> 'not_applicable'),
  CHECK (filing_status NOT IN ('filed','paid') OR filed_at IS NOT NULL),
  CHECK (filing_status <> 'paid' OR paid_at IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS accounting_tax_export_batches (
  id TEXT PRIMARY KEY,
  export_no TEXT NOT NULL UNIQUE,
  fiscal_year INTEGER NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  book_type_code TEXT NOT NULL DEFAULT '',
  entity_id TEXT NOT NULL DEFAULT '',
  fund_id TEXT NOT NULL DEFAULT '',
  filters_json TEXT NOT NULL DEFAULT '{}',
  file_count INTEGER NOT NULL DEFAULT 0,
  row_count INTEGER NOT NULL DEFAULT 0,
  total_debit INTEGER NOT NULL DEFAULT 0,
  total_credit INTEGER NOT NULL DEFAULT 0,
  validation_error_count INTEGER NOT NULL DEFAULT 0,
  validation_warning_count INTEGER NOT NULL DEFAULT 0,
  manifest_json TEXT NOT NULL DEFAULT '{}',
  package_sha256 TEXT,
  package_size_bytes INTEGER,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_card_payments_year_date
  ON accounting_card_payments(fiscal_year,payment_date DESC,card_id);
CREATE INDEX IF NOT EXISTS idx_tax_profiles_year_entity
  ON accounting_tax_profiles(fiscal_year,entity_id,profile_status);
CREATE INDEX IF NOT EXISTS idx_vat_records_year_period
  ON accounting_vat_records(fiscal_year,filing_period,status,transaction_date);
CREATE INDEX IF NOT EXISTS idx_vat_records_source
  ON accounting_vat_records(source_type,source_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_vat_records_unique_linked_source
  ON accounting_vat_records(source_type,source_id)
  WHERE source_id<>'';
CREATE INDEX IF NOT EXISTS idx_tax_payees_active_name
  ON accounting_tax_payees(active,name,payee_no);
CREATE INDEX IF NOT EXISTS idx_withholding_year_month
  ON accounting_withholding_records(fiscal_year,filing_month,filing_status,payment_date);
CREATE INDEX IF NOT EXISTS idx_withholding_payee
  ON accounting_withholding_records(payee_id,payment_date DESC);
CREATE INDEX IF NOT EXISTS idx_tax_exports_year_created
  ON accounting_tax_export_batches(fiscal_year,created_at DESC);

-- API 검증과 별개로 DB 수준에서도 잘못된 결제계정과 잔액 초과 결제를 차단합니다.
CREATE TRIGGER IF NOT EXISTS trg_card_payments_validate_insert
BEFORE INSERT ON accounting_card_payments
BEGIN
  SELECT RAISE(ABORT,'card payment amount must be positive')
  WHERE NEW.amount <= 0;
  SELECT RAISE(ABORT,'card payable account must be active liability credit')
  WHERE NOT EXISTS (
    SELECT 1 FROM accounting_accounts
    WHERE code=NEW.payable_account_code AND account_type='liability' AND normal_side='credit' AND active=1
  );
  SELECT RAISE(ABORT,'card bank account must be active cash asset debit')
  WHERE NOT EXISTS (
    SELECT 1 FROM accounting_accounts
    WHERE code=NEW.bank_account_code AND account_type='asset' AND normal_side='debit' AND active=1
      AND (parent_code='1100' OR code IN ('1110','1120'))
  );
  SELECT RAISE(ABORT,'card payment exceeds outstanding amount')
  WHERE NEW.amount > (
    COALESCE((SELECT SUM(t.amount) FROM accounting_card_transactions t
      JOIN accounting_journals j ON j.id=t.journal_id
      WHERE t.card_id=NEW.card_id AND j.status='posted'
        AND COALESCE(NULLIF(t.book_type_code,''),'general')=COALESCE(NULLIF(NEW.book_type_code,''),'general')
        AND COALESCE(NULLIF(t.entity_id,''),'ENTITY-HQ')=COALESCE(NULLIF(NEW.entity_id,''),'ENTITY-HQ')
        AND COALESCE(t.fund_id,'')=COALESCE(NEW.fund_id,'')),0)
    - COALESCE((SELECT SUM(p.amount) FROM accounting_card_payments p
      JOIN accounting_journals j ON j.id=p.journal_id
      WHERE p.card_id=NEW.card_id AND j.status='posted'
        AND COALESCE(NULLIF(p.book_type_code,''),'general')=COALESCE(NULLIF(NEW.book_type_code,''),'general')
        AND COALESCE(NULLIF(p.entity_id,''),'ENTITY-HQ')=COALESCE(NULLIF(NEW.entity_id,''),'ENTITY-HQ')
        AND COALESCE(p.fund_id,'')=COALESCE(NEW.fund_id,'')),0)
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_card_payments_validate_update
BEFORE UPDATE ON accounting_card_payments
BEGIN
  SELECT RAISE(ABORT,'card payment amount must be positive')
  WHERE NEW.amount <= 0;
  SELECT RAISE(ABORT,'card payable account must be active liability credit')
  WHERE NOT EXISTS (
    SELECT 1 FROM accounting_accounts
    WHERE code=NEW.payable_account_code AND account_type='liability' AND normal_side='credit' AND active=1
  );
  SELECT RAISE(ABORT,'card bank account must be active cash asset debit')
  WHERE NOT EXISTS (
    SELECT 1 FROM accounting_accounts
    WHERE code=NEW.bank_account_code AND account_type='asset' AND normal_side='debit' AND active=1
      AND (parent_code='1100' OR code IN ('1110','1120'))
  );
  SELECT RAISE(ABORT,'card payment exceeds outstanding amount')
  WHERE NEW.amount > (
    COALESCE((SELECT SUM(t.amount) FROM accounting_card_transactions t
      JOIN accounting_journals j ON j.id=t.journal_id
      WHERE t.card_id=NEW.card_id AND j.status='posted'
        AND COALESCE(NULLIF(t.book_type_code,''),'general')=COALESCE(NULLIF(NEW.book_type_code,''),'general')
        AND COALESCE(NULLIF(t.entity_id,''),'ENTITY-HQ')=COALESCE(NULLIF(NEW.entity_id,''),'ENTITY-HQ')
        AND COALESCE(t.fund_id,'')=COALESCE(NEW.fund_id,'')),0)
    - COALESCE((SELECT SUM(p.amount) FROM accounting_card_payments p
      JOIN accounting_journals j ON j.id=p.journal_id
      WHERE p.card_id=NEW.card_id AND p.id<>OLD.id AND j.status='posted'
        AND COALESCE(NULLIF(p.book_type_code,''),'general')=COALESCE(NULLIF(NEW.book_type_code,''),'general')
        AND COALESCE(NULLIF(p.entity_id,''),'ENTITY-HQ')=COALESCE(NULLIF(NEW.entity_id,''),'ENTITY-HQ')
        AND COALESCE(p.fund_id,'')=COALESCE(NEW.fund_id,'')),0)
  );
END;

INSERT INTO accounting_meta(meta_key,meta_value,updated_at)
VALUES ('schema_version','2026-08-08.1',CURRENT_TIMESTAMP)
ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value,updated_at=excluded.updated_at;
