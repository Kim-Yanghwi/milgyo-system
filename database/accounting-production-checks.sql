-- 세무·회계 운영 데이터베이스 읽기전용 검증
-- 모든 오류성 count가 0이어야 외부 세무자료 패키지를 배포할 수 있습니다.

SELECT 'SCHEMA_VERSION' AS check_name,
       COALESCE((SELECT meta_value FROM accounting_meta WHERE meta_key='schema_version'),'MISSING') AS result;

SELECT 'SCHEMA_VERSION_MISMATCH' AS check_name,COUNT(*) AS count
FROM (SELECT COALESCE((SELECT meta_value FROM accounting_meta WHERE meta_key='schema_version'),'MISSING') AS version)
WHERE version<>'2026-08-21.1';

WITH required(name) AS (
  VALUES
    ('accounting_card_payments'),
    ('accounting_tax_profiles'),
    ('accounting_tax_profile_revisions'),
    ('accounting_vat_records'),
    ('accounting_tax_payees'),
    ('accounting_withholding_records'),
    ('accounting_tax_export_batches'),
    ('accounting_tax_export_files'),
    ('accounting_tax_export_events'),
    ('accounting_v63_migration_review'),
    ('accounting_attachments')
)
SELECT 'REQUIRED_TABLES_MISSING' AS check_name,COUNT(*) AS count,GROUP_CONCAT(required.name) AS detail
FROM required LEFT JOIN sqlite_master m ON m.type='table' AND m.name=required.name
WHERE m.name IS NULL;


-- v71~v73 규정대응·공공조달·준비금·차량 스키마 존재 확인
WITH required(name) AS (
  VALUES
    ('accounting_revenue_businesses'),
    ('accounting_procurement_reviews'),
    ('accounting_procurement_guarantees'),
    ('accounting_purpose_reserves'),
    ('accounting_purpose_reserve_transactions'),
    ('accounting_compliance_checks'),
    ('accounting_finance_incidents'),
    ('accounting_vehicle_records'),
    ('accounting_vehicle_logs')
)
SELECT 'COMPLIANCE_TABLES_MISSING' AS check_name,COUNT(*) AS count,GROUP_CONCAT(required.name) AS detail
FROM required LEFT JOIN sqlite_master m ON m.type='table' AND m.name=required.name
WHERE m.name IS NULL;

WITH required(name) AS (VALUES ('responsible_user_id'),('responsible_name'))
SELECT 'PROCUREMENT_V73_COLUMNS_MISSING' AS check_name,COUNT(*) AS count,GROUP_CONCAT(required.name) AS detail
FROM required LEFT JOIN pragma_table_info('accounting_procurement_reviews') p ON p.name=required.name
WHERE p.name IS NULL;

WITH required(name) AS (VALUES ('supply_amount'),('tax_type'),('tax_mode'),('tax_note'))
SELECT 'CARD_V81_TAX_COLUMNS_MISSING' AS check_name,COUNT(*) AS count,GROUP_CONCAT(required.name) AS detail
FROM required LEFT JOIN pragma_table_info('accounting_card_transactions') p ON p.name=required.name
WHERE p.name IS NULL;

WITH required(name) AS (VALUES ('tax_treatment'))
SELECT 'WITHHOLDING_V81_COLUMNS_MISSING' AS check_name,COUNT(*) AS count,GROUP_CONCAT(required.name) AS detail
FROM required LEFT JOIN pragma_table_info('accounting_withholding_records') p ON p.name=required.name
WHERE p.name IS NULL;

