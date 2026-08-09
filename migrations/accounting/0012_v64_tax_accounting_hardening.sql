-- v64: 회계·세무 운영 배포 차단 결함 보완
-- 1) 확정·신고·납부자료 불변성 및 정정 계보
-- 2) 원자료 분할·취소 후 정정, 중복 전표 방지
-- 3) 세무보조장부와 총계정원장 연결
-- 4) 비동기 스냅샷 제출 패키지와 R2 보관 상태
-- 5) v63 과잉 계정이관의 안전한 복구

INSERT OR IGNORE INTO accounting_accounts
(code,name,account_type,normal_side,parent_code,active,system_account,created_at,updated_at)
VALUES
('2240','기타공제예수금','liability','credit','2200',1,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);

-- 이미 운영에 반영된 초기 v63 파일은 모든 1130 결의를 2110으로 바꿨습니다.
-- 계좌이체·현금은 자산계정만 허용되므로 1120으로 안전하게 복구할 수 있지만,
-- '기타'·과거 공란은 실제 미지급 거래일 수도 있어 임의 변환하지 않고 검토대장에 남깁니다.
UPDATE accounting_resolutions
SET settlement_account_code='1120',updated_at=CURRENT_TIMESTAMP
WHERE settlement_account_code='2110' AND payment_method IN ('계좌이체','현금');

-- 이미 생성된 비법인카드 결의 전표의 결제 상대계정도 함께 복구합니다.
UPDATE accounting_journal_lines
SET account_code='1120'
WHERE account_code='2110'
  AND journal_id IN (
    SELECT j.id FROM accounting_journals j
    JOIN accounting_resolutions r ON j.source_type='resolution' AND j.source_id=r.id
    WHERE r.payment_method IN ('계좌이체','현금')
  )
  AND line_no=2;

CREATE TABLE IF NOT EXISTS accounting_v63_migration_review (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  issue_code TEXT NOT NULL,
  current_value TEXT,
  suggested_value TEXT,
  detail TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  reviewed_by TEXT,
  reviewed_at TEXT,
  resolution_note TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(entity_type,entity_id,issue_code),
  CHECK (status IN ('open','resolved','dismissed'))
);

INSERT OR IGNORE INTO accounting_v63_migration_review
(id,entity_type,entity_id,issue_code,current_value,suggested_value,detail,status,created_at)
SELECT 'V63REV-'||lower(hex(randomblob(12))),'resolution',id,
       'AMBIGUOUS_NONCARD_2110','2110','1120',
       '초기 v63에서 1130→2110으로 일괄 변경됐을 가능성이 있으나 지급방법이 기타 또는 공란이어서 자동 복구하지 않았습니다. 원증빙과 전표를 확인해 1120 또는 실제 자산계정으로 정정하십시오.',
       'open',CURRENT_TIMESTAMP
FROM accounting_resolutions
WHERE settlement_account_code='2110'
  AND COALESCE(payment_method,'')<>'법인카드'
  AND COALESCE(payment_method,'') NOT IN ('계좌이체','현금');

CREATE INDEX IF NOT EXISTS idx_v63_migration_review_status
  ON accounting_v63_migration_review(status,issue_code,created_at);

-- 분류계정은 비용·수익 계정이어야 하므로 과거 1130→2110 자동변환 결과를
-- 임의의 다른 계정으로 재분류하지 않고 안전하게 검토대기로 돌립니다.
UPDATE accounting_matching_rules
SET active=0,updated_at=CURRENT_TIMESTAMP
WHERE account_code='2110';

UPDATE accounting_import_transactions
SET classification_account_code=NULL,
    status=CASE WHEN status IN ('suggested','unmatched') THEN 'unmatched' ELSE status END,
    suggested_type=NULL,suggested_id=NULL,suggested_score=NULL,
    suggested_reason='v64: 구 법인카드계정 자동변환 자료 재분류 필요',
    updated_at=CURRENT_TIMESTAMP
WHERE classification_account_code='2110' AND status IN ('suggested','unmatched');

