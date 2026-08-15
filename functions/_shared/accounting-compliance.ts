import { clean } from './helpers';
import { nextSpecialSequence } from './accounting-special';

export const COMPLIANCE_SCHEMA_VERSION = '2026-08-15.4';

const REQUIRED_COMPLIANCE_TABLES = [
  'accounting_revenue_businesses',
  'accounting_procurement_reviews',
  'accounting_procurement_guarantees',
  'accounting_purpose_reserves',
  'accounting_purpose_reserve_transactions',
  'accounting_compliance_checks',
  'accounting_finance_incidents',
  'accounting_vehicle_records',
  'accounting_vehicle_logs',
];

const schemaReady = new WeakSet<object>();
const schemaPromises = new WeakMap<object, Promise<void>>();

export const ensureAccountingComplianceTables = async (db: D1Database) => {
  const key = db as unknown as object;
  if (schemaReady.has(key)) return;
  let pending = schemaPromises.get(key);
  if (!pending) {
    pending = (async () => {
      const placeholders = REQUIRED_COMPLIANCE_TABLES.map(() => '?').join(',');
      const row = await db.prepare(`SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name IN (${placeholders})`)
        .bind(...REQUIRED_COMPLIANCE_TABLES).first<{ count: number }>();
      if (Number(row?.count || 0) !== REQUIRED_COMPLIANCE_TABLES.length) {
        throw new Error('규정·공공조달 회계 DB 스키마가 준비되지 않았습니다. v71 마이그레이션을 먼저 적용해 주세요.');
      }
      schemaReady.add(key);
    })().catch((error) => { schemaPromises.delete(key); throw error; });
    schemaPromises.set(key, pending);
  }
  await pending;
};

export const validComplianceDate = (value: string) => {
  if (!value) return true;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCFullYear() === Number(match[1]) && date.getUTCMonth() === Number(match[2]) - 1 && date.getUTCDate() === Number(match[3]);
};

export type ComplianceNumberType = 'revenue-business' | 'procurement' | 'guarantee' | 'reserve' | 'check' | 'incident' | 'vehicle';
export const nextComplianceNumber = async (db: D1Database, type: ComplianceNumberType, year?: number) => {
  const y = year || new Date(Date.now() + 9 * 60 * 60 * 1000).getUTCFullYear();
  const meta = {
    'revenue-business': ['수익사업', `compliance-revenue:${y}`, 4],
    procurement: ['입찰검토', `compliance-procurement:${y}`, 4],
    guarantee: ['보증', `compliance-guarantee:${y}`, 4],
    reserve: ['고유목적준비금', `compliance-reserve:${y}`, 4],
    check: ['회계점검', `compliance-check:${y}`, 4],
    incident: ['즉시보고', `compliance-incident:${y}`, 4],
    vehicle: ['업무차량', `compliance-vehicle:${y}`, 4],
  } as const;
  const [prefix, key, digits] = meta[type];
  const seq = await nextSpecialSequence(db, key);
  return `${prefix}-${y}-${String(seq).padStart(digits, '0')}`;
};

export const getPriorYearIncome = async (db: D1Database, year: number) => {
  const row = await db.prepare(`SELECT COALESCE(SUM(CASE WHEN a.normal_side='credit' THEN m.credit_total-m.debit_total ELSE m.debit_total-m.credit_total END),0) AS amount
    FROM accounting_monthly_summary m JOIN accounting_accounts a ON a.code=m.account_code
    WHERE m.fiscal_year=? AND a.account_type='revenue'`).bind(year - 1).first<{ amount: number }>();
  return Math.max(0, Math.round(Number(row?.amount || 0)));
};

export const getProcurementAnnualContractTotal = async (db: D1Database, year: number, excludeId = '') => {
  const row = await db.prepare(`SELECT COALESCE(SUM(actual_contract_amount),0) AS amount FROM accounting_procurement_reviews
    WHERE fiscal_year=? AND status IN ('contracted','completed') AND id<>?`).bind(year, excludeId).first<{ amount: number }>();
  return Math.max(0, Math.round(Number(row?.amount || 0)));
};