WITH required(name) AS (
  VALUES
    ('trg_journal_source_duplicate_insert'),
    ('trg_journal_source_duplicate_update'),
    ('trg_journal_line_touch_update'),
    ('trg_journal_dimension_touch_update'),
    ('trg_card_transaction_single_journal'),
    ('trg_card_payment_immutable'),
    ('trg_card_payment_delete_guard'),
    ('trg_vat_correction_lineage_insert'),
    ('trg_vat_correction_lineage_update'),
    ('trg_vat_confirmed_values_immutable'),
    ('trg_vat_cancelled_immutable'),
    ('trg_vat_cancel_requires_reversed_journal'),
    ('trg_vat_final_delete_guard'),
    ('trg_withholding_correction_lineage_insert'),
    ('trg_withholding_correction_lineage_update'),
    ('trg_withholding_filed_values_immutable'),
    ('trg_withholding_cancelled_immutable'),
    ('trg_withholding_cancel_requires_reversed_journals'),
    ('trg_withholding_final_delete_guard'),
    ('trg_tax_profile_confirmed_revision_guard'),
    ('trg_tax_profile_revision_history'),
    ('trg_tax_profile_confirmed_delete_guard'),
    ('trg_card_tax_fields_insert'),
    ('trg_card_tax_fields_update'),
    ('trg_asset_disposed_immutable'),
    ('trg_reserve_use_limit'),
    ('trg_reserve_reversal_limit'),
    ('trg_contract_payment_total_insert'),
    ('trg_budget_not_below_execution_update'),
    ('trg_attachment_reference_limits_insert'),
    ('trg_withholding_tax_treatment_insert'),
    ('trg_withholding_source_limit_insert')
)
SELECT 'REQUIRED_TRIGGERS_MISSING' AS check_name,COUNT(*) AS count,GROUP_CONCAT(required.name) AS detail
FROM required LEFT JOIN sqlite_master m ON m.type='trigger' AND m.name=required.name
WHERE m.name IS NULL;

SELECT 'MIGRATION_REVIEW_OPEN' AS check_name,COUNT(*) AS count
FROM accounting_v63_migration_review WHERE status='open';

SELECT 'DUPLICATE_POSTED_SOURCE_JOURNALS' AS check_name,COUNT(*) AS count
FROM (
  SELECT source_type,source_id
  FROM accounting_journals
  WHERE source_id IS NOT NULL AND source_id<>'' AND status IN ('posted','reversed')
  GROUP BY source_type,source_id HAVING COUNT(*)>1
);

SELECT 'UNBALANCED_JOURNALS' AS check_name,COUNT(*) AS count
FROM (
  SELECT j.id
  FROM accounting_journals j JOIN accounting_journal_lines l ON l.journal_id=j.id
  WHERE j.status IN ('posted','reversed')
  GROUP BY j.id HAVING SUM(l.debit)<>SUM(l.credit)
);

SELECT 'DUPLICATE_CARD_JOURNAL_LINKS' AS check_name,COUNT(*) AS count
FROM (
  SELECT journal_id FROM accounting_card_transactions
  WHERE journal_id IS NOT NULL GROUP BY journal_id HAVING COUNT(*)>1
);

SELECT 'ACTIVE_VAT_SOURCE_LINE_DUPLICATES' AS check_name,COUNT(*) AS count
FROM (
  SELECT source_type,source_id,source_line_no
  FROM accounting_vat_records
  WHERE source_id<>'' AND status<>'cancelled'
  GROUP BY source_type,source_id,source_line_no HAVING COUNT(*)>1
);

SELECT 'VAT_CORRECTION_LINEAGE_INVALID' AS check_name,COUNT(*) AS count
FROM accounting_vat_records v
LEFT JOIN accounting_vat_records p ON p.id=v.supersedes_id
WHERE v.supersedes_id IS NOT NULL AND (
  p.id IS NULL OR p.status<>'cancelled'
  OR p.source_type<>v.source_type OR p.source_id<>v.source_id
  OR p.source_line_no<>v.source_line_no
  OR p.book_type_code<>v.book_type_code OR p.entity_id<>v.entity_id
  OR COALESCE(p.fund_id,'')<>COALESCE(v.fund_id,'')
  OR v.version_no<>p.version_no+1
);