-- 과거 이관 과정의 중복가산 가능성을 없애기 위해 월집계를 원전표에서 전면 재산출합니다.
DELETE FROM accounting_monthly_summary;
INSERT INTO accounting_monthly_summary
(fiscal_year,period_month,book_type_code,entity_id,fund_id,account_code,department,project,
 debit_total,credit_total,updated_at)
SELECT j.fiscal_year,CAST(substr(j.journal_date,6,2) AS INTEGER),
       COALESCE(NULLIF(d.book_type_code,''),'general'),
       COALESCE(NULLIF(d.entity_id,''),'ENTITY-HQ'),COALESCE(d.fund_id,''),
       l.account_code,COALESCE(l.department,''),COALESCE(l.project,''),
       SUM(l.debit),SUM(l.credit),CURRENT_TIMESTAMP
FROM accounting_journals j
JOIN accounting_journal_lines l ON l.journal_id=j.id
LEFT JOIN accounting_journal_line_dimensions d ON d.journal_line_id=l.id
WHERE j.status IN ('posted','reversed')
GROUP BY j.fiscal_year,CAST(substr(j.journal_date,6,2) AS INTEGER),
         COALESCE(NULLIF(d.book_type_code,''),'general'),
         COALESCE(NULLIF(d.entity_id,''),'ENTITY-HQ'),COALESCE(d.fund_id,''),
         l.account_code,COALESCE(l.department,''),COALESCE(l.project,'');

ALTER TABLE accounting_tax_profiles ADD COLUMN revision_no INTEGER NOT NULL DEFAULT 1;
ALTER TABLE accounting_tax_profiles ADD COLUMN change_reason TEXT;

CREATE TABLE IF NOT EXISTS accounting_tax_profile_revisions (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  fiscal_year INTEGER NOT NULL,
  entity_id TEXT NOT NULL,
  revision_no INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  change_reason TEXT NOT NULL,
  changed_by TEXT NOT NULL,
  changed_at TEXT NOT NULL,
  UNIQUE(profile_id,revision_no)
);

CREATE INDEX IF NOT EXISTS idx_tax_profile_revisions_profile
  ON accounting_tax_profile_revisions(profile_id,revision_no DESC);

ALTER TABLE accounting_vat_records ADD COLUMN source_line_no INTEGER NOT NULL DEFAULT 1;
ALTER TABLE accounting_vat_records ADD COLUMN supersedes_id TEXT;
ALTER TABLE accounting_vat_records ADD COLUMN cancellation_reason TEXT;
ALTER TABLE accounting_vat_records ADD COLUMN cancelled_by TEXT;
ALTER TABLE accounting_vat_records ADD COLUMN cancelled_at TEXT;
ALTER TABLE accounting_vat_records ADD COLUMN adjustment_journal_id TEXT;
ALTER TABLE accounting_vat_records ADD COLUMN version_no INTEGER NOT NULL DEFAULT 1;

DROP INDEX IF EXISTS idx_vat_records_unique_linked_source;
CREATE UNIQUE INDEX IF NOT EXISTS idx_vat_records_active_source_line
  ON accounting_vat_records(source_type,source_id,source_line_no)
  WHERE source_id<>'' AND status<>'cancelled';
