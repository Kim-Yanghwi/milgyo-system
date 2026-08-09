import { authenticateSession, clean, ensureTables, json, randomHex } from '../../_shared/helpers';
import { ensureAccountingTables, hasAccountingAccess, isAccountingManager, parseMoney } from '../../_shared/accounting';
import { validateDimensions } from '../../_shared/accounting-special';
import {
  calculateVatFromSupply,
  calculateVatFromTotal,
  defaultWithholdingDueDate,
  ensureAccountingTaxTables,
  nextTaxNumber,
  normalizeMaskedIdentifier,
  normalizeTaxBusinessNo,
  taxAudit,
  validTaxDate,
  validTaxYear,
  vatFilingPeriod,
} from '../../_shared/accounting-tax';
import {
  assertLinkedTaxJournalsReversed,
  fileWithholdingRecord,
  payWithholdingTaxes,
  postVatAdjustmentJournal,
} from '../../_shared/accounting-tax-journal';

interface Env { DB: D1Database; ACCOUNTING_DB: D1Database; }
type Payload = Record<string, unknown> & { token?: string; action?: string };

const enumValue = (value: unknown, allowed: readonly string[], fallback = '') => {
  const text = clean(value, 40) || fallback;
  return allowed.includes(text) ? text : '';
};

type VatSource = {
  source_date: string;
  direction: string;
  amount: number;
  book_type_code: string;
  entity_id: string;
  fund_id: string;
};