SELECT 'WITHHOLDING_CORRECTION_LINEAGE_INVALID' AS check_name,COUNT(*) AS count
FROM accounting_withholding_records w
LEFT JOIN accounting_withholding_records p ON p.id=w.supersedes_id
WHERE w.supersedes_id IS NOT NULL AND (
  p.id IS NULL OR p.filing_status<>'cancelled'
  OR COALESCE(p.source_resolution_id,'')<>COALESCE(w.source_resolution_id,'')
  OR p.book_type_code<>w.book_type_code OR p.entity_id<>w.entity_id
  OR COALESCE(p.fund_id,'')<>COALESCE(w.fund_id,'')
  OR w.version_no<>p.version_no+1
);

SELECT 'WITHHOLDING_TREATMENT_INVALID' AS check_name,COUNT(*) AS count
FROM accounting_withholding_records
WHERE tax_treatment NOT IN ('standard','reimbursement')
  OR tax_treatment='reimbursement' AND (
    income_type<>'other' OR tax_exempt_amount<>gross_amount OR necessary_expense<>0 OR taxable_amount<>0
    OR income_tax<>0 OR local_income_tax<>0 OR other_deduction<>0
  );

SELECT 'WITHHOLDING_SOURCE_INVALID_OR_EXCEEDED' AS check_name,
  (SELECT COUNT(*) FROM (
    SELECT w.source_resolution_id
    FROM accounting_withholding_records w
    JOIN accounting_resolutions r ON r.id=w.source_resolution_id
    LEFT JOIN accounting_resolution_dimensions d ON d.resolution_id=r.id
    WHERE w.source_resolution_id IS NOT NULL AND w.filing_status<>'cancelled'
    GROUP BY w.source_resolution_id,r.amount,r.resolution_type,r.status,r.fiscal_year,
      d.book_type_code,d.entity_id,d.fund_id
    HAVING r.resolution_type<>'expense' OR r.status NOT IN ('approved','posted')
      OR COUNT(CASE WHEN w.fiscal_year<>r.fiscal_year
        OR w.book_type_code<>COALESCE(NULLIF(d.book_type_code,''),'general')
        OR w.entity_id<>COALESCE(NULLIF(d.entity_id,''),'ENTITY-HQ')
        OR w.fund_id<>COALESCE(d.fund_id,'') THEN 1 END)>0
      OR SUM(w.gross_amount)>r.amount
  ))
  + (SELECT COUNT(*) FROM accounting_withholding_records w
    LEFT JOIN accounting_resolutions r ON r.id=w.source_resolution_id
    WHERE w.source_resolution_id IS NOT NULL AND r.id IS NULL) AS count;

SELECT 'CONFIRMED_VAT_LEDGER_MISMATCH' AS check_name,COUNT(*) AS count
FROM (
  SELECT v.id
  FROM accounting_vat_records v
  LEFT JOIN accounting_journals j ON j.id=v.adjustment_journal_id
  LEFT JOIN accounting_journal_lines l ON l.journal_id=j.id
  WHERE v.status='confirmed' AND v.tax_type='taxable' AND v.vat_amount>0
    AND (v.direction='sale' OR (v.direction='purchase' AND v.deduction_status='deductible'))
  GROUP BY v.id,v.direction,v.vat_amount,v.adjustment_journal_id,j.status
  HAVING v.adjustment_journal_id IS NULL OR j.status<>'posted'
    OR (v.direction='purchase' AND COALESCE(SUM(CASE WHEN l.account_code='1140' THEN l.debit-l.credit ELSE 0 END),0)<>v.vat_amount)
    OR (v.direction='sale' AND COALESCE(SUM(CASE WHEN l.account_code='2210' THEN l.credit-l.debit ELSE 0 END),0)<>v.vat_amount)
);

SELECT 'WITHHOLDING_ACCRUAL_MISMATCH' AS check_name,COUNT(*) AS count
FROM (
  SELECT w.id
  FROM accounting_withholding_records w
  LEFT JOIN accounting_journals j ON j.id=w.accrual_journal_id
  LEFT JOIN accounting_journal_lines l ON l.journal_id=j.id
  WHERE w.filing_status IN ('filed','paid') AND (w.income_tax+w.local_income_tax+w.other_deduction)>0
  GROUP BY w.id,w.income_tax,w.local_income_tax,w.other_deduction,w.accrual_journal_id,j.status
  HAVING w.accrual_journal_id IS NULL OR j.status<>'posted'
    OR COALESCE(SUM(CASE WHEN l.account_code='2220' THEN l.credit-l.debit ELSE 0 END),0)<>w.income_tax
    OR COALESCE(SUM(CASE WHEN l.account_code='2230' THEN l.credit-l.debit ELSE 0 END),0)<>w.local_income_tax
    OR COALESCE(SUM(CASE WHEN l.account_code='2240' THEN l.credit-l.debit ELSE 0 END),0)<>w.other_deduction
);