CREATE UNIQUE INDEX IF NOT EXISTS idx_vat_records_adjustment_journal
  ON accounting_vat_records(adjustment_journal_id)
  WHERE adjustment_journal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_vat_records_supersedes
  ON accounting_vat_records(supersedes_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_vat_records_one_successor
  ON accounting_vat_records(supersedes_id) WHERE supersedes_id IS NOT NULL;

ALTER TABLE accounting_withholding_records ADD COLUMN supersedes_id TEXT;
ALTER TABLE accounting_withholding_records ADD COLUMN source_verification_note TEXT;
ALTER TABLE accounting_withholding_records ADD COLUMN cancellation_reason TEXT;
ALTER TABLE accounting_withholding_records ADD COLUMN cancelled_by TEXT;
ALTER TABLE accounting_withholding_records ADD COLUMN cancelled_at TEXT;
ALTER TABLE accounting_withholding_records ADD COLUMN accrual_journal_id TEXT;
ALTER TABLE accounting_withholding_records ADD COLUMN payment_journal_id TEXT;
ALTER TABLE accounting_withholding_records ADD COLUMN tax_payment_bank_account_code TEXT;
ALTER TABLE accounting_withholding_records ADD COLUMN version_no INTEGER NOT NULL DEFAULT 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_withholding_accrual_journal
  ON accounting_withholding_records(accrual_journal_id)
  WHERE accrual_journal_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_withholding_payment_journal
  ON accounting_withholding_records(payment_journal_id)
  WHERE payment_journal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_withholding_resolution_active
  ON accounting_withholding_records(source_resolution_id,filing_status,payment_date);
CREATE INDEX IF NOT EXISTS idx_withholding_supersedes
  ON accounting_withholding_records(supersedes_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_withholding_one_successor
  ON accounting_withholding_records(supersedes_id) WHERE supersedes_id IS NOT NULL;

ALTER TABLE accounting_card_payments ADD COLUMN request_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_card_payments_request_id
  ON accounting_card_payments(request_id) WHERE request_id IS NOT NULL;

-- 패키지 스냅샷 경계 이후 상태변경(역분개 등)을 감지할 수 있도록 전표 수정시각을 보강합니다.
ALTER TABLE accounting_journals ADD COLUMN updated_at TEXT;
UPDATE accounting_journals SET updated_at=COALESCE(updated_at,created_at,CURRENT_TIMESTAMP);

CREATE TRIGGER IF NOT EXISTS trg_journal_set_updated_at_insert
AFTER INSERT ON accounting_journals
WHEN NEW.updated_at IS NULL
BEGIN
  UPDATE accounting_journals SET updated_at=COALESCE(NEW.created_at,CURRENT_TIMESTAMP) WHERE id=NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_journal_set_updated_at_update
AFTER UPDATE ON accounting_journals
WHEN NEW.updated_at IS OLD.updated_at
BEGIN
  UPDATE accounting_journals SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=NEW.id;
END;

-- 전표행·회계차원 수정도 전표의 스냅샷 경계를 전진시킵니다. 전표 본문만
-- 감시하면 행 금액이나 차원 변경이 제출 패키지에 조용히 섞일 수 있습니다.
CREATE TRIGGER IF NOT EXISTS trg_journal_line_touch_insert
AFTER INSERT ON accounting_journal_lines
BEGIN
  UPDATE accounting_journals SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=NEW.journal_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_journal_line_touch_update
AFTER UPDATE ON accounting_journal_lines
BEGIN
  UPDATE accounting_journals SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id IN (OLD.journal_id,NEW.journal_id);
END;

CREATE TRIGGER IF NOT EXISTS trg_journal_line_touch_delete
AFTER DELETE ON accounting_journal_lines
BEGIN
  UPDATE accounting_journals SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=OLD.journal_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_journal_dimension_touch_insert
AFTER INSERT ON accounting_journal_line_dimensions
BEGIN
  UPDATE accounting_journals SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE id=(SELECT journal_id FROM accounting_journal_lines WHERE id=NEW.journal_line_id);
END;

CREATE TRIGGER IF NOT EXISTS trg_journal_dimension_touch_update
AFTER UPDATE ON accounting_journal_line_dimensions
BEGIN
  UPDATE accounting_journals SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE id IN (
    SELECT journal_id FROM accounting_journal_lines WHERE id IN (OLD.journal_line_id,NEW.journal_line_id)
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_journal_dimension_touch_delete
AFTER DELETE ON accounting_journal_line_dimensions
BEGIN
  UPDATE accounting_journals SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE id=(SELECT journal_id FROM accounting_journal_lines WHERE id=OLD.journal_line_id);
END;

-- 동일 원천자료에 게시 전표가 두 번 생기는 것을 DB가 최종 차단합니다.
CREATE TRIGGER IF NOT EXISTS trg_journal_source_duplicate_insert
BEFORE INSERT ON accounting_journals
WHEN NEW.source_id IS NOT NULL AND NEW.source_id<>'' AND NEW.status IN ('posted','reversed')
  AND EXISTS (
    SELECT 1 FROM accounting_journals j
    WHERE j.source_type=NEW.source_type AND j.source_id=NEW.source_id
      AND j.status IN ('posted','reversed')
  )
BEGIN
  SELECT RAISE(ABORT,'duplicate posted journal source');
END;

CREATE TRIGGER IF NOT EXISTS trg_journal_source_duplicate_update
BEFORE UPDATE OF source_type,source_id,status ON accounting_journals
WHEN NEW.source_id IS NOT NULL AND NEW.source_id<>'' AND NEW.status IN ('posted','reversed')
  AND EXISTS (
    SELECT 1 FROM accounting_journals j
    WHERE j.id<>OLD.id AND j.source_type=NEW.source_type AND j.source_id=NEW.source_id
      AND j.status IN ('posted','reversed')
  )
BEGIN
  SELECT RAISE(ABORT,'duplicate posted journal source');
END;

CREATE TRIGGER IF NOT EXISTS trg_card_transaction_single_journal
BEFORE UPDATE OF journal_id ON accounting_card_transactions
WHEN (OLD.journal_id IS NOT NULL AND NEW.journal_id IS NOT OLD.journal_id)
  OR (NEW.journal_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM accounting_card_transactions t WHERE t.id<>OLD.id AND t.journal_id=NEW.journal_id
  ))
BEGIN
  SELECT RAISE(ABORT,'card transaction journal link is immutable or duplicated');
END;

-- 정정본은 반드시 취소된 직전본을 한 번만 승계하며, 원자료 행·회계범위와
-- 버전 번호를 이어받아야 합니다. 애플리케이션 우회 입력도 DB에서 차단합니다.
CREATE TRIGGER IF NOT EXISTS trg_vat_correction_lineage_insert
BEFORE INSERT ON accounting_vat_records
WHEN NEW.supersedes_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM accounting_vat_records p
  WHERE p.id=NEW.supersedes_id AND p.id<>NEW.id AND p.status='cancelled'
    AND p.source_type=NEW.source_type AND p.source_id=NEW.source_id
    AND p.source_line_no=NEW.source_line_no
    AND p.book_type_code=NEW.book_type_code AND p.entity_id=NEW.entity_id
    AND COALESCE(p.fund_id,'')=COALESCE(NEW.fund_id,'')
    AND NEW.version_no=p.version_no+1
)
BEGIN
  SELECT RAISE(ABORT,'invalid vat correction lineage');
END;

CREATE TRIGGER IF NOT EXISTS trg_vat_correction_lineage_update
BEFORE UPDATE OF supersedes_id,source_type,source_id,source_line_no,
  book_type_code,entity_id,fund_id,version_no ON accounting_vat_records
WHEN NEW.supersedes_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM accounting_vat_records p
  WHERE p.id=NEW.supersedes_id AND p.id<>NEW.id AND p.status='cancelled'
    AND p.source_type=NEW.source_type AND p.source_id=NEW.source_id
    AND p.source_line_no=NEW.source_line_no
    AND p.book_type_code=NEW.book_type_code AND p.entity_id=NEW.entity_id
    AND COALESCE(p.fund_id,'')=COALESCE(NEW.fund_id,'')
    AND NEW.version_no=p.version_no+1
)
BEGIN
  SELECT RAISE(ABORT,'invalid vat correction lineage');
