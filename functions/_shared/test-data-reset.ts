import type { SessionUser } from './helpers';
import { ACCOUNTING_R2_PREFIX, ACCOUNTING_R2_PREFIXES, MAIN_R2_PREFIXES, TAX_EXPORT_R2_PREFIX, assertR2KeysWithinPrefixes } from './r2-scope-guard';

export const TEST_RESET_CONFIRMATION = '테스트자료 전체삭제';
const MAX_RESET_OBJECTS = 5000;
const R2_DELETE_CHUNK = 500;

type CountRow = { count?: number };
type ResetEnv = {
  DB: D1Database;
  ACCOUNTING_DB: D1Database;
  FILES?: R2Bucket;
  ACCOUNTING_FILES?: R2Bucket;
};

const countFrom = async (db: D1Database, sql: string, ...bindings: unknown[]) => {
  const row = await db.prepare(sql).bind(...bindings).first<CountRow>();
  return Number(row?.count || 0);
};

const listBucketKeys = async (bucket: R2Bucket, prefix = '') => {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    for (const object of page.objects || []) {
      if (object?.key) keys.push(object.key);
      if (keys.length > MAX_RESET_OBJECTS) {
        throw new Error(`R2 삭제 대상이 ${MAX_RESET_OBJECTS.toLocaleString('ko-KR')}건을 초과합니다. 일괄 초기화 대신 별도 정리 작업이 필요합니다.`);
      }
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys;
};

const unique = (values: string[]) => Array.from(new Set(values.filter(Boolean)));

const collectMainFileKeys = async (env: ResetEnv) => {
  const metadataRows = await env.DB.prepare(`
    SELECT r2_key AS object_key FROM document_attachments
    WHERE storage_type='r2' AND r2_key IS NOT NULL AND r2_key<>''
    UNION ALL
    SELECT r2_key AS object_key FROM received_attachments
    WHERE storage_type='r2' AND r2_key IS NOT NULL AND r2_key<>''
    UNION ALL
    SELECT r2_key AS object_key FROM management_register_attachments
    WHERE storage_type='r2' AND r2_key IS NOT NULL AND r2_key<>''
  `).all<{ object_key: string }>();
  const metadataKeys = (metadataRows.results || []).map((row) => String(row.object_key || ''));
  if (!env.FILES) return { metadataKeys: unique(metadataKeys), bucketKeys: [] as string[] };
  const [documentKeys, registryKeys, registerKeys] = await Promise.all([
    listBucketKeys(env.FILES, 'documents/'),
    listBucketKeys(env.FILES, 'registry/'),
    listBucketKeys(env.FILES, 'registers/'),
  ]);
  return { metadataKeys: unique(metadataKeys), bucketKeys: unique([...documentKeys, ...registryKeys, ...registerKeys]) };
};

const collectAccountingFileKeys = async (env: ResetEnv) => {
  const metadataRows = await env.ACCOUNTING_DB.prepare(`
    SELECT object_key FROM accounting_attachments WHERE object_key IS NOT NULL AND object_key<>''
    UNION ALL
    SELECT object_key FROM accounting_tax_export_files WHERE object_key IS NOT NULL AND object_key<>''
    UNION ALL
    SELECT package_object_key AS object_key FROM accounting_tax_export_batches
    WHERE package_object_key IS NOT NULL AND package_object_key<>''
  `).all<{ object_key: string }>();
  const metadataKeys = (metadataRows.results || []).map((row) => String(row.object_key || ''));
  const bucketKeys = env.ACCOUNTING_FILES ? (await Promise.all([
    listBucketKeys(env.ACCOUNTING_FILES, ACCOUNTING_R2_PREFIX),
    listBucketKeys(env.ACCOUNTING_FILES, TAX_EXPORT_R2_PREFIX),
  ])).flat() : [];
  return { metadataKeys: unique(metadataKeys), bucketKeys: unique(bucketKeys) };
};

const deleteBucketKeys = async (
  bucket: R2Bucket | undefined,
  keys: string[],
  label: string,
  allowedPrefixes: readonly string[],
) => {
  if (!keys.length) return 0;
  if (!bucket) throw new Error(`${label} R2 저장소가 연결되지 않아 파일을 삭제할 수 없습니다.`);
  const safeKeys = assertR2KeysWithinPrefixes(keys, allowedPrefixes, `${label} 테스트자료 초기화`);
  for (let index = 0; index < safeKeys.length; index += R2_DELETE_CHUNK) {
    await bucket.delete(safeKeys.slice(index, index + R2_DELETE_CHUNK));
  }
  return safeKeys.length;
};

export const getTestResetPreview = async (env: ResetEnv) => {
  const [mainCounts, accountingCounts, mainFiles, accountingFiles] = await Promise.all([
    env.DB.prepare(`
      SELECT
        (SELECT COUNT(*) FROM documents) AS documents,
        (SELECT COUNT(*) FROM received_documents) AS received_documents,
        (SELECT COUNT(*) FROM document_attachments) AS document_attachments,
        (SELECT COUNT(*) FROM received_attachments) AS received_attachments,
        (SELECT COUNT(*) FROM management_registers) AS management_registers,
        (SELECT COUNT(*) FROM management_register_attachments) AS management_register_attachments,
        (SELECT COUNT(*) FROM employment_certificates) AS employment_certificates,
        (SELECT COUNT(*) FROM ordination_certificates) AS ordination_certificates,
        (SELECT COUNT(*) FROM employee_profiles) AS employee_profiles,
        (SELECT COUNT(*) FROM management_audit_logs) AS management_audit_logs,
        (SELECT COUNT(*) FROM accounting_outbox) AS accounting_outbox,
        (SELECT COUNT(*) FROM document_approval_lines) AS document_approval_lines,
        (SELECT COUNT(*) FROM document_approvals) AS document_approvals,
        (SELECT COUNT(*) FROM document_dispatch_links) AS document_dispatch_links,
        (SELECT COUNT(*) FROM document_sequences) AS document_sequences,
        (SELECT COUNT(*) FROM admin_rate_limits) AS admin_rate_limits,
        (SELECT COUNT(*) FROM system_meta WHERE meta_key='last_test_data_reset' OR meta_key LIKE 'test_%') AS reset_meta
    `).first<Record<string, number>>(),
    env.ACCOUNTING_DB.prepare(`
      SELECT
        (SELECT COUNT(*) FROM accounting_resolutions) AS resolutions,
        (SELECT COUNT(*) FROM accounting_journals) AS journals,
        (SELECT COUNT(*) FROM accounting_donations) AS donations,
        (SELECT COUNT(*) FROM accounting_donors) AS donors,
        (SELECT COUNT(*) FROM accounting_assets) AS assets,
        (SELECT COUNT(*) FROM accounting_cards) AS cards,
        (SELECT COUNT(*) FROM accounting_card_transactions) AS card_transactions,
        (SELECT COUNT(*) FROM accounting_import_transactions) AS import_transactions,
        (SELECT COUNT(*) FROM accounting_import_batches) AS import_batches,
        (SELECT COUNT(*) FROM accounting_reconciliation_periods) AS reconciliations,
        (SELECT COUNT(*) FROM accounting_matching_rules) AS matching_rules,
        (SELECT COUNT(*) FROM accounting_budget_change_requests) AS budget_changes,
        (SELECT COUNT(*) FROM accounting_budget_versions) AS budget_versions,
        (SELECT COUNT(*) FROM accounting_vendors) AS vendors,
        (SELECT COUNT(*) FROM accounting_vendor_bank_changes) AS vendor_bank_changes,
        (SELECT COUNT(*) FROM accounting_contracts) AS contracts,
        (SELECT COUNT(*) FROM accounting_contract_payments) AS contract_payments,
        (SELECT COUNT(*) FROM accounting_bank_accounts) AS bank_accounts,
        (SELECT COUNT(*) FROM accounting_donation_export_batches) AS donation_export_batches,
        (SELECT COUNT(*) FROM accounting_donation_export_items) AS donation_export_items,
        (SELECT COUNT(*) FROM accounting_branch_reports) AS branch_reports,
        (SELECT COUNT(*) FROM accounting_entity_certificates) AS certificates,
        (SELECT COUNT(*) FROM accounting_attachments) AS attachments,
        (SELECT COUNT(*) FROM accounting_card_payments) AS card_payments,
        (SELECT COUNT(*) FROM accounting_tax_profiles) AS tax_profiles,
        (SELECT COUNT(*) FROM accounting_tax_profile_revisions) AS tax_profile_revisions,
        (SELECT COUNT(*) FROM accounting_vat_records) AS vat_records,
        (SELECT COUNT(*) FROM accounting_tax_payees) AS tax_payees,
        (SELECT COUNT(*) FROM accounting_withholding_records) AS withholding_records,
        (SELECT COUNT(*) FROM accounting_tax_export_batches) AS tax_export_batches,
        (SELECT COUNT(*) FROM accounting_tax_export_files) AS tax_export_files,
        (SELECT COUNT(*) FROM accounting_tax_export_events) AS tax_export_events,
        (SELECT COUNT(*) FROM accounting_revenue_businesses) AS revenue_businesses,
        (SELECT COUNT(*) FROM accounting_procurement_reviews) AS procurement_reviews,
        (SELECT COUNT(*) FROM accounting_procurement_guarantees) AS procurement_guarantees,
        (SELECT COUNT(*) FROM accounting_purpose_reserves) AS purpose_reserves,
        (SELECT COUNT(*) FROM accounting_purpose_reserve_transactions) AS purpose_reserve_transactions,
        (SELECT COUNT(*) FROM accounting_compliance_checks) AS compliance_checks,
        (SELECT COUNT(*) FROM accounting_finance_incidents) AS finance_incidents,
        (SELECT COUNT(*) FROM accounting_vehicle_records) AS vehicle_records,
        (SELECT COUNT(*) FROM accounting_vehicle_logs) AS vehicle_logs,
        (SELECT COUNT(*) FROM accounting_v63_migration_review) AS migration_reviews,
        (SELECT COUNT(*) FROM accounting_entities WHERE id<>'ENTITY-HQ') AS custom_entities,
        (SELECT COUNT(*) FROM accounting_funds WHERE system_fund=0) AS custom_funds,
        (SELECT COUNT(*) FROM accounting_book_types WHERE system_type=0) AS custom_book_types,
        (SELECT COUNT(*) FROM accounting_accounts WHERE system_account=0) AS custom_accounts,
        (SELECT COUNT(*) FROM accounting_audit_logs) AS audit_logs,
        (SELECT COUNT(*) FROM accounting_attachment_operations) AS attachment_operations,
        (SELECT COUNT(*) FROM accounting_attachment_integrity_issues) AS integrity_issues,
        (SELECT COUNT(*) FROM accounting_sequences) AS sequences,
        (SELECT COUNT(*) FROM accounting_special_sequences) AS special_sequences,
        (SELECT COUNT(*) FROM accounting_meta WHERE meta_key='last_test_data_reset' OR meta_key LIKE 'test_%') AS reset_meta,
        (SELECT COUNT(*) FROM accounting_resolution_dimensions) AS resolution_dimensions,
        (SELECT COUNT(*) FROM accounting_journal_lines) AS journal_lines,
        (SELECT COUNT(*) FROM accounting_journal_line_dimensions) AS journal_line_dimensions,
        (SELECT COUNT(*) FROM accounting_budgets) AS budgets,
        (SELECT COUNT(*) FROM accounting_budget_plans) AS budget_plans,
        (SELECT COUNT(*) FROM accounting_closings) AS closings,
        (SELECT COUNT(*) FROM accounting_monthly_summary) AS monthly_summary
    `).first<Record<string, number>>(),
    collectMainFileKeys(env),
    collectAccountingFileKeys(env),
  ]);

  const main = mainCounts || {};
  const accounting = accountingCounts || {};
  const n = (value: unknown) => Number(value || 0);

  return {
    generatedAt: new Date().toISOString(),
    main: {
      documents: n(main.documents),
      receivedDocuments: n(main.received_documents),
      attachments: n(main.document_attachments) + n(main.received_attachments),
      registers: n(main.management_registers),
      registerAttachments: n(main.management_register_attachments),
      employmentCertificates: n(main.employment_certificates),
      ordinationCertificates: n(main.ordination_certificates),
      employeeProfiles: n(main.employee_profiles),
      r2Objects: unique([...mainFiles.metadataKeys, ...mainFiles.bucketKeys]).length,
    },
    accounting: {
      resolutions: n(accounting.resolutions),
      journals: n(accounting.journals),
      donations: n(accounting.donations),
      donors: n(accounting.donors),
      assets: n(accounting.assets),
      cards: n(accounting.cards),
      cardTransactions: n(accounting.card_transactions),
      bankAccounts: n(accounting.bank_accounts),
      importBatches: n(accounting.import_batches),
      importTransactions: n(accounting.import_transactions),
      matchingRules: n(accounting.matching_rules),
      reconciliations: n(accounting.reconciliations),
      budgetChanges: n(accounting.budget_changes),
      budgetVersions: n(accounting.budget_versions),
      vendors: n(accounting.vendors),
      vendorBankChanges: n(accounting.vendor_bank_changes),
      contracts: n(accounting.contracts),
      contractPayments: n(accounting.contract_payments),
      donationExportBatches: n(accounting.donation_export_batches),
      donationExportItems: n(accounting.donation_export_items),
      branchReports: n(accounting.branch_reports),
      certificates: n(accounting.certificates),
      attachments: n(accounting.attachments),
      cardPayments: n(accounting.card_payments),
      taxProfiles: n(accounting.tax_profiles),
      vatRecords: n(accounting.vat_records),
      taxPayees: n(accounting.tax_payees),
      withholdingRecords: n(accounting.withholding_records),
      taxExportBatches: n(accounting.tax_export_batches),
      revenueBusinesses: n(accounting.revenue_businesses),
      procurementReviews: n(accounting.procurement_reviews),
      procurementGuarantees: n(accounting.procurement_guarantees),
      purposeReserves: n(accounting.purpose_reserves),
      purposeReserveTransactions: n(accounting.purpose_reserve_transactions),
      complianceChecks: n(accounting.compliance_checks),
      financeIncidents: n(accounting.finance_incidents),
      vehicleRecords: n(accounting.vehicle_records),
      vehicleLogs: n(accounting.vehicle_logs),
      customEntities: n(accounting.custom_entities),
      customFunds: n(accounting.custom_funds),
      customBookTypes: n(accounting.custom_book_types),
      customAccounts: n(accounting.custom_accounts),
      r2Objects: unique([...accountingFiles.metadataKeys, ...accountingFiles.bucketKeys]).length,
    },
    traces: {
      documentWorkflow: n(main.document_approval_lines) + n(main.document_approvals) + n(main.document_dispatch_links),
      integrationQueue: n(main.accounting_outbox),
      accountingDetails: n(accounting.resolution_dimensions) + n(accounting.journal_lines) + n(accounting.journal_line_dimensions)
        + n(accounting.budgets) + n(accounting.budget_plans) + n(accounting.closings) + n(accounting.monthly_summary),
      accountingAuditLogs: n(accounting.audit_logs),
      attachmentHistory: n(accounting.attachment_operations) + n(accounting.integrity_issues),
      taxExportDetails: n(accounting.tax_export_files) + n(accounting.tax_export_events),
      taxProfileRevisions: n(accounting.tax_profile_revisions),
      migrationReviewRecords: n(accounting.migration_reviews),
      accessRateHistory: n(main.admin_rate_limits),
      sequenceRecords: n(main.document_sequences) + n(accounting.sequences) + n(accounting.special_sequences),
      resetMetaRecords: n(main.reset_meta) + n(accounting.reset_meta),
      managementAuditLogs: n(main.management_audit_logs),
    },
    preserved: [
      '사용자·권한·로그인 세션',
      '전자문서 기본 서식과 종단 설정',
      '회계연도·기본 계정과목·종단 본부',
      '기본 회계구분·기본 재원·첨부 운영정책·스키마 버전',
    ],
  };
};

const countPreviewRemainders = (preview: Awaited<ReturnType<typeof getTestResetPreview>>) => {
  const groups = [preview.main, preview.accounting, preview.traces];
  return groups.reduce((total, group) => total + Object.values(group).reduce((subtotal, value) => subtotal + Number(value || 0), 0), 0);
};

export const resetAllTestData = async (env: ResetEnv, user: SessionUser) => {
  const [mainFiles, accountingFiles] = await Promise.all([
    collectMainFileKeys(env),
    collectAccountingFileKeys(env),
  ]);
  const mainR2Keys = unique([...mainFiles.metadataKeys, ...mainFiles.bucketKeys]);
  const accountingR2Keys = unique([...accountingFiles.metadataKeys, ...accountingFiles.bucketKeys]);

  if (mainR2Keys.length && !env.FILES) throw new Error('전자문서 R2 저장소(FILES)가 연결되지 않아 초기화를 중단했습니다.');
  if (accountingR2Keys.length && !env.ACCOUNTING_FILES) throw new Error('회계 R2 저장소(ACCOUNTING_FILES)가 연결되지 않아 초기화를 중단했습니다.');

  const deletedMainR2 = await deleteBucketKeys(env.FILES, mainR2Keys, '전자문서', MAIN_R2_PREFIXES);
  const deletedAccountingR2 = await deleteBucketKeys(
    env.ACCOUNTING_FILES, accountingR2Keys, '회계', ACCOUNTING_R2_PREFIXES,
  );
  const now = new Date().toISOString();

  await env.DB.batch([
    env.DB.prepare('DELETE FROM document_approval_lines'),
    env.DB.prepare('DELETE FROM document_approvals'),
    env.DB.prepare('DELETE FROM document_dispatch_links'),
    env.DB.prepare('DELETE FROM document_attachments'),
    env.DB.prepare('DELETE FROM received_attachments'),
    env.DB.prepare('DELETE FROM management_register_attachments'),
    env.DB.prepare('DELETE FROM management_registers'),
    env.DB.prepare('DELETE FROM employment_certificates'),
    env.DB.prepare('DELETE FROM ordination_certificates'),
    env.DB.prepare('DELETE FROM employee_profiles'),
    env.DB.prepare('DELETE FROM management_audit_logs'),
    env.DB.prepare('DELETE FROM received_documents'),
    env.DB.prepare('DELETE FROM documents'),
    env.DB.prepare('DELETE FROM accounting_outbox'),
    env.DB.prepare('DELETE FROM document_sequences'),
    env.DB.prepare('DELETE FROM admin_rate_limits'),
    env.DB.prepare("DELETE FROM system_meta WHERE meta_key='last_test_data_reset' OR meta_key LIKE 'test_%'"),
  ]);

  await env.ACCOUNTING_DB.prepare(`INSERT INTO accounting_meta(meta_key,meta_value,updated_at)
    VALUES ('test_reset_in_progress','1',?)
    ON CONFLICT(meta_key) DO UPDATE SET meta_value='1',updated_at=excluded.updated_at`).bind(now).run();
  try {
    await env.ACCOUNTING_DB.batch([
      env.ACCOUNTING_DB.prepare('DELETE FROM accounting_vehicle_logs'),
      env.ACCOUNTING_DB.prepare('DELETE FROM accounting_procurement_guarantees'),
      env.ACCOUNTING_DB.prepare('DELETE FROM accounting_purpose_reserve_transactions'),
      env.ACCOUNTING_DB.prepare('DELETE FROM accounting_compliance_checks'),
      env.ACCOUNTING_DB.prepare('DELETE FROM accounting_finance_incidents'),
      env.ACCOUNTING_DB.prepare('DELETE FROM accounting_vehicle_records'),
      env.ACCOUNTING_DB.prepare('DELETE FROM accounting_procurement_reviews'),
      env.ACCOUNTING_DB.prepare('DELETE FROM accounting_purpose_reserves'),
      env.ACCOUNTING_DB.prepare('DELETE FROM accounting_revenue_businesses'),
      env.ACCOUNTING_DB.prepare('DELETE FROM accounting_tax_export_events'),
      env.ACCOUNTING_DB.prepare('DELETE FROM accounting_tax_export_files'),
    env.ACCOUNTING_DB.prepare('DELETE FROM accounting_tax_export_batches'),
    env.ACCOUNTING_DB.prepare('DELETE FROM accounting_tax_profile_revisions'),
    env.ACCOUNTING_DB.prepare('DELETE FROM accounting_vat_records'),
    env.ACCOUNTING_DB.prepare('DELETE FROM accounting_withholding_records'),
    env.ACCOUNTING_DB.prepare('DELETE FROM accounting_tax_payees'),
    env.ACCOUNTING_DB.prepare('DELETE FROM accounting_tax_profiles'),
    env.ACCOUNTING_DB.prepare('DELETE FROM accounting_card_payments'),
    env.ACCOUNTING_DB.prepare('DELETE FROM accounting_v63_migration_review'),
    env.ACCOUNTING_DB.prepare('DELETE FROM accounting_attachment_operations'),
    env.ACCOUNTING_DB.prepare('DELETE FROM accounting_attachment_integrity_issues'),
    env.ACCOUNTING_DB.prepare('DELETE FROM accounting_attachments'),
    env.ACCOUNTING_DB.prepare('DELETE FROM accounting_donation_export_items'),
    env.ACCOUNTING_DB.prepare('DELETE FROM accounting_donation_export_batches'),
    env.ACCOUNTING_DB.prepare('DELETE FROM accounting_import_transactions'),
    env.ACCOUNTING_DB.prepare('DELETE FROM accounting_import_batches'),
    env.ACCOUNTING_DB.prepare('DELETE FROM accounting_reconciliation_periods'),
    env.ACCOUNTING_DB.prepare('DELETE FROM accounting_matching_rules'),
    env.ACCOUNTING_DB.prepare('DELETE FROM accounting_budget_versions'),
    env.ACCOUNTING_DB.prepare('DELETE FROM accounting_budget_change_requests'),
    env.ACCOUNTING_DB.prepare('DELETE FROM accounting_contract_payments'),
    env.ACCOUNTING_DB.prepare('DELETE FROM accounting_contracts'),
    env.ACCOUNTING_DB.prepare('DELETE FROM accounting_vendor_bank_changes'),
    env.ACCOUNTING_DB.prepare('DELETE FROM accounting_vendors'),
    env.ACCOUNTING_DB.prepare('DELETE FROM accounting_bank_accounts'),
    env.ACCOUNTING_DB.prepare('DELETE FROM accounting_entity_certificates'),
    env.ACCOUNTING_DB.prepare('DELETE FROM accounting_journal_line_dimensions'),
    env.ACCOUNTING_DB.prepare('DELETE FROM accounting_journal_lines'),
    env.ACCOUNTING_DB.prepare('DELETE FROM accounting_journals'),
    env.ACCOUNTING_DB.prepare('DELETE FROM accounting_resolution_dimensions'),
    env.ACCOUNTING_DB.prepare('DELETE FROM accounting_resolutions'),
    env.ACCOUNTING_DB.prepare('DELETE FROM accounting_card_transactions'),
    env.ACCOUNTING_DB.prepare('DELETE FROM accounting_cards'),
    env.ACCOUNTING_DB.prepare('DELETE FROM accounting_assets'),
    env.ACCOUNTING_DB.prepare('DELETE FROM accounting_donations'),
    env.ACCOUNTING_DB.prepare('DELETE FROM accounting_donors'),
    env.ACCOUNTING_DB.prepare('DELETE FROM accounting_branch_reports'),
    env.ACCOUNTING_DB.prepare('DELETE FROM accounting_budget_plans'),
    env.ACCOUNTING_DB.prepare('DELETE FROM accounting_budgets'),
    env.ACCOUNTING_DB.prepare('DELETE FROM accounting_closings'),
    env.ACCOUNTING_DB.prepare('DELETE FROM accounting_monthly_summary'),
    env.ACCOUNTING_DB.prepare('DELETE FROM accounting_audit_logs'),
    env.ACCOUNTING_DB.prepare('DELETE FROM accounting_sequences'),
    env.ACCOUNTING_DB.prepare('DELETE FROM accounting_special_sequences'),
    env.ACCOUNTING_DB.prepare('DELETE FROM accounting_accounts WHERE system_account=0'),
    env.ACCOUNTING_DB.prepare('DELETE FROM accounting_funds WHERE system_fund=0'),
    env.ACCOUNTING_DB.prepare("DELETE FROM accounting_entities WHERE id<>'ENTITY-HQ'"),
    env.ACCOUNTING_DB.prepare('DELETE FROM accounting_book_types WHERE system_type=0'),
      env.ACCOUNTING_DB.prepare("DELETE FROM accounting_meta WHERE meta_key='last_test_data_reset' OR meta_key LIKE 'test_%'"),
    ]);
  } catch (error) {
    await env.ACCOUNTING_DB.prepare(`DELETE FROM accounting_meta WHERE meta_key='test_reset_in_progress'`).run().catch(() => undefined);
    throw error;
  }

  const verification = await getTestResetPreview(env);
  const remainingRecords = countPreviewRemainders(verification);
  const verified = remainingRecords === 0;

  return {
    resetAt: now,
    resetBy: user.name,
    deletedMainR2,
    deletedAccountingR2,
    verified,
    remainingRecords,
    verification,
    message: verified
      ? '전자문서·재직증명서·수계증서와 회계·예산·결산, 자금·거래관리, 기부·자산·기관회계, 계약·조달·준법, 세무·신고 테스트자료 및 관련 로그·감사이력·번호 카운트·R2 파일을 모두 초기화하고 잔여 0건을 확인했습니다.'
      : `초기화는 실행했으나 삭제 대상 ${remainingRecords.toLocaleString('ko-KR')}건이 남아 있습니다. 미리보기를 다시 실행해 잔여 항목을 확인해 주세요.`,
  };
};