SELECT 'WITHHOLDING_PAYMENT_MISMATCH' AS check_name,COUNT(*) AS count
FROM (
  SELECT w.id
  FROM accounting_withholding_records w
  LEFT JOIN accounting_journals j ON j.id=w.payment_journal_id
  LEFT JOIN accounting_journal_lines l ON l.journal_id=j.id
  WHERE w.filing_status='paid' AND (w.income_tax+w.local_income_tax)>0
  GROUP BY w.id,w.income_tax,w.local_income_tax,w.payment_journal_id,j.status
  HAVING w.payment_journal_id IS NULL OR j.status<>'posted'
    OR COALESCE(SUM(CASE WHEN l.account_code='2220' THEN l.debit-l.credit ELSE 0 END),0)<>w.income_tax
    OR COALESCE(SUM(CASE WHEN l.account_code='2230' THEN l.debit-l.credit ELSE 0 END),0)<>w.local_income_tax
);

SELECT 'READY_EXPORT_WITH_VALIDATION_ERRORS' AS check_name,COUNT(*) AS count
FROM accounting_tax_export_batches WHERE status='ready' AND validation_error_count>0;

SELECT 'FAILED_EXPORT_CLEANUP_PENDING' AS check_name,COUNT(*) AS count
FROM accounting_tax_export_batches WHERE status='failed' AND cleanup_at IS NULL;

SELECT 'ATTACHMENT_RETENTION_MISSING' AS check_name,COUNT(*) AS count
FROM accounting_attachments WHERE deleted_at IS NULL AND retention_until IS NULL;

SELECT 'ATTACHMENT_INTEGRITY_OPEN' AS check_name,COUNT(*) AS count
FROM accounting_attachment_integrity_issues WHERE status='open';

SELECT 'JOURNAL_SNAPSHOT_FENCE_MISSING' AS check_name,COUNT(*) AS count
FROM accounting_journals WHERE updated_at IS NULL OR updated_at='';

SELECT 'LEGACY_1130_REFERENCES' AS check_name,
       (SELECT COUNT(*) FROM accounting_journal_lines WHERE account_code='1130')
       + (SELECT COUNT(*) FROM accounting_cards WHERE settlement_account_code='1130')
       + (SELECT COUNT(*) FROM accounting_resolutions WHERE settlement_account_code='1130')
       + (SELECT COUNT(*) FROM accounting_bank_accounts WHERE settlement_account_code='1130')
       + (SELECT COUNT(*) FROM accounting_donations WHERE settlement_account_code='1130')
       + (SELECT COUNT(*) FROM accounting_assets WHERE asset_account_code='1130')
       + (SELECT COUNT(*) FROM accounting_contracts WHERE account_code='1130')
       + (SELECT COUNT(*) FROM accounting_card_transactions WHERE account_code='1130') AS count;

-- v71 정관·재무회계규정 대응 점검
SELECT 'REVENUE_BUSINESS_APPROVAL_MISSING' AS check_name,COUNT(*) AS count
FROM accounting_revenue_businesses
WHERE status IN ('approved','active','stopped')
  AND approval_level IN ('board','general_meeting')
  AND COALESCE(decision_no,'')='';

SELECT 'PROCUREMENT_QUALIFICATION_INCOMPLETE' AS check_name,COUNT(*) AS count
FROM accounting_procurement_reviews
WHERE status IN ('approved','contracted','completed')
  AND (business_registration_ok=0 OR bidding_registration_ok=0 OR qualification_ok=0
    OR competition_ok=0 OR sanction_clear=0 OR charter_scope_ok=0);