const loadVatSource = async (db: D1Database, sourceType: string, sourceId: string): Promise<VatSource | null> => {
  if (sourceType === 'manual') return null;
  if (!sourceId) return null;
  const queries: Record<string, string> = {
    resolution: `SELECT r.resolution_date AS source_date,
      CASE WHEN r.resolution_type='income' THEN 'sale' ELSE 'purchase' END AS direction,r.amount,
      COALESCE(NULLIF(d.book_type_code,''),'general') AS book_type_code,
      COALESCE(NULLIF(d.entity_id,''),'ENTITY-HQ') AS entity_id,COALESCE(d.fund_id,'') AS fund_id
      FROM accounting_resolutions r LEFT JOIN accounting_resolution_dimensions d ON d.resolution_id=r.id WHERE r.id=?`,
    card_transaction: `SELECT transaction_date AS source_date,'purchase' AS direction,amount,
      COALESCE(NULLIF(book_type_code,''),'general') AS book_type_code,
      COALESCE(NULLIF(entity_id,''),'ENTITY-HQ') AS entity_id,COALESCE(fund_id,'') AS fund_id
      FROM accounting_card_transactions WHERE id=?`,
    import_transaction: `SELECT t.transaction_date AS source_date,
      CASE WHEN t.direction='in' THEN 'sale' ELSE 'purchase' END AS direction,t.amount,
      COALESCE(NULLIF(ba.book_type_code,''),NULLIF(c.book_type_code,''),'general') AS book_type_code,
      COALESCE(NULLIF(ba.entity_id,''),NULLIF(c.entity_id,''),'ENTITY-HQ') AS entity_id,
      COALESCE(ba.fund_id,'') AS fund_id
      FROM accounting_import_transactions t JOIN accounting_import_batches ib ON ib.id=t.batch_id
      LEFT JOIN accounting_bank_accounts ba ON t.source_type='bank' AND ba.id=ib.source_account_id
      LEFT JOIN accounting_cards c ON t.source_type='card' AND c.id=ib.source_account_id WHERE t.id=?`,
    donation: `SELECT donation_date AS source_date,'sale' AS direction,amount,
      COALESCE(NULLIF(book_type_code,''),'general') AS book_type_code,
      COALESCE(NULLIF(entity_id,''),'ENTITY-HQ') AS entity_id,COALESCE(fund_id,'') AS fund_id
      FROM accounting_donations WHERE id=?`,
    journal: `SELECT j.journal_date AS source_date,'' AS direction,COALESCE(SUM(l.debit),0) AS amount,
      COALESCE(MAX(NULLIF(d.book_type_code,'')),'general') AS book_type_code,
      COALESCE(MAX(NULLIF(d.entity_id,'')),'ENTITY-HQ') AS entity_id,COALESCE(MAX(d.fund_id),'') AS fund_id
      FROM accounting_journals j JOIN accounting_journal_lines l ON l.journal_id=j.id
      LEFT JOIN accounting_journal_line_dimensions d ON d.journal_line_id=l.id
      WHERE j.id=? AND j.status IN ('posted','reversed') GROUP BY j.id
      HAVING COUNT(DISTINCT COALESCE(NULLIF(d.book_type_code,''),'general'))=1
        AND COUNT(DISTINCT COALESCE(NULLIF(d.entity_id,''),'ENTITY-HQ'))=1
        AND COUNT(DISTINCT COALESCE(d.fund_id,''))=1`,
  };
  const sql = queries[sourceType];
  return sql ? await db.prepare(sql).bind(sourceId).first<VatSource>() : null;
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB || !env.ACCOUNTING_DB) return json({ ok: false, message: '전자문서 DB 또는 회계 전용 DB가 연결되지 않았습니다.' }, 500);
  let payload: Payload;
  try { payload = await request.json(); } catch { return json({ ok: false, message: '요청 형식이 올바르지 않습니다.' }, 400); }
  await ensureTables(env.DB);
  const auth = await authenticateSession(env.DB, clean(payload.token, 200));
  if (!auth.ok) return json({ ok: false, message: auth.message }, auth.status);
  if (!hasAccountingAccess(auth.user)) return json({ ok: false, message: '세무·신고자료 접속 권한이 없습니다.' }, 403);
  if (!isAccountingManager(auth.user) || auth.user.role === 'audit') return json({ ok: false, message: '세무자료 등록·수정은 회계담당자 또는 관리자만 할 수 있습니다.' }, 403);
  try {
    await ensureAccountingTables(env.ACCOUNTING_DB);
    await ensureAccountingTaxTables(env.ACCOUNTING_DB);
    const db = env.ACCOUNTING_DB, me = auth.user, action = clean(payload.action, 60), now = new Date().toISOString();

    if (action === 'save-profile') {
      const year = validTaxYear(payload.year);
      const entityId = clean(payload.entityId, 80) || 'ENTITY-HQ';
      const legalName = clean(payload.legalName, 160);
      const organizationType = enumValue(payload.organizationType,
        ['religious_organization', 'nonprofit_corporation', 'public_interest_corporation', 'other']);
      const qualifiedStatus = enumValue(payload.qualifiedDonationStatus,
        ['not_confirmed', 'qualified', 'not_qualified', 'expired'], 'not_confirmed');
      const vatBusinessType = enumValue(payload.vatBusinessType,
        ['not_confirmed', 'exempt', 'general', 'simplified', 'mixed', 'not_applicable']);
      const vatCycle = enumValue(payload.vatReportingCycle,
        ['not_confirmed', 'quarterly', 'semiannual', 'annual', 'not_applicable']);
      const religiousMethod = enumValue(payload.religiousIncomeMethod,
        ['not_set', 'religious_income', 'earned_income', 'mixed', 'not_applicable'], 'not_set');
      const confirmed = payload.confirm === true;
      const registrationNo = clean(payload.registrationNo, 30);
      if (!year || !legalName || !organizationType || !vatBusinessType || !vatCycle || !religiousMethod) {
        return json({ ok: false, message: '회계연도·법인명·단체 유형·부가가치세·원천징수 기준을 정확히 입력해 주세요.' }, 400);
      }
      const entity = await db.prepare(`SELECT id FROM accounting_entities WHERE id=? AND active=1`).bind(entityId).first();
      if (!entity) return json({ ok: false, message: '회계조직을 확인해 주세요.' }, 400);
      const qualifiedFrom = clean(payload.qualifiedFrom, 10), qualifiedTo = clean(payload.qualifiedTo, 10);
      if ((qualifiedFrom && !validTaxDate(qualifiedFrom)) || (qualifiedTo && !validTaxDate(qualifiedTo))) return json({ ok: false, message: '기부금단체 자격 적용기간을 확인해 주세요.' }, 400);
      if (qualifiedFrom && qualifiedTo && qualifiedFrom > qualifiedTo) return json({ ok: false, message: '기부금단체 자격 종료일은 시작일보다 빠를 수 없습니다.' }, 400);
      if (confirmed && (!registrationNo || qualifiedStatus === 'not_confirmed' || vatBusinessType === 'not_confirmed'
        || vatCycle === 'not_confirmed' || religiousMethod === 'not_set')) {
        return json({ ok: false, message: '세무기본정보를 확정하려면 등록번호, 기부금단체 자격, 부가가치세 유형·신고주기와 종교인소득 처리기준을 모두 명시해 주세요.' }, 400);
      }
      if (vatBusinessType === 'not_applicable' && vatCycle !== 'not_applicable') {
        return json({ ok: false, message: '부가가치세 유형이 해당 없음이면 신고주기도 해당 없음으로 선택해 주세요.' }, 400);
      }
      if (['general', 'simplified', 'mixed'].includes(vatBusinessType) && vatCycle === 'not_applicable') {
        return json({ ok: false, message: '과세·겸영 유형은 신고자료 분류 주기를 선택해 주세요.' }, 400);
      }
      const existing = await db.prepare(`SELECT id,profile_status,revision_no FROM accounting_tax_profiles WHERE fiscal_year=? AND entity_id=?`)
        .bind(year, entityId).first<{ id: string; profile_status: string; revision_no: number }>();
      const id = existing?.id || `TAXP-${randomHex(20)}`;
      const revisionReason = clean(payload.revisionReason, 500);
      if (existing?.profile_status === 'confirmed' && !confirmed) {
        return json({ ok: false, message: '확정된 세무기본정보는 임시저장 상태로 되돌릴 수 없습니다. 변경 사유를 적고 새 확정 개정본으로 저장해 주세요.' }, 409);
      }
      if (existing?.profile_status === 'confirmed' && !revisionReason) {
        return json({ ok: false, message: '확정된 세무기본정보를 변경하려면 변경 사유를 입력해 주세요. 기존 확정본은 개정이력으로 보존됩니다.' }, 409);
      }
      const revisionNo = existing?.profile_status === 'confirmed'
        ? Number(existing.revision_no || 1) + 1
        : Number(existing?.revision_no || 1);
      await db.batch([
        db.prepare(`INSERT INTO accounting_tax_profiles
          (id,fiscal_year,entity_id,legal_name,organization_type,registration_no,corporate_registration_no,tax_office_name,
           public_interest_status,qualified_donation_status,qualified_from,qualified_to,revenue_business_enabled,
           vat_business_type,vat_reporting_cycle,withholding_enabled,religious_income_method,electronic_donation_required,
           tax_agent_name,tax_agent_contact,tax_agent_email,profile_status,memo,confirmed_by,confirmed_at,
           created_by,created_at,updated_by,updated_at,revision_no,change_reason)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(fiscal_year,entity_id) DO UPDATE SET legal_name=excluded.legal_name,
          organization_type=excluded.organization_type,registration_no=excluded.registration_no,
          corporate_registration_no=excluded.corporate_registration_no,tax_office_name=excluded.tax_office_name,
          public_interest_status=excluded.public_interest_status,qualified_donation_status=excluded.qualified_donation_status,
          qualified_from=excluded.qualified_from,qualified_to=excluded.qualified_to,revenue_business_enabled=excluded.revenue_business_enabled,
          vat_business_type=excluded.vat_business_type,vat_reporting_cycle=excluded.vat_reporting_cycle,
          withholding_enabled=excluded.withholding_enabled,religious_income_method=excluded.religious_income_method,
          electronic_donation_required=excluded.electronic_donation_required,tax_agent_name=excluded.tax_agent_name,
          tax_agent_contact=excluded.tax_agent_contact,tax_agent_email=excluded.tax_agent_email,
          profile_status=excluded.profile_status,memo=excluded.memo,confirmed_by=excluded.confirmed_by,
          confirmed_at=excluded.confirmed_at,updated_by=excluded.updated_by,updated_at=excluded.updated_at,
          revision_no=excluded.revision_no,change_reason=excluded.change_reason`)
          .bind(id, year, entityId, legalName, organizationType, registrationNo || null,
            clean(payload.corporateRegistrationNo, 30) || null, clean(payload.taxOfficeName, 80) || null,
            payload.publicInterestStatus === true ? 1 : 0, qualifiedStatus, qualifiedFrom || null, qualifiedTo || null,
            payload.revenueBusinessEnabled === true ? 1 : 0, vatBusinessType, vatCycle,
            payload.withholdingEnabled === true ? 1 : 0, religiousMethod,
            payload.electronicDonationRequired === true ? 1 : 0, clean(payload.taxAgentName, 80) || null,
            clean(payload.taxAgentContact, 80) || null, clean(payload.taxAgentEmail, 120) || null,
            confirmed ? 'confirmed' : 'draft', clean(payload.memo, 1500) || null,
            confirmed ? me.name : null, confirmed ? now : null, me.name, now, me.name, now,
            revisionNo, revisionReason || null),
        taxAudit(db, existing?.profile_status === 'confirmed' ? 'revise' : confirmed ? 'confirm' : 'save', 'tax-profile', id, me,
          { year, entityId, organizationType, vatBusinessType, qualifiedStatus, revisionNo, revisionReason }, now),
      ]);
      return json({ ok: true, id, status: confirmed ? 'confirmed' : 'draft', revisionNo,
        message: existing?.profile_status === 'confirmed'
          ? `세무기본정보 ${revisionNo}차 개정본을 ${confirmed ? '확정' : '임시저장'}했습니다. 기존 확정본은 개정이력에 보존했습니다.`
          : confirmed ? '세무기본정보를 확정했습니다.' : '세무기본정보를 임시저장했습니다.' });
    }

    if (action === 'save-payee') {
      const id = clean(payload.id, 80) || `PAYEE-${randomHex(20)}`;
      const payeeType = enumValue(payload.payeeType, ['employee', 'religious_worker', 'lecturer', 'freelancer', 'vendor', 'other']);
      const residentStatus = enumValue(payload.residentStatus, ['resident', 'nonresident', 'corporation', 'not_applicable'], 'resident');
      const name = clean(payload.name, 120);
      let identifierMasked = '';
      try { identifierMasked = normalizeMaskedIdentifier(payload.identifierMasked); }
      catch (error) { return json({ ok: false, message: error instanceof Error ? error.message : '식별번호 마스킹 형식을 확인해 주세요.' }, 400); }
      const businessNo = normalizeTaxBusinessNo(payload.businessNo);
      if (!name || !payeeType || !residentStatus) return json({ ok: false, message: '지급대상자 유형·성명·거주구분을 확인해 주세요.' }, 400);
      if (clean(payload.businessNo, 30) && businessNo.length !== 10) return json({ ok: false, message: '사업자등록번호는 숫자 10자리로 입력해 주세요.' }, 400);
      const existing = await db.prepare(`SELECT payee_no,created_by,created_at FROM accounting_tax_payees WHERE id=?`).bind(id).first<any>();
      const payeeNo = existing?.payee_no || await nextTaxNumber(db, 'payee', validTaxYear(payload.year) || Number(now.slice(0, 4)));
      await db.batch([
        db.prepare(`INSERT INTO accounting_tax_payees
          (id,payee_no,payee_type,name,identifier_masked,business_no,contact,resident_status,active,memo,created_by,created_at,updated_by,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET payee_type=excluded.payee_type,name=excluded.name,
          identifier_masked=excluded.identifier_masked,business_no=excluded.business_no,contact=excluded.contact,
          resident_status=excluded.resident_status,active=excluded.active,memo=excluded.memo,
          updated_by=excluded.updated_by,updated_at=excluded.updated_at`)
          .bind(id, payeeNo, payeeType, name, identifierMasked || null, businessNo || null,
            clean(payload.contact, 120) || null, residentStatus, payload.active === false ? 0 : 1,
            clean(payload.memo, 1000) || null, existing?.created_by || me.name, existing?.created_at || now, me.name, now),
        taxAudit(db, 'save', 'tax-payee', id, me, { payeeNo, payeeType, residentStatus }, now),
      ]);
      return json({ ok: true, id, payeeNo, message: '원천징수 지급대상자를 저장했습니다.' });
    }

    if (action === 'save-vat-record') {
      const id = clean(payload.id, 80) || `VAT-${randomHex(20)}`;
      const date = clean(payload.transactionDate, 10), year = validTaxYear(date.slice(0, 4));
      const selectedYear = validTaxYear(payload.year);
      const direction = enumValue(payload.direction, ['purchase', 'sale']);
      const sourceType = enumValue(payload.sourceType, ['manual', 'resolution', 'card_transaction', 'import_transaction', 'donation', 'journal'], 'manual');
      const sourceId = sourceType === 'manual' ? '' : clean(payload.sourceId, 100);
      const evidenceType = enumValue(payload.evidenceType, ['tax_invoice', 'invoice', 'card', 'cash_receipt', 'receipt', 'other', 'none'], 'other');
      const taxType = enumValue(payload.taxType, ['taxable', 'zero_rated', 'exempt', 'non_taxable'], 'taxable');
      let deductionStatus = enumValue(payload.deductionStatus, ['pending', 'deductible', 'non_deductible', 'not_applicable'], 'pending');
      if (direction === 'sale') deductionStatus = 'not_applicable';
      if (!validTaxDate(date) || !year || !direction || !sourceType || !evidenceType || !taxType || !deductionStatus) return json({ ok: false, message: '거래일·매입매출 구분·증빙·과세유형을 확인해 주세요.' }, 400);
      if (selectedYear && selectedYear !== year) return json({ ok: false, message: `현재 선택한 ${selectedYear} 회계연도 안의 거래일을 입력해 주세요.` }, 400);
      const source = sourceType === 'manual' ? null : await loadVatSource(db, sourceType, sourceId);
      if (sourceType !== 'manual' && !source) return json({ ok: false, message: '연결할 회계 원자료를 찾을 수 없거나 여러 회계조직·재원이 혼합된 전표입니다.' }, 400);
      let totalAmount = parseMoney(payload.totalAmount);
      let supplyAmount = parseMoney(payload.supplyAmount), vatAmount = parseMoney(payload.vatAmount);
      if (payload.autoCalculate === true) ({ supplyAmount, vatAmount, totalAmount } = calculateVatFromSupply(supplyAmount, taxType));
      else if (!supplyAmount && !vatAmount) ({ supplyAmount, vatAmount } = calculateVatFromTotal(totalAmount, taxType));
      if (totalAmount <= 0 || supplyAmount < 0 || vatAmount < 0 || totalAmount !== supplyAmount + vatAmount) return json({ ok: false, message: '합계금액은 공급가액과 부가가치세의 합계와 정확히 일치해야 합니다.' }, 400);
      if (taxType !== 'taxable' && vatAmount !== 0) return json({ ok: false, message: '영세율·면세·비과세 자료의 부가가치세는 0원이어야 합니다.' }, 400);
      const nonDeductibleReason = clean(payload.nonDeductibleReason, 500);
      if (direction === 'purchase' && deductionStatus === 'non_deductible' && !nonDeductibleReason) return json({ ok: false, message: '매입세액 불공제 사유를 입력해 주세요.' }, 400);
      const businessNo = normalizeTaxBusinessNo(payload.counterpartyBusinessNo);
      if (clean(payload.counterpartyBusinessNo, 30) && businessNo.length !== 10) return json({ ok: false, message: '거래처 사업자등록번호는 숫자 10자리로 입력해 주세요.' }, 400);
      const dimensions = await validateDimensions(db, payload);
      if (source) {
        if (source.source_date !== date || (source.direction && source.direction !== direction)
          || totalAmount > Math.abs(Number(source.amount || 0))
          || source.book_type_code !== dimensions.bookTypeCode || source.entity_id !== dimensions.entityId
          || source.fund_id !== dimensions.fundId) {
          return json({ ok: false, message: '연결 원자료의 일자·매입매출 구분·회계 차원이 같아야 하며, 분할금액은 원자료 금액을 초과할 수 없습니다.' }, 400);
        }
      }
      const profile = await db.prepare(`SELECT vat_reporting_cycle FROM accounting_tax_profiles WHERE fiscal_year=? AND entity_id=? ORDER BY updated_at DESC LIMIT 1`).bind(year, dimensions.entityId).first<any>();
      const reportingCycle = clean(profile?.vat_reporting_cycle, 20);
      const filingPeriod = clean(payload.filingPeriod, 20)
        || (['quarterly', 'semiannual', 'annual'].includes(reportingCycle) ? vatFilingPeriod(date, reportingCycle) : '');
      if (!filingPeriod) return json({ ok: false, message: '세무기본정보의 부가가치세 신고주기를 확정하거나 신고기간을 직접 입력해 주세요.' }, 400);
      if (!/^\d{4}-(?:Q[1-4]|H[12]|A)$/.test(filingPeriod)) return json({ ok: false, message: '신고기간 형식을 확인해 주세요. 예: 2026-Q1, 2026-H1, 2026-A' }, 400);
      if (!filingPeriod.startsWith(`${year}-`)) return json({ ok: false, message: '신고기간 연도는 거래일 연도와 같아야 합니다.' }, 400);
      const confirmed = payload.confirm === true;
      if (confirmed && direction === 'purchase' && deductionStatus === 'pending') {
        return json({ ok: false, message: '매입 부가가치세 자료를 확정하려면 매입세액 공제 여부를 먼저 결정해 주세요.' }, 400);
      }
      const existing = await db.prepare(`SELECT status,source_type,source_id,source_line_no,supersedes_id,version_no
        FROM accounting_vat_records WHERE id=?`).bind(id).first<any>();
      if (existing && existing.status !== 'draft') return json({ ok: false, message: '확정 또는 취소된 부가가치세 자료는 수정할 수 없습니다. 취소 후 정정본을 새로 등록해 주세요.' }, 409);
      const supersedesId = existing?.supersedes_id || clean(payload.supersedesId, 80);
      let sourceLineNo = Number(existing?.source_line_no || 0);
      let versionNo = Number(existing?.version_no || 1);
      if (!existing && supersedesId) {
        const prior = await db.prepare(`SELECT id,status,source_type,source_id,source_line_no,book_type_code,entity_id,fund_id,version_no
          FROM accounting_vat_records WHERE id=?`).bind(supersedesId).first<any>();
        if (!prior || prior.status !== 'cancelled') return json({ ok: false, message: '정정 대상은 취소 완료된 부가가치세 자료여야 합니다.' }, 400);
        if (prior.source_type !== sourceType || prior.source_id !== sourceId || prior.book_type_code !== dimensions.bookTypeCode
          || prior.entity_id !== dimensions.entityId || prior.fund_id !== dimensions.fundId) {
          return json({ ok: false, message: '정정본은 취소 원자료의 연결정보와 회계 차원을 그대로 이어야 합니다.' }, 400);
        }
        sourceLineNo = Number(prior.source_line_no || 1);
        versionNo = Number(prior.version_no || 1) + 1;
      }
      if (!sourceLineNo) {
        const nextLine = sourceId ? await db.prepare(`SELECT COALESCE(MAX(source_line_no),0)+1 AS line_no
          FROM accounting_vat_records WHERE source_type=? AND source_id=?`).bind(sourceType, sourceId).first<{ line_no: number }>() : null;
        sourceLineNo = Math.max(1, Number(nextLine?.line_no || 1));
      }
      if (source) {
        const allocated = await db.prepare(`SELECT COALESCE(SUM(total_amount),0) AS amount
          FROM accounting_vat_records
          WHERE source_type=? AND source_id=? AND status<>'cancelled' AND id<>?`)
          .bind(sourceType, sourceId, id).first<{ amount: number }>();
        const allocatedAmount = Number(allocated?.amount || 0);
        if (allocatedAmount + totalAmount > Math.abs(Number(source.amount || 0))) {
          return json({ ok: false, message: `원자료 금액을 초과해 분할할 수 없습니다. 이미 ${allocatedAmount.toLocaleString('ko-KR')}원이 연결되어 있습니다.` }, 409);
        }
      }
      await db.batch([
        db.prepare(`INSERT INTO accounting_vat_records
          (id,fiscal_year,transaction_date,direction,source_type,source_id,book_type_code,entity_id,fund_id,
           counterparty_name,counterparty_business_no,evidence_type,evidence_no,total_amount,supply_amount,vat_amount,
           tax_type,deduction_status,non_deductible_reason,filing_period,status,memo,confirmed_by,confirmed_at,
           created_by,created_at,updated_by,updated_at,source_line_no,supersedes_id,version_no)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET transaction_date=excluded.transaction_date,direction=excluded.direction,
          source_type=excluded.source_type,source_id=excluded.source_id,book_type_code=excluded.book_type_code,
          entity_id=excluded.entity_id,fund_id=excluded.fund_id,counterparty_name=excluded.counterparty_name,
          counterparty_business_no=excluded.counterparty_business_no,evidence_type=excluded.evidence_type,
          evidence_no=excluded.evidence_no,total_amount=excluded.total_amount,supply_amount=excluded.supply_amount,
          vat_amount=excluded.vat_amount,tax_type=excluded.tax_type,deduction_status=excluded.deduction_status,
          non_deductible_reason=excluded.non_deductible_reason,filing_period=excluded.filing_period,
          status=excluded.status,memo=excluded.memo,confirmed_by=excluded.confirmed_by,
          confirmed_at=excluded.confirmed_at,updated_by=excluded.updated_by,updated_at=excluded.updated_at,
          source_line_no=excluded.source_line_no`)
          .bind(id, year, date, direction, sourceType, sourceId, dimensions.bookTypeCode, dimensions.entityId, dimensions.fundId,
            clean(payload.counterpartyName, 160), businessNo || null, evidenceType, clean(payload.evidenceNo, 100) || null,
            totalAmount, supplyAmount, vatAmount, taxType, deductionStatus, nonDeductibleReason || null, filingPeriod,
            confirmed ? 'confirmed' : 'draft', clean(payload.memo, 1200) || null, confirmed ? me.name : null,
            confirmed ? now : null, me.name, now, me.name, now, sourceLineNo, supersedesId || null, versionNo),
        taxAudit(db, confirmed ? 'confirm' : 'save', 'vat-record', id, me,
          { year, date, direction, sourceType, sourceId, sourceLineNo, supersedesId, versionNo,
            totalAmount, supplyAmount, vatAmount, deductionStatus }, now),
      ]);
      return json({ ok: true, id, status: confirmed ? 'confirmed' : 'draft', sourceLineNo, versionNo,
        message: supersedesId ? '취소 자료를 잇는 부가가치세 정정본을 저장했습니다.' : confirmed ? '부가가치세 자료를 확정했습니다.' : '부가가치세 자료를 임시저장했습니다.' });
    }

    if (action === 'set-vat-status') {
      const id = clean(payload.id, 80), status = enumValue(payload.status, ['confirmed', 'cancelled']);
      const row = await db.prepare(`SELECT id,status,direction,deduction_status,adjustment_journal_id
        FROM accounting_vat_records WHERE id=?`).bind(id).first<any>();
      if (!row || !status) return json({ ok: false, message: '처리할 부가가치세 자료를 찾을 수 없습니다.' }, 404);
      if (row.status === 'cancelled') return json({ ok: false, message: '이미 취소된 부가가치세 자료입니다. 정정본을 새로 등록해 주세요.' }, 409);
      if (status === 'confirmed' && row.status !== 'draft') return json({ ok: false, message: '임시저장 자료만 확정할 수 있습니다.' }, 409);
      if (status === 'confirmed' && row.direction === 'purchase' && row.deduction_status === 'pending') {
        return json({ ok: false, message: '매입 부가가치세 자료를 확정하려면 수정 화면에서 매입세액 공제 여부를 먼저 결정해 주세요.' }, 400);
      }
      const cancellationReason = clean(payload.cancellationReason, 500);
      if (status === 'cancelled' && !cancellationReason) return json({ ok: false, message: '부가가치세 자료 취소 사유를 입력해 주세요.' }, 400);
      if (status === 'cancelled') await assertLinkedTaxJournalsReversed(db, [row.adjustment_journal_id]);
      await db.batch([
        db.prepare(`UPDATE accounting_vat_records SET status=?,
          confirmed_by=CASE WHEN ?='confirmed' THEN ? ELSE confirmed_by END,
          confirmed_at=CASE WHEN ?='confirmed' THEN ? ELSE confirmed_at END,
          cancellation_reason=CASE WHEN ?='cancelled' THEN ? ELSE cancellation_reason END,
          cancelled_by=CASE WHEN ?='cancelled' THEN ? ELSE cancelled_by END,
          cancelled_at=CASE WHEN ?='cancelled' THEN ? ELSE cancelled_at END,
          updated_by=?,updated_at=? WHERE id=?`)
          .bind(status, status, me.name, status, now, status, cancellationReason || null,
            status, me.name, status, now, me.name, now, id),
        taxAudit(db, status === 'confirmed' ? 'confirm' : 'cancel', 'vat-record', id, me, { cancellationReason }, now),
      ]);
      return json({ ok: true, message: status === 'confirmed' ? '부가가치세 자료를 확정했습니다.' : '부가가치세 자료를 취소 처리했습니다.' });
    }

    if (action === 'post-vat-adjustment') {
      const id = clean(payload.id, 80);
      if (!id) return json({ ok: false, message: '원장에 반영할 부가가치세 자료를 선택해 주세요.' }, 400);
      const posted = await postVatAdjustmentJournal(db, id, clean(payload.baseAccountCode, 20), me, now);
      return json({ ok: true, ...posted,
        message: posted.duplicate
          ? `이미 연결된 부가가치세 조정 전표 ${posted.journalNo || ''}를 확인했습니다.`
          : `부가가치세 조정 전표 ${posted.journalNo}를 생성해 총계정원장과 연결했습니다.` });
    }

    if (action === 'save-withholding-record') {
      const id = clean(payload.id, 80) || `WHT-${randomHex(20)}`;
      const date = clean(payload.paymentDate, 10), year = validTaxYear(date.slice(0, 4));
      const selectedYear = validTaxYear(payload.year);
      const payeeId = clean(payload.payeeId, 80), incomeType = enumValue(payload.incomeType,
        ['earned', 'religious', 'business', 'other', 'retirement', 'nonresident', 'other_income']);
      let religiousMethod = enumValue(payload.religiousIncomeMethod, ['not_applicable', 'religious_income', 'earned_income'], 'not_applicable');
      if (incomeType !== 'religious') religiousMethod = 'not_applicable';
      if (!validTaxDate(date) || !year || !payeeId || !incomeType || (incomeType === 'religious' && religiousMethod === 'not_applicable')) return json({ ok: false, message: '지급일·지급대상자·소득구분을 확인해 주세요.' }, 400);
      if (selectedYear && selectedYear !== year) return json({ ok: false, message: `현재 선택한 ${selectedYear} 회계연도 안의 지급일을 입력해 주세요.` }, 400);
      const payee = await db.prepare(`SELECT id,name FROM accounting_tax_payees WHERE id=? AND active=1`).bind(payeeId).first<any>();
      if (!payee) return json({ ok: false, message: '사용 가능한 지급대상자를 선택해 주세요.' }, 400);
      const gross = parseMoney(payload.grossAmount), taxExempt = parseMoney(payload.taxExemptAmount);
      const necessaryExpense = parseMoney(payload.necessaryExpense);
      const calculatedTaxable = Math.max(0, gross - taxExempt - necessaryExpense);
      const taxable = payload.taxableAmount === '' || payload.taxableAmount == null ? calculatedTaxable : parseMoney(payload.taxableAmount);
      const incomeTax = parseMoney(payload.incomeTax), localTax = parseMoney(payload.localIncomeTax);
      const otherDeduction = parseMoney(payload.otherDeduction);
      const net = gross - incomeTax - localTax - otherDeduction;
      if (gross <= 0 || taxExempt < 0 || necessaryExpense < 0 || taxable < 0 || incomeTax < 0 || localTax < 0 || otherDeduction < 0
        || taxExempt + necessaryExpense > gross || taxable > gross || net < 0) return json({ ok: false, message: '총지급액·비과세액·필요경비·세액·공제액을 0원 이상으로 확인해 주세요.' }, 400);
      if (payload.netAmount !== '' && payload.netAmount != null && parseMoney(payload.netAmount) !== net) return json({ ok: false, message: '실지급액은 총지급액에서 소득세·지방소득세·기타공제를 뺀 금액과 일치해야 합니다.' }, 400);
      const filingMonth = clean(payload.filingMonth, 7) || date.slice(0, 7);
      if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(filingMonth)) return json({ ok: false, message: '귀속·신고월을 YYYY-MM 형식으로 입력해 주세요.' }, 400);
      const filingDueDate = clean(payload.filingDueDate, 10) || defaultWithholdingDueDate(date);
      if (filingDueDate && !validTaxDate(filingDueDate)) return json({ ok: false, message: '신고·납부기한을 확인해 주세요.' }, 400);
      const dimensions = await validateDimensions(db, payload);
      const sourceResolutionId = clean(payload.sourceResolutionId, 80);
      const sourceVerificationNote = clean(payload.sourceVerificationNote, 500);
      if (sourceResolutionId) {
        const resolution = await db.prepare(`SELECT r.id,r.fiscal_year,r.resolution_type,r.resolution_date,r.counterparty,r.amount,r.status,r.journal_id,
          COALESCE(NULLIF(d.book_type_code,''),'general') AS book_type_code,
          COALESCE(NULLIF(d.entity_id,''),'ENTITY-HQ') AS entity_id,COALESCE(d.fund_id,'') AS fund_id
          FROM accounting_resolutions r LEFT JOIN accounting_resolution_dimensions d ON d.resolution_id=r.id WHERE r.id=?`)
          .bind(sourceResolutionId).first<any>();
        if (!resolution || resolution.resolution_type !== 'expense' || Number(resolution.fiscal_year) !== year
          || resolution.book_type_code !== dimensions.bookTypeCode || resolution.entity_id !== dimensions.entityId
          || resolution.fund_id !== dimensions.fundId) {
          return json({ ok: false, message: '연결할 지출결의서와 원천징수 내역의 회계연도·회계 차원이 일치해야 합니다.' }, 400);
        }
        const normalizedName = (value: unknown) => clean(value, 160).replace(/[\s·ㆍ.,()\-_]/g, '').toLowerCase();
        const nameMismatch = !!normalizedName(resolution.counterparty) && normalizedName(resolution.counterparty) !== normalizedName(payee.name);
        const dateMismatch = clean(resolution.resolution_date, 10) !== date;
        if ((nameMismatch || dateMismatch) && !sourceVerificationNote) {
          return json({ ok: false, message: '지출결의서의 지급대상자 또는 일자가 원천징수 입력값과 다릅니다. 정당한 차이라면 연결 확인 메모를 입력해 주세요.' }, 400);
        }
        const linked = await db.prepare(`SELECT COALESCE(SUM(gross_amount),0) AS amount
          FROM accounting_withholding_records
          WHERE source_resolution_id=? AND filing_status<>'cancelled' AND id<>?`)
          .bind(sourceResolutionId, id).first<{ amount: number }>();
        const alreadyLinked = Number(linked?.amount || 0);
        if (alreadyLinked + gross > Math.abs(Number(resolution.amount || 0))) {
          return json({ ok: false, message: `지출결의금액을 초과해 원천징수 내역을 연결할 수 없습니다. 이미 ${alreadyLinked.toLocaleString('ko-KR')}원이 연결되어 있습니다.` }, 409);
        }
      }
      const existing = await db.prepare(`SELECT payment_no,created_by,created_at,filing_status,filed_at,paid_at,
        supersedes_id,version_no FROM accounting_withholding_records WHERE id=?`).bind(id).first<any>();
      if (existing && existing.filing_status !== 'unfiled') return json({ ok: false, message: '신고·납부 또는 취소된 원천징수 내역은 수정할 수 없습니다. 취소 후 정정본을 새로 등록해 주세요.' }, 409);
      const supersedesId = existing?.supersedes_id || clean(payload.supersedesId, 80);
      let versionNo = Number(existing?.version_no || 1);
      if (!existing && supersedesId) {
        const prior = await db.prepare(`SELECT id,filing_status,source_resolution_id,book_type_code,entity_id,fund_id,version_no
          FROM accounting_withholding_records WHERE id=?`).bind(supersedesId).first<any>();
        if (!prior || prior.filing_status !== 'cancelled') return json({ ok: false, message: '정정 대상은 취소 완료된 원천징수 내역이어야 합니다.' }, 400);
        if (String(prior.source_resolution_id || '') !== sourceResolutionId || prior.book_type_code !== dimensions.bookTypeCode
          || prior.entity_id !== dimensions.entityId || prior.fund_id !== dimensions.fundId) {
          return json({ ok: false, message: '정정본은 취소 원자료의 지출결의 연결과 회계 차원을 그대로 이어야 합니다.' }, 400);
        }
        versionNo = Number(prior.version_no || 1) + 1;
      }
      const paymentNo = existing?.payment_no || await nextTaxNumber(db, 'withholding', year);
      const requestedStatus = 'unfiled';
      await db.batch([
        db.prepare(`INSERT INTO accounting_withholding_records
          (id,payment_no,fiscal_year,payment_date,payee_id,income_type,religious_income_method,source_resolution_id,
           book_type_code,entity_id,fund_id,gross_amount,tax_exempt_amount,necessary_expense,taxable_amount,
           income_tax,local_income_tax,other_deduction,net_amount,filing_month,filing_due_date,filing_status,
           filed_at,paid_at,memo,created_by,created_at,updated_by,updated_at,
           supersedes_id,source_verification_note,version_no)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET payment_date=excluded.payment_date,payee_id=excluded.payee_id,
          income_type=excluded.income_type,religious_income_method=excluded.religious_income_method,
          source_resolution_id=excluded.source_resolution_id,book_type_code=excluded.book_type_code,
          entity_id=excluded.entity_id,fund_id=excluded.fund_id,gross_amount=excluded.gross_amount,
          tax_exempt_amount=excluded.tax_exempt_amount,necessary_expense=excluded.necessary_expense,
          taxable_amount=excluded.taxable_amount,income_tax=excluded.income_tax,local_income_tax=excluded.local_income_tax,
          other_deduction=excluded.other_deduction,net_amount=excluded.net_amount,filing_month=excluded.filing_month,
          filing_due_date=excluded.filing_due_date,memo=excluded.memo,updated_by=excluded.updated_by,
          updated_at=excluded.updated_at,source_verification_note=excluded.source_verification_note`)
          .bind(id, paymentNo, year, date, payeeId, incomeType, religiousMethod, sourceResolutionId || null,
            dimensions.bookTypeCode, dimensions.entityId, dimensions.fundId, gross, taxExempt, necessaryExpense,
            taxable, incomeTax, localTax, otherDeduction, net, filingMonth, filingDueDate || null, requestedStatus,
            null, null, clean(payload.memo, 1200) || null,
            existing?.created_by || me.name, existing?.created_at || now, me.name, now,
            supersedesId || null, sourceVerificationNote || null, versionNo),
        taxAudit(db, 'save', 'withholding-record', id, me,
          { paymentNo, date, incomeType, gross, taxable, incomeTax, localTax, net, requestedStatus,
            supersedesId, versionNo, sourceResolutionId, sourceVerificationNote }, now),
      ]);
      return json({ ok: true, id, paymentNo, netAmount: net, versionNo,
        message: supersedesId ? '취소 내역을 잇는 원천징수 정정본을 저장했습니다.' : '원천징수 내역을 미신고 상태로 저장했습니다.' });
    }

    if (action === 'set-withholding-status') {
      const id = clean(payload.id, 80), status = enumValue(payload.status, ['unfiled', 'filed', 'paid', 'cancelled']);
      const row = await db.prepare(`SELECT id,filing_status,income_tax,local_income_tax,other_deduction,accrual_journal_id,payment_journal_id
        FROM accounting_withholding_records WHERE id=?`).bind(id).first<any>();
      if (!row || !status) return json({ ok: false, message: '처리할 원천징수 내역을 찾을 수 없습니다.' }, 404);
      if (row.filing_status === 'cancelled') return json({ ok: false, message: '이미 취소된 원천징수 내역입니다. 정정본을 새로 등록해 주세요.' }, 409);
      if (status === 'unfiled') return json({ ok: false, message: '신고완료 또는 납부완료 자료를 미신고로 되돌릴 수 없습니다. 잘못된 자료는 취소 후 정정본을 등록해 주세요.' }, 409);
      if (status === 'filed') {
        const posted = await fileWithholdingRecord(db, id, clean(payload.settlementAccountCode, 20), me, now);
        return json({ ok: true, ...posted,
          message: posted.journalNo
            ? `공제액 계상 전표 ${posted.journalNo}를 생성하고 신고완료로 처리했습니다.`
            : '공제세액이 없어 전표 없이 신고완료로 처리했습니다.' });
      }
      if (status === 'paid') {
        const posted = await payWithholdingTaxes(db, id, clean(payload.taxPaymentDate, 10),
          clean(payload.bankAccountCode, 20), me, now);
        return json({ ok: true, ...posted,
          message: posted.journalNo
            ? `원천세 납부 전표 ${posted.journalNo}를 생성하고 납부완료로 처리했습니다.`
            : '납부할 원천세가 없어 전표 없이 납부완료로 처리했습니다.' });
      }
      const cancellationReason = clean(payload.cancellationReason, 500);
      if (status === 'cancelled' && !cancellationReason) return json({ ok: false, message: '원천징수 내역 취소 사유를 입력해 주세요.' }, 400);
      if (status === 'cancelled') await assertLinkedTaxJournalsReversed(db, [row.accrual_journal_id, row.payment_journal_id]);
      await db.batch([
        db.prepare(`UPDATE accounting_withholding_records SET filing_status='cancelled',
          cancellation_reason=?,cancelled_by=?,cancelled_at=?,updated_by=?,updated_at=? WHERE id=?`)
          .bind(cancellationReason,me.name,now,me.name,now,id),
        taxAudit(db, status, 'withholding-record', id, me, { cancellationReason }, now),
      ]);
      return json({ ok: true, message: status === 'cancelled' ? '취소 처리했습니다.' : '처리 상태를 변경했습니다.' });
    }

    return json({ ok: false, message: '지원하지 않는 세무·신고자료 처리입니다.' }, 400);
  } catch (error) {
    console.error('accounting tax action failed', error);
    const message = error instanceof Error ? error.message : '세무·신고자료 처리 중 오류가 발생했습니다.';
    if (/confirmed vat record is immutable|cancelled vat record is immutable/.test(message)) {
      return json({ ok: false, message: '확정·취소된 부가가치세 자료는 변경할 수 없습니다. 취소 후 정정본을 새로 등록해 주세요.' }, 409);
    }
    if (/filed withholding record is immutable|cancelled withholding record is immutable/.test(message)) {
      return json({ ok: false, message: '신고·납부·취소된 원천징수 내역은 변경할 수 없습니다. 취소 후 정정본을 새로 등록해 주세요.' }, 409);
    }
    if (message.includes('confirmed tax profile requires explicit revision')) {
      return json({ ok: false, message: '확정된 세무기본정보는 변경 사유가 있는 새 개정본으로만 수정할 수 있습니다.' }, 409);
    }
    if (/UNIQUE constraint failed/.test(message)) {
      return json({ ok: false, message: '동일한 원자료·분할순번 또는 요청이 이미 처리되었습니다. 목록을 새로고침해 기존 자료를 확인해 주세요.' }, 409);
    }
    return json({ ok: false, message }, 500);
  }
};

export const onRequestGet: PagesFunction = async () => json({ ok: false, message: 'POST 방식으로 요청해 주세요.' }, 405);