END;

CREATE TRIGGER IF NOT EXISTS trg_withholding_correction_lineage_insert
BEFORE INSERT ON accounting_withholding_records
WHEN NEW.supersedes_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM accounting_withholding_records p
  WHERE p.id=NEW.supersedes_id AND p.id<>NEW.id AND p.filing_status='cancelled'
    AND COALESCE(p.source_resolution_id,'')=COALESCE(NEW.source_resolution_id,'')
    AND p.book_type_code=NEW.book_type_code AND p.entity_id=NEW.entity_id
    AND COALESCE(p.fund_id,'')=COALESCE(NEW.fund_id,'')
    AND NEW.version_no=p.version_no+1
)
BEGIN
  SELECT RAISE(ABORT,'invalid withholding correction lineage');
END;

CREATE TRIGGER IF NOT EXISTS trg_withholding_correction_lineage_update
BEFORE UPDATE OF supersedes_id,source_resolution_id,book_type_code,entity_id,fund_id,version_no
ON accounting_withholding_records
WHEN NEW.supersedes_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM accounting_withholding_records p
  WHERE p.id=NEW.supersedes_id AND p.id<>NEW.id AND p.filing_status='cancelled'
    AND COALESCE(p.source_resolution_id,'')=COALESCE(NEW.source_resolution_id,'')
    AND p.book_type_code=NEW.book_type_code AND p.entity_id=NEW.entity_id
    AND COALESCE(p.fund_id,'')=COALESCE(NEW.fund_id,'')
    AND NEW.version_no=p.version_no+1
)
BEGIN
  SELECT RAISE(ABORT,'invalid withholding correction lineage');