SELECT 'PROCUREMENT_DECISION_MISSING' AS check_name,COUNT(*) AS count
FROM accounting_procurement_reviews
WHERE status IN ('approved','contracted','completed')
  AND approval_level IN ('board','general_meeting')
  AND COALESCE(decision_no,'')='';

SELECT 'PROCUREMENT_REVENUE_BUSINESS_LINK_MISSING' AS check_name,COUNT(*) AS count
FROM accounting_procurement_reviews p
LEFT JOIN accounting_revenue_businesses r ON r.id=p.revenue_business_id
WHERE p.status IN ('approved','contracted','completed')
  AND (r.id IS NULL OR r.business_type NOT IN ('procurement','preferential_purchase') OR r.status NOT IN ('approved','active'));

SELECT 'PROCUREMENT_CONTRACT_BOOK_MISMATCH' AS check_name,COUNT(*) AS count
FROM accounting_procurement_reviews p
LEFT JOIN accounting_contracts c ON c.id=p.contract_id
WHERE p.status IN ('contracted','completed')
  AND (c.id IS NULL OR c.book_type_code<>'revenue');

SELECT 'PROCUREMENT_GUARANTEE_EXPIRING' AS check_name,COUNT(*) AS count
FROM accounting_procurement_guarantees
WHERE recovered=0 AND COALESCE(end_date,'')<>'' AND end_date<=date('now','+45 days');

SELECT 'PURPOSE_RESERVE_NEGATIVE_BALANCE' AS check_name,COUNT(*) AS count
FROM (
  SELECT r.id,r.set_amount-COALESCE(SUM(CASE WHEN t.transaction_type='use' THEN t.amount ELSE -t.amount END),0) AS balance
  FROM accounting_purpose_reserves r
  LEFT JOIN accounting_purpose_reserve_transactions t ON t.reserve_id=r.id
  GROUP BY r.id,r.set_amount
  HAVING balance<0
);

SELECT 'PURPOSE_RESERVE_OVER_REVERSAL' AS check_name,COUNT(*) AS count
FROM (
  SELECT reserve_id,SUM(CASE WHEN transaction_type='use' THEN amount ELSE -amount END) AS net_used
  FROM accounting_purpose_reserve_transactions GROUP BY reserve_id HAVING net_used<0
);

SELECT 'CARD_TAX_ARITHMETIC_INVALID' AS check_name,COUNT(*) AS count
FROM accounting_card_transactions
WHERE amount<=0 OR supply_amount IS NULL OR supply_amount<0 OR tax_amount<0
  OR supply_amount+tax_amount<>amount OR tax_amount>amount
  OR tax_type NOT IN ('taxable','zero_rated','exempt','non_taxable','unclassified')
  OR tax_mode NOT IN ('vat_included','supply_plus_tax','manual','none','legacy')
  OR (tax_type NOT IN ('taxable','unclassified') AND tax_amount<>0);

SELECT 'CARD_TAX_UNCLASSIFIED_REVIEW' AS check_name,COUNT(*) AS count
FROM accounting_card_transactions WHERE tax_type='unclassified' OR tax_mode='legacy';

SELECT 'DONATION_RECEIPT_NO_DUPLICATE' AS check_name,COUNT(*) AS count
FROM (
  SELECT receipt_no FROM accounting_donations
  WHERE receipt_no IS NOT NULL AND receipt_no<>''
  GROUP BY receipt_no HAVING COUNT(*)>1
);

SELECT 'SOURCE_POSTING_STALE' AS check_name,
  (SELECT COUNT(*) FROM accounting_donations
    WHERE status='posting' AND journal_id IS NULL AND updated_at<datetime('now','-15 minutes'))
  + (SELECT COUNT(*) FROM accounting_card_transactions
    WHERE status='processing' AND journal_id IS NULL AND updated_at<datetime('now','-15 minutes')) AS count;

