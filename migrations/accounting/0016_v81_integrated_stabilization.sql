-- v81 통합 안정화
-- 애플리케이션 검증을 우회한 직접 API/동시 요청에서도 핵심 회계 불변식을 보존합니다.

-- 법인카드 원자료의 세무 의미를 영구 보존합니다.
-- 과거 자료는 세액이 0원이어도 면세라고 추정하지 않고 명시적으로 미분류/기존자료로 둡니다.
ALTER TABLE accounting_card_transactions ADD COLUMN supply_amount INTEGER;
ALTER TABLE accounting_card_transactions ADD COLUMN tax_type TEXT NOT NULL DEFAULT 'unclassified';
ALTER TABLE accounting_card_transactions ADD COLUMN tax_mode TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE accounting_card_transactions ADD COLUMN tax_note TEXT;

UPDATE accounting_card_transactions
SET supply_amount=amount-tax_amount,
    tax_type='unclassified',
    tax_mode='legacy'
WHERE supply_amount IS NULL;

-- 승인 선점 정보를 남겨 중복 클릭과 동시 승인 시도를 구별합니다.
ALTER TABLE accounting_budget_change_requests ADD COLUMN processing_by_user_id TEXT;
ALTER TABLE accounting_budget_change_requests ADD COLUMN processing_at TEXT;
ALTER TABLE accounting_vendor_bank_changes ADD COLUMN processing_by_user_id TEXT;
ALTER TABLE accounting_vendor_bank_changes ADD COLUMN processing_at TEXT;

-- 취합자료는 이름이 같은 사용자를 구별할 수 있도록 사용자 ID도 보존합니다.
ALTER TABLE accounting_branch_reports ADD COLUMN submitted_by_user_id TEXT;
ALTER TABLE accounting_branch_reports ADD COLUMN reviewed_by_user_id TEXT;

-- 기존 income_type CHECK를 유지하면서 화면의 실비변상·비과세 의미를 별도 필드로 보존합니다.
ALTER TABLE accounting_withholding_records ADD COLUMN tax_treatment TEXT NOT NULL DEFAULT 'standard';

CREATE UNIQUE INDEX IF NOT EXISTS uq_vendor_bank_change_open
ON accounting_vendor_bank_changes(vendor_id)
WHERE status IN ('pending','processing');

CREATE UNIQUE INDEX IF NOT EXISTS uq_donation_receipt_no
ON accounting_donations(receipt_no)
WHERE receipt_no IS NOT NULL AND receipt_no<>'';

CREATE TRIGGER IF NOT EXISTS trg_card_tax_fields_insert
BEFORE INSERT ON accounting_card_transactions
WHEN NEW.amount<=0 OR NEW.tax_amount<0 OR NEW.tax_amount>NEW.amount
  OR NEW.supply_amount IS NULL OR NEW.supply_amount<0 OR NEW.supply_amount+NEW.tax_amount<>NEW.amount
  OR NEW.tax_type NOT IN ('taxable','zero_rated','exempt','non_taxable','unclassified')
  OR NEW.tax_mode NOT IN ('vat_included','supply_plus_tax','manual','none','legacy')
  OR NEW.tax_type NOT IN ('taxable','unclassified') AND NEW.tax_amount<>0
  OR NEW.tax_type='taxable' AND NEW.tax_mode='none'
  OR NEW.tax_type NOT IN ('taxable','unclassified') AND NEW.tax_mode IN ('vat_included','supply_plus_tax')
  OR NEW.tax_mode='manual' AND LENGTH(TRIM(COALESCE(NEW.tax_note,'')))=0
BEGIN
  SELECT RAISE(ABORT,'invalid card tax fields');
END;