export const getProcurementApproval = async (db: D1Database, raw: Record<string, unknown>, year: number, excludeId = '') => {
  const estimatedPrice = Math.max(0, Math.round(Number(raw.estimatedPrice || 0)));
  const plannedBidAmount = Math.max(0, Math.round(Number(raw.plannedBidAmount || 0)));
  const actualContractAmount = Math.max(0, Math.round(Number(raw.actualContractAmount || 0)));
  const basicPropertyCollateral = raw.basicPropertyCollateral === true;
  const borrowingOrGuarantee = raw.borrowingOrGuarantee === true;
  const materialFinancialRisk = raw.materialFinancialRisk === true;
  const contractStart = clean(raw.contractStart, 10);
  const contractEnd = clean(raw.contractEnd, 10);
  const priorOverride = Math.max(0, Math.round(Number(raw.priorYearIncomeOverride || 0)));
  const priorYearIncome = priorOverride || await getPriorYearIncome(db, year);
  const existingAnnualTotal = await getProcurementAnnualContractTotal(db, year, excludeId);
  const candidateAmount = actualContractAmount || plannedBidAmount;
  const annualAfter = existingAnnualTotal + candidateAmount;
  const annualLimit = Math.floor(priorYearIncome * 0.5);
  const reasons: string[] = [];

  if (estimatedPrice >= 50_000_000) reasons.push('1건 추정가격 5천만원 이상');
  if (contractStart && contractEnd) {
    const startMs = Date.parse(`${contractStart}T00:00:00Z`);
    const endMs = Date.parse(`${contractEnd}T00:00:00Z`);
    const contractDays = Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.floor((endMs - startMs) / 86400000) : 0;
    if (contractDays > 365) reasons.push('계약기간이 1회계연도 초과');
  }
  if (borrowingOrGuarantee) reasons.push('차입·보증 수반');
  if (materialFinancialRisk) reasons.push('계약 불이행 시 중대한 재정영향 우려');
  if (annualAfter > annualLimit && candidateAmount > 0) reasons.push('연간 공공조달 계약총액이 직전연도 총수입 50% 초과');
  if (basicPropertyCollateral) reasons.push('기본재산 담보제공 관련');

  const approvalLevel = basicPropertyCollateral ? 'general_meeting' : reasons.length ? 'board' : 'chairman';
  return { approvalLevel, reasons, priorYearIncome, annualLimit, existingAnnualTotal, annualAfter, candidateAmount };
};

const periodBounds = (year: number, periodType: string, periodKey: string) => {
  if (periodType === 'quarter') {
    const q = Math.min(4, Math.max(1, Number(periodKey.replace(/[^1-4]/g, '') || 1)));
    const startMonth = (q - 1) * 3 + 1;
    const endMonth = startMonth + 2;
    return {
      start: `${year}-${String(startMonth).padStart(2, '0')}-01`,
      end: `${year}-${String(endMonth).padStart(2, '0')}-31`,
      months: [startMonth, startMonth + 1, endMonth],
    };
  }
  const month = Math.min(12, Math.max(1, Number(periodKey.replace(/[^0-9]/g, '') || 1)));
  return {
    start: `${year}-${String(month).padStart(2, '0')}-01`,
    end: `${year}-${String(month).padStart(2, '0')}-31`,
    months: [month],
  };
};