END;

-- 확정 VAT 자료는 취소 메타데이터 이외에는 바꿀 수 없고, 취소자료는 완전 불변입니다.
CREATE TRIGGER IF NOT EXISTS trg_vat_cancelled_immutable
BEFORE UPDATE ON accounting_vat_records
WHEN OLD.status='cancelled'
BEGIN
  SELECT RAISE(ABORT,'cancelled vat record is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_vat_confirmed_values_immutable
BEFORE UPDATE OF fiscal_year,transaction_date,direction,source_type,source_id,source_line_no,
  book_type_code,entity_id,fund_id,counterparty_name,counterparty_business_no,evidence_type,
  evidence_no,total_amount,supply_amount,vat_amount,tax_type,deduction_status,
  non_deductible_reason,filing_period,memo,confirmed_by,confirmed_at,supersedes_id,version_no
ON accounting_vat_records
WHEN OLD.status='confirmed'
BEGIN
  SELECT RAISE(ABORT,'confirmed vat record is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_vat_confirmed_status_guard
BEFORE UPDATE OF status ON accounting_vat_records
WHEN OLD.status='confirmed' AND NEW.status<>'cancelled'
BEGIN
  SELECT RAISE(ABORT,'confirmed vat record is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_vat_cancellation_metadata_guard
BEFORE UPDATE OF cancellation_reason,cancelled_by,cancelled_at ON accounting_vat_records
WHEN OLD.status='confirmed' AND NEW.status<>'cancelled'
BEGIN
  SELECT RAISE(ABORT,'vat cancellation metadata requires cancellation');
END;

CREATE TRIGGER IF NOT EXISTS trg_vat_cancel_requires_reversed_journal
BEFORE UPDATE OF status ON accounting_vat_records
WHEN NEW.status='cancelled' AND OLD.adjustment_journal_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM accounting_journals j WHERE j.id=OLD.adjustment_journal_id AND j.status='posted')
BEGIN
  SELECT RAISE(ABORT,'vat linked journal must be reversed before cancellation');
END;

CREATE TRIGGER IF NOT EXISTS trg_vat_adjustment_once
BEFORE UPDATE OF adjustment_journal_id ON accounting_vat_records
WHEN OLD.status='confirmed' AND NOT (OLD.adjustment_journal_id IS NULL AND NEW.adjustment_journal_id IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT,'vat adjustment journal is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_vat_cancel_requires_reason
BEFORE UPDATE OF status ON accounting_vat_records
WHEN NEW.status='cancelled' AND (
  LENGTH(TRIM(COALESCE(NEW.cancellation_reason,'')))=0
  OR NEW.cancelled_by IS NULL OR NEW.cancelled_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT,'vat cancellation reason is required');
END;

-- 신고·납부자료는 상태가 앞으로만 진행하며, 취소는 사유와 감사정보를 남깁니다.
CREATE TRIGGER IF NOT EXISTS trg_withholding_cancelled_immutable
BEFORE UPDATE ON accounting_withholding_records
WHEN OLD.filing_status='cancelled'
BEGIN
  SELECT RAISE(ABORT,'cancelled withholding record is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_withholding_filed_values_immutable
BEFORE UPDATE OF payment_no,fiscal_year,payment_date,payee_id,income_type,religious_income_method,
  source_resolution_id,book_type_code,entity_id,fund_id,gross_amount,tax_exempt_amount,
  necessary_expense,taxable_amount,income_tax,local_income_tax,other_deduction,net_amount,
  filing_month,filing_due_date,filed_at,memo,supersedes_id,source_verification_note,version_no,accrual_journal_id
ON accounting_withholding_records
WHEN OLD.filing_status IN ('filed','paid')
BEGIN
  SELECT RAISE(ABORT,'filed withholding record is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_withholding_payment_metadata_guard
BEFORE UPDATE OF payment_journal_id,tax_payment_bank_account_code,paid_at ON accounting_withholding_records
WHEN OLD.filing_status='filed' AND NEW.filing_status<>'paid'
BEGIN
  SELECT RAISE(ABORT,'withholding payment metadata requires paid transition');
END;

CREATE TRIGGER IF NOT EXISTS trg_withholding_status_forward_only
BEFORE UPDATE OF filing_status ON accounting_withholding_records
WHEN (OLD.filing_status='filed' AND NEW.filing_status NOT IN ('paid','cancelled'))
   OR (OLD.filing_status='paid' AND NEW.filing_status<>'cancelled')
BEGIN
  SELECT RAISE(ABORT,'filed withholding record is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_withholding_paid_requires_journal
BEFORE UPDATE OF filing_status ON accounting_withholding_records
WHEN NEW.filing_status='paid'
  AND (NEW.income_tax+NEW.local_income_tax)>0
  AND NEW.payment_journal_id IS NULL
BEGIN
  SELECT RAISE(ABORT,'withholding payment journal is required');
END;

CREATE TRIGGER IF NOT EXISTS trg_withholding_paid_metadata_immutable
BEFORE UPDATE OF payment_journal_id,tax_payment_bank_account_code,paid_at
ON accounting_withholding_records
WHEN OLD.filing_status='paid'
BEGIN
  SELECT RAISE(ABORT,'paid withholding metadata is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_withholding_cancel_requires_reason
BEFORE UPDATE OF filing_status ON accounting_withholding_records
WHEN NEW.filing_status='cancelled' AND (
  LENGTH(TRIM(COALESCE(NEW.cancellation_reason,'')))=0
  OR NEW.cancelled_by IS NULL OR NEW.cancelled_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT,'withholding cancellation reason is required');
END;

CREATE TRIGGER IF NOT EXISTS trg_withholding_cancellation_metadata_guard
BEFORE UPDATE OF cancellation_reason,cancelled_by,cancelled_at ON accounting_withholding_records
WHEN OLD.filing_status IN ('filed','paid') AND NEW.filing_status<>'cancelled'
BEGIN
  SELECT RAISE(ABORT,'withholding cancellation metadata requires cancellation');
END;

CREATE TRIGGER IF NOT EXISTS trg_withholding_cancel_requires_reversed_journals
BEFORE UPDATE OF filing_status ON accounting_withholding_records
WHEN NEW.filing_status='cancelled' AND (
  EXISTS (SELECT 1 FROM accounting_journals j WHERE j.id=OLD.accrual_journal_id AND j.status='posted')
  OR EXISTS (SELECT 1 FROM accounting_journals j WHERE j.id=OLD.payment_journal_id AND j.status='posted')
)
BEGIN
  SELECT RAISE(ABORT,'withholding linked journals must be reversed before cancellation');
END;

CREATE TRIGGER IF NOT EXISTS trg_tax_profile_confirmed_revision_guard
BEFORE UPDATE ON accounting_tax_profiles
WHEN OLD.profile_status='confirmed' AND (
  NEW.profile_status<>'confirmed' OR NEW.revision_no<>OLD.revision_no+1
  OR NEW.id<>OLD.id OR NEW.fiscal_year<>OLD.fiscal_year OR NEW.entity_id<>OLD.entity_id
  OR LENGTH(TRIM(COALESCE(NEW.change_reason,'')))=0
)
BEGIN
  SELECT RAISE(ABORT,'confirmed tax profile requires explicit revision');
END;

-- 원장과 직접 연결된 카드결제 이력은 정정 대신 역분개·신규결제로 처리합니다.
CREATE TRIGGER IF NOT EXISTS trg_card_payment_immutable
BEFORE UPDATE ON accounting_card_payments
BEGIN
  SELECT RAISE(ABORT,'posted card payment is immutable');
END;

-- 확정·신고자료의 물리삭제는 최고관리자 테스트자료 전체초기화 중에만 허용합니다.
CREATE TRIGGER IF NOT EXISTS trg_tax_profile_confirmed_delete_guard
BEFORE DELETE ON accounting_tax_profiles
WHEN OLD.profile_status='confirmed' AND COALESCE((
  SELECT meta_value FROM accounting_meta WHERE meta_key='test_reset_in_progress'
),'0')<>'1'
BEGIN
  SELECT RAISE(ABORT,'confirmed tax profile cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_vat_final_delete_guard
BEFORE DELETE ON accounting_vat_records
WHEN OLD.status IN ('confirmed','cancelled') AND COALESCE((
  SELECT meta_value FROM accounting_meta WHERE meta_key='test_reset_in_progress'
),'0')<>'1'
BEGIN
  SELECT RAISE(ABORT,'final vat record cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_withholding_final_delete_guard
BEFORE DELETE ON accounting_withholding_records
WHEN OLD.filing_status IN ('filed','paid','cancelled') AND COALESCE((
  SELECT meta_value FROM accounting_meta WHERE meta_key='test_reset_in_progress'
),'0')<>'1'
BEGIN
  SELECT RAISE(ABORT,'final withholding record cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_card_payment_delete_guard
BEFORE DELETE ON accounting_card_payments
WHEN COALESCE((SELECT meta_value FROM accounting_meta WHERE meta_key='test_reset_in_progress'),'0')<>'1'
BEGIN
  SELECT RAISE(ABORT,'posted card payment cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_tax_profile_revision_history
AFTER UPDATE ON accounting_tax_profiles
WHEN OLD.profile_status='confirmed'
BEGIN
  INSERT INTO accounting_tax_profile_revisions
  (id,profile_id,fiscal_year,entity_id,revision_no,snapshot_json,change_reason,changed_by,changed_at)
  VALUES (
    'TPREV-'||lower(hex(randomblob(12))),OLD.id,OLD.fiscal_year,OLD.entity_id,OLD.revision_no,
    json_object(
      'legal_name',OLD.legal_name,'organization_type',OLD.organization_type,
      'registration_no',OLD.registration_no,'corporate_registration_no',OLD.corporate_registration_no,
      'tax_office_name',OLD.tax_office_name,'public_interest_status',OLD.public_interest_status,
      'qualified_donation_status',OLD.qualified_donation_status,'qualified_from',OLD.qualified_from,
      'qualified_to',OLD.qualified_to,'revenue_business_enabled',OLD.revenue_business_enabled,
      'vat_business_type',OLD.vat_business_type,'vat_reporting_cycle',OLD.vat_reporting_cycle,
      'withholding_enabled',OLD.withholding_enabled,'religious_income_method',OLD.religious_income_method,
      'electronic_donation_required',OLD.electronic_donation_required,'tax_agent_name',OLD.tax_agent_name,
      'tax_agent_contact',OLD.tax_agent_contact,'tax_agent_email',OLD.tax_agent_email,
      'profile_status',OLD.profile_status,'memo',OLD.memo,'confirmed_by',OLD.confirmed_by,
      'confirmed_at',OLD.confirmed_at,'updated_by',OLD.updated_by,'updated_at',OLD.updated_at
    ),NEW.change_reason,NEW.updated_by,NEW.updated_at
  );
END;

-- 기존 완료 이력은 ready로 보존하고, 신규 작업은 queued부터 상태를 진행합니다.
ALTER TABLE accounting_tax_export_batches ADD COLUMN request_id TEXT;
ALTER TABLE accounting_tax_export_batches ADD COLUMN status TEXT NOT NULL DEFAULT 'ready';
ALTER TABLE accounting_tax_export_batches ADD COLUMN snapshot_at TEXT;
ALTER TABLE accounting_tax_export_batches ADD COLUMN started_at TEXT;
ALTER TABLE accounting_tax_export_batches ADD COLUMN completed_at TEXT;
ALTER TABLE accounting_tax_export_batches ADD COLUMN failed_at TEXT;
ALTER TABLE accounting_tax_export_batches ADD COLUMN error_message TEXT;
ALTER TABLE accounting_tax_export_batches ADD COLUMN progress_current INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounting_tax_export_batches ADD COLUMN progress_total INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounting_tax_export_batches ADD COLUMN package_object_key TEXT;
ALTER TABLE accounting_tax_export_batches ADD COLUMN package_etag TEXT;
ALTER TABLE accounting_tax_export_batches ADD COLUMN retention_until TEXT;
ALTER TABLE accounting_tax_export_batches ADD COLUMN requested_by_user_id TEXT;
ALTER TABLE accounting_tax_export_batches ADD COLUMN lease_token TEXT;
ALTER TABLE accounting_tax_export_batches ADD COLUMN lease_expires_at TEXT;
ALTER TABLE accounting_tax_export_batches ADD COLUMN last_heartbeat_at TEXT;
ALTER TABLE accounting_tax_export_batches ADD COLUMN cleanup_at TEXT;
ALTER TABLE accounting_tax_export_batches ADD COLUMN cleanup_error TEXT;

UPDATE accounting_tax_export_batches
SET status='ready',snapshot_at=COALESCE(snapshot_at,created_at),
    started_at=COALESCE(started_at,created_at),completed_at=COALESCE(completed_at,created_at),
    progress_current=CASE WHEN file_count>0 THEN file_count ELSE progress_current END,
    progress_total=CASE WHEN file_count>0 THEN file_count ELSE progress_total END
WHERE package_sha256 IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tax_exports_request_id
  ON accounting_tax_export_batches(request_id) WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tax_exports_status_lease
  ON accounting_tax_export_batches(status,lease_expires_at,created_at);

CREATE TABLE IF NOT EXISTS accounting_tax_export_files (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  sequence_no INTEGER NOT NULL,
  dataset_key TEXT NOT NULL,
  file_name TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL DEFAULT 'text/csv; charset=utf-8',
  expected_row_count INTEGER NOT NULL DEFAULT 0,
  row_count INTEGER NOT NULL DEFAULT 0,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  crc32 INTEGER,
  sha256 TEXT,
  etag TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(batch_id,sequence_no),
  UNIQUE(batch_id,dataset_key),
  CHECK (status IN ('pending','processing','ready','failed')),
  CHECK (expected_row_count>=0 AND row_count>=0 AND size_bytes>=0)
);

CREATE INDEX IF NOT EXISTS idx_tax_export_files_batch_status
  ON accounting_tax_export_files(batch_id,status,sequence_no);

CREATE TABLE IF NOT EXISTS accounting_tax_export_events (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tax_export_events_batch
  ON accounting_tax_export_events(batch_id,created_at,id);

INSERT INTO accounting_meta(meta_key,meta_value,updated_at)
VALUES ('schema_version','2026-08-08.2',CURRENT_TIMESTAMP)
ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value,updated_at=excluded.updated_at;