CREATE TRIGGER IF NOT EXISTS trg_card_tax_fields_update
BEFORE UPDATE OF amount,supply_amount,tax_amount,tax_type,tax_mode,tax_note ON accounting_card_transactions
WHEN NEW.amount<=0 OR NEW.tax_amount<0 OR NEW.tax_amount>NEW.amount
  OR NEW.supply_amount IS NULL OR NEW.supply_amount<0 OR NEW.supply_amount+NEW.tax_amount<>NEW.amount
  OR NEW.tax_type NOT IN ('taxable','zero_rated','exempt','non_taxable','unclassified')
  OR NEW.tax_mode NOT IN ('vat_included','supply_plus_tax','manual','none','legacy')
  OR NEW.tax_type NOT IN ('taxable','unclassified') AND NEW.tax_amount<>0
  OR NEW.tax_type='taxable' AND NEW.tax_mode='none'
  OR NEW.tax_type NOT IN ('taxable','unclassified') AND NEW.tax_mode IN ('vat_included','supply_plus_tax')
  OR NEW.tax_mode='manual' AND LENGTH(TRIM(COALESCE(NEW.tax_note,'')))=0
BEGIN
  SELECT RAISE(ABORT,'invalid card tax fields');
END;

CREATE TRIGGER IF NOT EXISTS trg_asset_values_insert
BEFORE INSERT ON accounting_assets
WHEN NEW.acquisition_cost<0 OR NEW.residual_value<0 OR NEW.residual_value>NEW.acquisition_cost
  OR NEW.depreciation_method NOT IN ('straight_line','declining_balance','none')
BEGIN
  SELECT RAISE(ABORT,'invalid asset value');
END;

CREATE TRIGGER IF NOT EXISTS trg_asset_disposed_immutable
BEFORE UPDATE OF acquisition_date,acquisition_cost,residual_value,depreciation_method,status,disposal_date,disposal_amount ON accounting_assets
WHEN OLD.status='disposed' AND (
  NEW.acquisition_date<>OLD.acquisition_date OR NEW.acquisition_cost<>OLD.acquisition_cost
  OR NEW.residual_value<>OLD.residual_value OR NEW.depreciation_method<>OLD.depreciation_method
  OR NEW.status<>OLD.status OR COALESCE(NEW.disposal_date,'')<>COALESCE(OLD.disposal_date,'')
  OR COALESCE(NEW.disposal_amount,-1)<>COALESCE(OLD.disposal_amount,-1))