SELECT 'ASSET_STATE_INVALID' AS check_name,COUNT(*) AS count
FROM accounting_assets
WHERE acquisition_cost<0 OR residual_value<0 OR residual_value>acquisition_cost
  OR depreciation_method NOT IN ('straight_line','declining_balance','none')
  OR status='disposed' AND (disposal_date IS NULL OR disposal_date<acquisition_date OR COALESCE(disposal_amount,0)<0);

SELECT 'CONTRACT_PAYMENT_TOTAL_EXCEEDED' AS check_name,COUNT(*) AS count
FROM (
  SELECT c.id,c.contract_amount,COALESCE(SUM(p.amount),0) AS scheduled_amount
  FROM accounting_contracts c LEFT JOIN accounting_contract_payments p ON p.contract_id=c.id
  GROUP BY c.id,c.contract_amount HAVING scheduled_amount>c.contract_amount
);

SELECT 'FINANCE_INCIDENT_OPEN' AS check_name,COUNT(*) AS count
FROM accounting_finance_incidents WHERE status='open';

SELECT 'VEHICLE_SUCCESSION_CONTROL_MISSING' AS check_name,COUNT(*) AS count
FROM accounting_vehicle_records
WHERE COALESCE(succession_candidate,'')<>''
  AND (succession_counterparty_consent=0 OR succession_no_loss=0 OR succession_price<=0
    OR COALESCE(succession_price_basis,'')='' OR COALESCE(succession_decision_no,'')='');

SELECT 'PROCUREMENT_NEXT_BOARD_REPORT_PENDING' AS check_name,COUNT(*) AS count
FROM accounting_procurement_reviews
WHERE status IN ('contracted','completed') AND approval_level='chairman' AND next_board_reported=0;


-- 현행 규정대응 참조 무결성
SELECT 'PROCUREMENT_GUARANTEE_ORPHAN' AS check_name,COUNT(*) AS count
FROM accounting_procurement_guarantees g
LEFT JOIN accounting_procurement_reviews p ON p.id=g.procurement_review_id
WHERE p.id IS NULL;

SELECT 'PURPOSE_RESERVE_TRANSACTION_ORPHAN' AS check_name,COUNT(*) AS count
FROM accounting_purpose_reserve_transactions t
LEFT JOIN accounting_purpose_reserves r ON r.id=t.reserve_id
WHERE r.id IS NULL;

SELECT 'VEHICLE_LOG_ORPHAN' AS check_name,COUNT(*) AS count
FROM accounting_vehicle_logs l
LEFT JOIN accounting_vehicle_records v ON v.id=l.vehicle_id
WHERE v.id IS NULL;

-- 오픈 전 성능 인덱스 적용 확인
SELECT 'PERF_INDEX_IMPORT_MATCH' AS check_name,
  CASE WHEN EXISTS(SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_import_tx_match_target') THEN 'OK' ELSE 'MISSING' END AS result;

SELECT 'PERF_INDEX_DONATION_AUTO_MATCH' AS check_name,
  CASE WHEN EXISTS(SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_donations_auto_match') THEN 'OK' ELSE 'MISSING' END AS result;

SELECT 'PERF_INDEX_RESOLUTION_AUTO_MATCH' AS check_name,
  CASE WHEN EXISTS(SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_resolutions_auto_match') THEN 'OK' ELSE 'MISSING' END AS result;

SELECT 'PERF_INDEX_CARD_AUTO_MATCH' AS check_name,
  CASE WHEN EXISTS(SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_card_transactions_auto_match') THEN 'OK' ELSE 'MISSING' END AS result;

SELECT 'IMPORT_MATCH_TARGET_DUPLICATE' AS check_name,COUNT(*) AS count FROM (SELECT matched_type,matched_id FROM accounting_import_transactions WHERE status='matched' AND COALESCE(matched_type,'')<>'' AND COALESCE(matched_id,'')<>'' GROUP BY matched_type,matched_id HAVING COUNT(*)>1);
SELECT 'RECONCILIATION_INTEGRITY_TRIGGERS' AS check_name,CASE WHEN (SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name IN ('trg_import_match_target_unique_insert','trg_import_match_target_unique_update'))=2 THEN 'OK' ELSE 'MISSING' END AS result;