export const buildComplianceSnapshot = async (db: D1Database, year: number, periodType: string, periodKey: string) => {
  const bounds = periodBounds(year, periodType, periodKey);
  const monthPlaceholders = bounds.months.map(() => '?').join(',');
  const [unmatched, missingEvidence, budgetOver, pendingBudget, openIncidents, integrityIssues, procurementRisk, accountBalance, periodTotals, donationIncome, revenueTaxRisk] = await db.batch([
    db.prepare(`SELECT COUNT(*) AS count FROM accounting_import_transactions WHERE transaction_date BETWEEN ? AND ? AND status IN ('unmatched','suggested')`).bind(bounds.start, bounds.end),
    db.prepare(`SELECT COUNT(*) AS count FROM accounting_resolutions r WHERE r.fiscal_year=? AND r.resolution_date BETWEEN ? AND ? AND r.status IN ('approved','posted') AND NOT EXISTS (SELECT 1 FROM accounting_attachments a WHERE a.reference_type='resolution' AND a.reference_id=r.id AND a.status='active')`).bind(year, bounds.start, bounds.end),
    db.prepare(`SELECT COUNT(*) AS count FROM accounting_budget_plans b WHERE b.fiscal_year=? AND (b.original_amount+b.supplementary_amount+b.transfer_in-b.transfer_out) < COALESCE((SELECT SUM(CASE WHEN r.resolution_type='expense' AND r.status IN ('approved','posted') THEN r.amount ELSE 0 END) FROM accounting_resolutions r WHERE r.fiscal_year=b.fiscal_year AND r.department=b.department AND r.project=b.project AND r.account_code=b.account_code),0)`).bind(year),
    db.prepare(`SELECT COUNT(*) AS count FROM accounting_budget_change_requests WHERE fiscal_year=? AND status='pending'`).bind(year),
    db.prepare(`SELECT COUNT(*) AS count FROM accounting_finance_incidents WHERE fiscal_year=? AND status='open'`).bind(year),
    db.prepare(`SELECT COUNT(*) AS count FROM accounting_attachment_integrity_issues WHERE status='open'`).bind(),
    db.prepare(`SELECT COUNT(*) AS count FROM accounting_procurement_reviews p LEFT JOIN accounting_contracts c ON c.id=p.contract_id WHERE p.fiscal_year=? AND (p.status IN ('approved','contracted') AND (p.business_registration_ok=0 OR p.bidding_registration_ok=0 OR p.qualification_ok=0 OR p.competition_ok=0 OR p.sanction_clear=0 OR p.charter_scope_ok=0) OR p.status='contracted' AND p.approval_level IN ('board','general_meeting') AND COALESCE(p.decision_no,'')='' OR p.contract_id IS NOT NULL AND COALESCE(c.book_type_code,'')<>'revenue' OR p.status IN ('contracted','completed') AND p.approval_level='chairman' AND p.next_board_reported=0)`).bind(year),
    db.prepare(`SELECT COALESCE(SUM(CASE WHEN a.account_type='asset' THEN m.debit_total-m.credit_total WHEN a.account_type='liability' THEN -(m.credit_total-m.debit_total) ELSE 0 END),0) AS amount FROM accounting_monthly_summary m JOIN accounting_accounts a ON a.code=m.account_code WHERE m.fiscal_year=? AND m.period_month IN (${monthPlaceholders}) AND a.code IN ('1100','1120')`).bind(year, ...bounds.months),
    db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN a.account_type='revenue' THEN CASE WHEN a.normal_side='credit' THEN m.credit_total-m.debit_total ELSE m.debit_total-m.credit_total END ELSE 0 END),0) AS income,
      COALESCE(SUM(CASE WHEN a.account_type='expense' THEN CASE WHEN a.normal_side='debit' THEN m.debit_total-m.credit_total ELSE m.credit_total-m.debit_total END ELSE 0 END),0) AS expense
      FROM accounting_monthly_summary m JOIN accounting_accounts a ON a.code=m.account_code
      WHERE m.fiscal_year=? AND m.period_month IN (${monthPlaceholders})`).bind(year, ...bounds.months),
    db.prepare(`SELECT COALESCE(SUM(amount),0) AS amount FROM accounting_donations WHERE fiscal_year=? AND donation_date BETWEEN ? AND ? AND status<>'cancelled'`).bind(year,bounds.start,bounds.end),
    db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM accounting_revenue_businesses WHERE fiscal_year=? AND status IN ('approved','active'))
      AND NOT EXISTS(SELECT 1 FROM accounting_tax_profiles WHERE fiscal_year=? AND entity_id='ENTITY-HQ' AND profile_status='confirmed' AND revenue_business_enabled=1)
      THEN 1 ELSE 0 END AS count`).bind(year,year),
  ]);
  const count = (result: D1Result<unknown>) => Number((result.results?.[0] as any)?.count || 0);
  const balance = Number((accountBalance.results?.[0] as any)?.amount || 0);
  const periodIncome = Number((periodTotals.results?.[0] as any)?.income || 0);
  const periodExpense = Number((periodTotals.results?.[0] as any)?.expense || 0);
  const donationAmount = Number((donationIncome.results?.[0] as any)?.amount || 0);
  return {
    periodType,
    periodKey,
    startDate: bounds.start,
    endDate: bounds.end,
    accountBalance: balance,
    periodIncome,
    periodExpense,
    donationIncome: donationAmount,
    revenueBusinessTaxProfileRisk: count(revenueTaxRisk),
    unmatchedTransactions: count(unmatched),
    missingEvidence: count(missingEvidence),
    overBudgetItems: count(budgetOver),
    pendingBudgetChanges: count(pendingBudget),
    openIncidents: count(openIncidents),
    attachmentIntegrityIssues: count(integrityIssues),
    procurementRisks: count(procurementRisk),
  };
};