BEGIN
  SELECT RAISE(ABORT,'disposed asset is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_asset_values_update
BEFORE UPDATE OF acquisition_cost,residual_value,depreciation_method ON accounting_assets
WHEN NEW.acquisition_cost<0 OR NEW.residual_value<0 OR NEW.residual_value>NEW.acquisition_cost
  OR NEW.depreciation_method NOT IN ('straight_line','declining_balance','none')
BEGIN
  SELECT RAISE(ABORT,'invalid asset value');
END;

CREATE TRIGGER IF NOT EXISTS trg_asset_disposal_update
BEFORE UPDATE OF status,disposal_date,disposal_amount ON accounting_assets
WHEN NEW.status='disposed' AND (NEW.disposal_date IS NULL OR NEW.disposal_date<NEW.acquisition_date OR COALESCE(NEW.disposal_amount,0)<0)
BEGIN
  SELECT RAISE(ABORT,'invalid asset disposal');
END;

CREATE TRIGGER IF NOT EXISTS trg_reserve_transaction_basic
BEFORE INSERT ON accounting_purpose_reserve_transactions
WHEN NEW.transaction_type NOT IN ('use','reversal') OR NEW.amount<=0
  OR NOT EXISTS (SELECT 1 FROM accounting_purpose_reserves r WHERE r.id=NEW.reserve_id)
  OR NEW.transaction_date<(SELECT r.set_date FROM accounting_purpose_reserves r WHERE r.id=NEW.reserve_id)
  OR COALESCE((SELECT r.use_deadline FROM accounting_purpose_reserves r WHERE r.id=NEW.reserve_id),'')<>''
    AND NEW.transaction_date>(SELECT r.use_deadline FROM accounting_purpose_reserves r WHERE r.id=NEW.reserve_id)
BEGIN
  SELECT RAISE(ABORT,'invalid reserve transaction');
END;

CREATE TRIGGER IF NOT EXISTS trg_reserve_use_limit
BEFORE INSERT ON accounting_purpose_reserve_transactions
WHEN NEW.transaction_type='use' AND
  COALESCE((SELECT SUM(CASE WHEN t.transaction_type='use' THEN t.amount ELSE -t.amount END)
    FROM accounting_purpose_reserve_transactions t WHERE t.reserve_id=NEW.reserve_id),0)+NEW.amount>
    (SELECT r.set_amount FROM accounting_purpose_reserves r WHERE r.id=NEW.reserve_id)
BEGIN
  SELECT RAISE(ABORT,'reserve use exceeds set amount');
END;

CREATE TRIGGER IF NOT EXISTS trg_reserve_reversal_limit
BEFORE INSERT ON accounting_purpose_reserve_transactions
WHEN NEW.transaction_type='reversal' AND NEW.amount>
  COALESCE((SELECT SUM(CASE WHEN t.transaction_type='use' THEN t.amount ELSE -t.amount END)
    FROM accounting_purpose_reserve_transactions t WHERE t.reserve_id=NEW.reserve_id),0)
BEGIN
  SELECT RAISE(ABORT,'reserve reversal exceeds net use');
END;

CREATE TRIGGER IF NOT EXISTS trg_contract_payment_linked_immutable
BEFORE UPDATE OF contract_id,payment_seq,amount,due_date,inspection_date,invoice_date ON accounting_contract_payments
WHEN OLD.resolution_id IS NOT NULL OR OLD.journal_id IS NOT NULL OR OLD.status IN ('linked','paid')
BEGIN
  SELECT RAISE(ABORT,'linked contract payment is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_contract_payment_single_link
BEFORE UPDATE OF resolution_id,journal_id,status ON accounting_contract_payments
WHEN OLD.resolution_id IS NOT NULL AND COALESCE(NEW.resolution_id,'')<>COALESCE(OLD.resolution_id,'')
  OR OLD.journal_id IS NOT NULL AND COALESCE(NEW.journal_id,'')<>COALESCE(OLD.journal_id,'')
    AND NOT (NEW.journal_id IS NULL AND EXISTS (SELECT 1 FROM accounting_journals j WHERE j.id=OLD.journal_id AND j.status='reversed'))
BEGIN
  SELECT RAISE(ABORT,'contract payment link is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_contract_payment_total_insert
BEFORE INSERT ON accounting_contract_payments
WHEN NEW.amount<=0 OR COALESCE((SELECT SUM(p.amount) FROM accounting_contract_payments p WHERE p.contract_id=NEW.contract_id),0)+NEW.amount>
  COALESCE((SELECT c.contract_amount FROM accounting_contracts c WHERE c.id=NEW.contract_id),0)
BEGIN
  SELECT RAISE(ABORT,'contract payment total exceeds contract amount');
END;

CREATE TRIGGER IF NOT EXISTS trg_contract_payment_total_update
BEFORE UPDATE OF amount,contract_id ON accounting_contract_payments
WHEN NEW.amount<=0 OR COALESCE((SELECT SUM(p.amount) FROM accounting_contract_payments p WHERE p.contract_id=NEW.contract_id AND p.id<>OLD.id),0)+NEW.amount>
  COALESCE((SELECT c.contract_amount FROM accounting_contracts c WHERE c.id=NEW.contract_id),0)
BEGIN
  SELECT RAISE(ABORT,'contract payment total exceeds contract amount');
END;

CREATE TRIGGER IF NOT EXISTS trg_budget_nonnegative_insert
BEFORE INSERT ON accounting_budget_plans
WHEN NEW.original_amount<0 OR NEW.supplementary_amount<0 OR NEW.transfer_in<0 OR NEW.transfer_out<0
  OR NEW.original_amount+NEW.supplementary_amount+NEW.transfer_in-NEW.transfer_out<0
BEGIN
  SELECT RAISE(ABORT,'budget amount cannot be negative');
END;

CREATE TRIGGER IF NOT EXISTS trg_budget_nonnegative_update
BEFORE UPDATE OF original_amount,supplementary_amount,transfer_in,transfer_out ON accounting_budget_plans
WHEN NEW.original_amount<0 OR NEW.supplementary_amount<0 OR NEW.transfer_in<0 OR NEW.transfer_out<0
  OR NEW.original_amount+NEW.supplementary_amount+NEW.transfer_in-NEW.transfer_out<0
BEGIN
  SELECT RAISE(ABORT,'budget amount cannot be negative');
END;

CREATE TRIGGER IF NOT EXISTS trg_budget_not_below_execution_update
BEFORE UPDATE OF original_amount,supplementary_amount,transfer_in,transfer_out ON accounting_budget_plans
WHEN NEW.original_amount+NEW.supplementary_amount+NEW.transfer_in-NEW.transfer_out <
  COALESCE((SELECT SUM(m.debit_total-m.credit_total) FROM accounting_monthly_summary m
    WHERE m.fiscal_year=NEW.fiscal_year AND m.account_code=NEW.account_code
      AND m.department=NEW.department AND m.project=NEW.project
      AND m.book_type_code=NEW.book_type_code AND m.entity_id=NEW.entity_id AND m.fund_id=NEW.fund_id),0)
  + COALESCE((SELECT SUM(CASE WHEN c.contract_amount>COALESCE(p.paid_amount,0)
      THEN c.contract_amount-COALESCE(p.paid_amount,0) ELSE 0 END)
    FROM accounting_contracts c
    LEFT JOIN (SELECT contract_id,SUM(CASE WHEN status='paid' THEN amount ELSE 0 END) AS paid_amount
      FROM accounting_contract_payments GROUP BY contract_id) p ON p.contract_id=c.id
    WHERE c.status IN ('active','approved') AND c.account_code=NEW.account_code
      AND c.department=NEW.department AND c.project=NEW.project
      AND c.book_type_code=NEW.book_type_code AND c.entity_id=NEW.entity_id AND c.fund_id=NEW.fund_id
      AND substr(c.contract_date,1,4)=CAST(NEW.fiscal_year AS TEXT)),0)
BEGIN
  SELECT RAISE(ABORT,'budget cannot be lower than execution and commitments');
END;

CREATE TRIGGER IF NOT EXISTS trg_attachment_reference_limits_insert
BEFORE INSERT ON accounting_attachments
WHEN (SELECT COUNT(*) FROM accounting_attachments a
      WHERE a.reference_type=NEW.reference_type AND a.reference_id=NEW.reference_id AND a.deleted_at IS NULL)
       >= COALESCE((SELECT p.max_files_per_reference FROM accounting_attachment_policy p WHERE p.id=1),10)
  OR COALESCE((SELECT SUM(a.size_bytes) FROM accounting_attachments a
      WHERE a.reference_type=NEW.reference_type AND a.reference_id=NEW.reference_id AND a.deleted_at IS NULL),0)+NEW.size_bytes
       > COALESCE((SELECT p.max_total_bytes_per_reference FROM accounting_attachment_policy p WHERE p.id=1),20971520)
BEGIN
  SELECT RAISE(ABORT,'attachment reference limit exceeded');
END;

CREATE TRIGGER IF NOT EXISTS trg_withholding_tax_treatment_insert
BEFORE INSERT ON accounting_withholding_records
WHEN NEW.tax_treatment NOT IN ('standard','reimbursement')
  OR NEW.tax_treatment='reimbursement' AND (
    NEW.income_type<>'other' OR NEW.tax_exempt_amount<>NEW.gross_amount
    OR NEW.necessary_expense<>0 OR NEW.taxable_amount<>0
    OR NEW.income_tax<>0 OR NEW.local_income_tax<>0 OR NEW.other_deduction<>0
  )
BEGIN
  SELECT RAISE(ABORT,'invalid withholding tax treatment');
END;

CREATE TRIGGER IF NOT EXISTS trg_withholding_tax_treatment_update
BEFORE UPDATE OF income_type,tax_treatment,gross_amount,tax_exempt_amount,necessary_expense,
  taxable_amount,income_tax,local_income_tax,other_deduction ON accounting_withholding_records
WHEN NEW.tax_treatment NOT IN ('standard','reimbursement')
  OR NEW.tax_treatment='reimbursement' AND (
    NEW.income_type<>'other' OR NEW.tax_exempt_amount<>NEW.gross_amount
    OR NEW.necessary_expense<>0 OR NEW.taxable_amount<>0
    OR NEW.income_tax<>0 OR NEW.local_income_tax<>0 OR NEW.other_deduction<>0
  )
BEGIN
  SELECT RAISE(ABORT,'invalid withholding tax treatment');
END;

CREATE TRIGGER IF NOT EXISTS trg_withholding_source_limit_insert
BEFORE INSERT ON accounting_withholding_records
WHEN NEW.source_resolution_id IS NOT NULL AND (
  NOT EXISTS (
    SELECT 1 FROM accounting_resolutions r
    LEFT JOIN accounting_resolution_dimensions d ON d.resolution_id=r.id
    WHERE r.id=NEW.source_resolution_id AND r.resolution_type='expense' AND r.status IN ('approved','posted')
      AND r.fiscal_year=NEW.fiscal_year
      AND COALESCE(NULLIF(d.book_type_code,''),'general')=NEW.book_type_code
      AND COALESCE(NULLIF(d.entity_id,''),'ENTITY-HQ')=NEW.entity_id
      AND COALESCE(d.fund_id,'')=NEW.fund_id
  )
  OR NEW.gross_amount+COALESCE((
    SELECT SUM(w.gross_amount) FROM accounting_withholding_records w
    WHERE w.source_resolution_id=NEW.source_resolution_id AND w.filing_status<>'cancelled'
  ),0)>(SELECT r.amount FROM accounting_resolutions r WHERE r.id=NEW.source_resolution_id)
)
BEGIN
  SELECT RAISE(ABORT,'withholding source resolution limit exceeded');
END;

CREATE TRIGGER IF NOT EXISTS trg_withholding_source_limit_update
BEFORE UPDATE OF source_resolution_id,fiscal_year,book_type_code,entity_id,fund_id,gross_amount,filing_status
ON accounting_withholding_records
WHEN NEW.source_resolution_id IS NOT NULL AND NEW.filing_status<>'cancelled' AND (
  NOT EXISTS (
    SELECT 1 FROM accounting_resolutions r
    LEFT JOIN accounting_resolution_dimensions d ON d.resolution_id=r.id
    WHERE r.id=NEW.source_resolution_id AND r.resolution_type='expense' AND r.status IN ('approved','posted')
      AND r.fiscal_year=NEW.fiscal_year
      AND COALESCE(NULLIF(d.book_type_code,''),'general')=NEW.book_type_code
      AND COALESCE(NULLIF(d.entity_id,''),'ENTITY-HQ')=NEW.entity_id
      AND COALESCE(d.fund_id,'')=NEW.fund_id
  )
  OR NEW.gross_amount+COALESCE((
    SELECT SUM(w.gross_amount) FROM accounting_withholding_records w
    WHERE w.source_resolution_id=NEW.source_resolution_id AND w.filing_status<>'cancelled' AND w.id<>OLD.id
  ),0)>(SELECT r.amount FROM accounting_resolutions r WHERE r.id=NEW.source_resolution_id)
)
BEGIN
  SELECT RAISE(ABORT,'withholding source resolution limit exceeded');
END;

INSERT INTO accounting_meta(meta_key,meta_value,updated_at)
VALUES ('schema_version','2026-08-21.1',CURRENT_TIMESTAMP)
ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value,updated_at=excluded.updated_at;
