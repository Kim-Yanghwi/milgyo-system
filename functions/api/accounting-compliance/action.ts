import { authenticateSession, clean, ensureTables, json, randomHex } from '../../_shared/helpers';
import { ensureAccountingTables, hasAccountingAccess, isAccountingManager, parseMoney } from '../../_shared/accounting';
import { ensureAccountingOperationsTables, operationAudit } from '../../_shared/accounting-operations';
import {
  buildComplianceSnapshot,
  ensureAccountingComplianceTables,
  getProcurementApproval,
  nextComplianceNumber,
  validComplianceDate,
} from '../../_shared/accounting-compliance';

interface Env { DB: D1Database; ACCOUNTING_DB: D1Database; }
type Payload = Record<string, unknown> & { token?: string; action?: string };
const currentYear = () => new Date(Date.now() + 9 * 60 * 60 * 1000).getUTCFullYear();
const toYear = (value: unknown) => {
  const y = Number(value || currentYear());
  return Number.isInteger(y) && y >= 2000 && y <= 2200 ? y : currentYear();
};
const flag = (value: unknown) => value === true || value === 1 || value === '1' || value === 'true' || value === 'on';
const positiveMoney = (value: unknown) => Math.max(0, Math.abs(parseMoney(value)));
const dateOrNull = (value: unknown) => {
  const v = clean(value, 10);
  if (v && !validComplianceDate(v)) throw new Error('날짜 형식을 확인해 주세요.');
  return v || null;
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB || !env.ACCOUNTING_DB) return json({ ok: false, message: '전자문서 DB 또는 회계 전용 DB가 연결되지 않았습니다.' }, 500);
  let payload: Payload;
  try { payload = await request.json(); } catch { return json({ ok: false, message: '요청 형식이 올바르지 않습니다.' }, 400); }
  await ensureTables(env.DB);
  const auth = await authenticateSession(env.DB, clean(payload.token, 200));
  if (!auth.ok) return json({ ok: false, message: auth.message }, auth.status);
  if (!hasAccountingAccess(auth.user)) return json({ ok: false, message: '회계관리 접속 권한이 없습니다.' }, 403);
  await ensureAccountingTables(env.ACCOUNTING_DB);
  await ensureAccountingOperationsTables(env.ACCOUNTING_DB);
  await ensureAccountingComplianceTables(env.ACCOUNTING_DB);
  const db = env.ACCOUNTING_DB;
  const me = auth.user;
  if (me.role === 'audit') return json({ ok: false, message: '감사 계정은 자료를 열람할 수 있지만 등록·수정할 수 없습니다.' }, 403);
  if (!isAccountingManager(me)) return json({ ok: false, message: '규정·공공조달 관리 권한이 없습니다.' }, 403);
  const action = clean(payload.action, 60);
  const year = toYear(payload.year);
  const now = new Date().toISOString();

  try {
    if (action === 'save-revenue-business') {
      const id = clean(payload.id, 100) || `RB-${randomHex(20)}`;
      const title = clean(payload.title, 200), businessType = clean(payload.businessType, 60), actionType = clean(payload.actionType, 20) || 'new';
      if (!title || !businessType) return json({ ok: false, message: '사업명과 수익사업 유형을 입력해 주세요.' }, 400);
      const existing = await db.prepare(`SELECT business_no FROM accounting_revenue_businesses WHERE id=?`).bind(id).first<any>();
      const businessNo = existing?.business_no || await nextComplianceNumber(db, 'revenue-business', year);
      const routineAnnualPlan = flag(payload.routineAnnualPlan);
      const approvalReasons: string[] = [];
      if (flag(payload.majorPurposeImpact)) approvalReasons.push('법인의 목적·주요 사업범위에 중대한 영향');
      if (flag(payload.basicPropertyImpact)) approvalReasons.push('기본재산 처분·담보·장기사용 또는 중대한 시설투자');
      if (flag(payload.borrowingGuaranteeImpact)) approvalReasons.push('장기·대규모 차입 또는 채무보증 수반');
      if (flag(payload.majorFinancialBurden)) approvalReasons.push('법인의 재정상태에 중대한 부담·존립재산 영향');
      if (routineAnnualPlan && actionType !== 'new') return json({ ok: false, message: '반복·통상 사업의 이사장 승인 예외는 시행 건에만 적용합니다. 변경·중단은 이사회 의결 대상으로 처리해 주세요.' }, 400);
      if (routineAnnualPlan && businessType === 'preferential_purchase') return json({ ok: false, message: '우선구매제도 인증·지정 신청과 운영은 정관에 따라 이사회 의결 대상으로 관리해 주세요.' }, 400);
      const approvalLevel = approvalReasons.length ? 'general_meeting' : routineAnnualPlan ? 'chairman' : 'board';
      if (routineAnnualPlan && approvalReasons.length) return json({ ok: false, message: '중대한 영향이 있는 수익사업은 반복·통상 사업으로 이사장 승인 처리할 수 없습니다.' }, 400);
      const status = clean(payload.status, 30) || 'review';
      const permitStatus = clean(payload.permitStatus, 30) || 'review';
      const taxReviewStatus = clean(payload.taxReviewStatus, 30) || 'review';
      if (status === 'active' && (permitStatus === 'review' || taxReviewStatus === 'review')) return json({ ok: false, message: '수익사업을 운영중으로 전환하려면 등록·허가 및 세무 검토를 완료하거나 해당없음으로 확정해 주세요.' }, 400);
      if (['approved','active','stopped'].includes(status) && approvalLevel !== 'chairman' && !clean(payload.decisionNo, 100)) {
        return json({ ok: false, message: '이사회·총회 승인 대상은 의결번호를 입력해 주세요.' }, 400);
      }
      await db.batch([
        db.prepare(`INSERT INTO accounting_revenue_businesses
          (id,business_no,fiscal_year,title,business_type,action_type,charter_basis,start_date,end_date,expected_income,expected_expense,department,manager_name,permit_status,tax_review_status,routine_annual_plan,major_purpose_impact,basic_property_impact,borrowing_guarantee_impact,major_financial_burden,approval_level,approval_reasons,decision_no,status,memo,created_by,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET fiscal_year=excluded.fiscal_year,title=excluded.title,business_type=excluded.business_type,action_type=excluded.action_type,charter_basis=excluded.charter_basis,start_date=excluded.start_date,end_date=excluded.end_date,expected_income=excluded.expected_income,expected_expense=excluded.expected_expense,department=excluded.department,manager_name=excluded.manager_name,permit_status=excluded.permit_status,tax_review_status=excluded.tax_review_status,routine_annual_plan=excluded.routine_annual_plan,major_purpose_impact=excluded.major_purpose_impact,basic_property_impact=excluded.basic_property_impact,borrowing_guarantee_impact=excluded.borrowing_guarantee_impact,major_financial_burden=excluded.major_financial_burden,approval_level=excluded.approval_level,approval_reasons=excluded.approval_reasons,decision_no=excluded.decision_no,status=excluded.status,memo=excluded.memo,updated_at=excluded.updated_at`)
          .bind(id,businessNo,year,title,businessType,actionType,clean(payload.charterBasis,300) || '정관 제5조·제6조 / 재무회계규정 제10조의2~제10조의4',dateOrNull(payload.startDate),dateOrNull(payload.endDate),positiveMoney(payload.expectedIncome),positiveMoney(payload.expectedExpense),clean(payload.department,120),clean(payload.managerName,100),permitStatus,taxReviewStatus,routineAnnualPlan?1:0,flag(payload.majorPurposeImpact)?1:0,flag(payload.basicPropertyImpact)?1:0,flag(payload.borrowingGuaranteeImpact)?1:0,flag(payload.majorFinancialBurden)?1:0,approvalLevel,approvalReasons.join(' / '),clean(payload.decisionNo,100)||null,status,clean(payload.memo,2000)||null,me.name,now,now),
        operationAudit(db, 'save', 'revenue-business', id, me, { businessNo, title, actionType, approvalLevel, approvalReasons, status }, now),
      ]);
      return json({ ok: true, id, businessNo, approvalLevel, approvalReasons, message: '수익사업 검토자료를 저장했습니다.' });
    }

    if (action === 'save-procurement') {
      const id = clean(payload.id, 100) || `PCR-${randomHex(20)}`;
      const agency = clean(payload.agency, 160), title = clean(payload.title, 240);
      if (!agency || !title) return json({ ok: false, message: '발주기관과 공고명을 입력해 주세요.' }, 400);
      const existing = await db.prepare(`SELECT review_no FROM accounting_procurement_reviews WHERE id=?`).bind(id).first<any>();
      const reviewNo = existing?.review_no || await nextComplianceNumber(db, 'procurement', year);
      const approval = await getProcurementApproval(db, {
        ...payload,
        estimatedPrice: positiveMoney(payload.estimatedPrice),
        plannedBidAmount: positiveMoney(payload.plannedBidAmount),
        actualContractAmount: positiveMoney(payload.actualContractAmount),
        basicPropertyCollateral: flag(payload.basicPropertyCollateral),
        borrowingOrGuarantee: flag(payload.borrowingOrGuarantee),
        materialFinancialRisk: flag(payload.materialFinancialRisk),
      }, year, id);
      const status = clean(payload.status, 30) || 'review';
      const qualifications = ['businessRegistrationOk','biddingRegistrationOk','qualificationOk','competitionOk','sanctionClear','charterScopeOk'].every((key) => flag(payload[key]));
      if (['approved','contracted','completed'].includes(status) && !qualifications) return json({ ok: false, message: '승인·계약 상태로 저장하려면 필수 참가자격 확인항목을 모두 충족해야 합니다.' }, 400);
      const decisionNo = clean(payload.decisionNo, 100);
      if (['approved','contracted','completed'].includes(status) && approval.approvalLevel !== 'chairman' && !decisionNo) return json({ ok: false, message: '이사회·총회 의결 대상입니다. 의결번호를 입력해 주세요.' }, 400);
      const authorityPermitNo = clean(payload.authorityPermitNo, 120);
      if (flag(payload.basicPropertyCollateral) && ['approved','contracted','completed'].includes(status) && !authorityPermitNo) return json({ ok: false, message: '기본재산 담보 관련 건은 총회 의결과 주무관청 허가 정보를 입력해 주세요.' }, 400);
      const revenueBusinessId = clean(payload.revenueBusinessId, 100);
      if (['approved','contracted','completed'].includes(status)) {
        if (!revenueBusinessId) return json({ ok: false, message: '승인 이후 공공조달 건은 수익사업 관리대장의 공공조달 사업과 연결해 주세요.' }, 400);
        const linkedRevenue = await db.prepare(`SELECT id,business_no,business_type,status FROM accounting_revenue_businesses WHERE id=? AND fiscal_year=?`).bind(revenueBusinessId, year).first<any>();
        if (!linkedRevenue) return json({ ok: false, message: '연결한 수익사업 관리자료를 찾을 수 없습니다.' }, 404);
        if (!['procurement','preferential_purchase'].includes(String(linkedRevenue.business_type || ''))) return json({ ok: false, message: `${linkedRevenue.business_no}는 공공조달·우선구매 유형의 수익사업이 아닙니다.` }, 400);
        if (!['approved','active'].includes(String(linkedRevenue.status || ''))) return json({ ok: false, message: '공공조달을 승인·계약 처리하려면 연결 수익사업을 먼저 승인 또는 운영중 상태로 확정해 주세요.' }, 400);
      }
      const contractId = clean(payload.contractId, 100);
      if (['contracted','completed'].includes(status) && !contractId) return json({ ok: false, message: '계약 상태로 확정하려면 회계관리의 기존 계약을 연결해 주세요.' }, 400);
      if (['contracted','completed'].includes(status) && positiveMoney(payload.actualContractAmount) <= 0) return json({ ok: false, message: '계약 상태로 확정하려면 실제 계약금액을 입력해 주세요.' }, 400);
      if (contractId) {
        const linkedContract = await db.prepare(`SELECT id,contract_no,book_type_code FROM accounting_contracts WHERE id=?`).bind(contractId).first<any>();
        if (!linkedContract) return json({ ok: false, message: '연결할 기존 계약을 찾을 수 없습니다.' }, 404);
        if (linkedContract.book_type_code !== 'revenue') return json({ ok: false, message: `${linkedContract.contract_no} 계약은 수익사업회계로 구분되어 있지 않습니다. 계약관리에서 회계구분을 수익사업회계로 저장한 뒤 연결해 주세요.` }, 400);
      }
      const nextBoardReported = flag(payload.nextBoardReported);
      const nextBoardReportDate = dateOrNull(payload.nextBoardReportDate);
      if (nextBoardReported && !nextBoardReportDate) return json({ ok: false, message: '다음 이사회 보고 완료로 표시하려면 보고일을 입력해 주세요.' }, 400);
      if (approval.approvalLevel !== 'chairman' && nextBoardReported) return json({ ok: false, message: '다음 이사회 보고 관리는 이사장 승인으로 시행한 공공조달 건에 적용합니다.' }, 400);
      await db.batch([
        db.prepare(`INSERT INTO accounting_procurement_reviews
          (id,review_no,fiscal_year,revenue_business_id,contract_id,agency,announcement_no,title,bid_method,bid_date,opening_date,estimated_price,planned_bid_amount,actual_contract_amount,delivery_due_date,delivery_place,contract_start,contract_end,business_registration_ok,bidding_registration_ok,qualification_ok,competition_ok,sanction_clear,charter_scope_ok,cost_material,cost_outsource,cost_labor,cost_delivery,cost_guarantee,cost_other,cost_contingency,vat_status,purpose_reserve_review,expected_loss,response_plan,related_party,borrowing_or_guarantee,basic_property_collateral,material_financial_risk,prior_year_income_override,approval_level,approval_reasons,decision_no,authority_permit_no,next_board_reported,next_board_report_date,status,memo,created_by,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET fiscal_year=excluded.fiscal_year,revenue_business_id=excluded.revenue_business_id,contract_id=excluded.contract_id,agency=excluded.agency,announcement_no=excluded.announcement_no,title=excluded.title,bid_method=excluded.bid_method,bid_date=excluded.bid_date,opening_date=excluded.opening_date,estimated_price=excluded.estimated_price,planned_bid_amount=excluded.planned_bid_amount,actual_contract_amount=excluded.actual_contract_amount,delivery_due_date=excluded.delivery_due_date,delivery_place=excluded.delivery_place,contract_start=excluded.contract_start,contract_end=excluded.contract_end,business_registration_ok=excluded.business_registration_ok,bidding_registration_ok=excluded.bidding_registration_ok,qualification_ok=excluded.qualification_ok,competition_ok=excluded.competition_ok,sanction_clear=excluded.sanction_clear,charter_scope_ok=excluded.charter_scope_ok,cost_material=excluded.cost_material,cost_outsource=excluded.cost_outsource,cost_labor=excluded.cost_labor,cost_delivery=excluded.cost_delivery,cost_guarantee=excluded.cost_guarantee,cost_other=excluded.cost_other,cost_contingency=excluded.cost_contingency,vat_status=excluded.vat_status,purpose_reserve_review=excluded.purpose_reserve_review,expected_loss=excluded.expected_loss,response_plan=excluded.response_plan,related_party=excluded.related_party,borrowing_or_guarantee=excluded.borrowing_or_guarantee,basic_property_collateral=excluded.basic_property_collateral,material_financial_risk=excluded.material_financial_risk,prior_year_income_override=excluded.prior_year_income_override,approval_level=excluded.approval_level,approval_reasons=excluded.approval_reasons,decision_no=excluded.decision_no,authority_permit_no=excluded.authority_permit_no,next_board_reported=excluded.next_board_reported,next_board_report_date=excluded.next_board_report_date,status=excluded.status,memo=excluded.memo,updated_at=excluded.updated_at`)
          .bind(id,reviewNo,year,revenueBusinessId||null,contractId||null,agency,clean(payload.announcementNo,100)||null,title,clean(payload.bidMethod,50)||'competitive',dateOrNull(payload.bidDate),dateOrNull(payload.openingDate),positiveMoney(payload.estimatedPrice),positiveMoney(payload.plannedBidAmount),positiveMoney(payload.actualContractAmount),dateOrNull(payload.deliveryDueDate),clean(payload.deliveryPlace,300)||null,dateOrNull(payload.contractStart),dateOrNull(payload.contractEnd),flag(payload.businessRegistrationOk)?1:0,flag(payload.biddingRegistrationOk)?1:0,flag(payload.qualificationOk)?1:0,flag(payload.competitionOk)?1:0,flag(payload.sanctionClear)?1:0,flag(payload.charterScopeOk)?1:0,positiveMoney(payload.costMaterial),positiveMoney(payload.costOutsource),positiveMoney(payload.costLabor),positiveMoney(payload.costDelivery),positiveMoney(payload.costGuarantee),positiveMoney(payload.costOther),positiveMoney(payload.costContingency),clean(payload.vatStatus,30)||'review',clean(payload.purposeReserveReview,30)||'review',positiveMoney(payload.expectedLoss),clean(payload.responsePlan,2000)||null,flag(payload.relatedParty)?1:0,flag(payload.borrowingOrGuarantee)?1:0,flag(payload.basicPropertyCollateral)?1:0,flag(payload.materialFinancialRisk)?1:0,positiveMoney(payload.priorYearIncomeOverride),approval.approvalLevel,approval.reasons.join(' / '),decisionNo||null,authorityPermitNo||null,nextBoardReported?1:0,nextBoardReportDate,status,clean(payload.memo,2000)||null,me.name,now,now),
        operationAudit(db, 'save', 'procurement-review', id, me, { reviewNo, title, agency, status, approval }, now),
      ]);
      return json({ ok: true, id, reviewNo, approval, message: '입찰참가 검토자료를 저장했습니다.' });
    }

    if (action === 'save-guarantee') {
      const procurementReviewId = clean(payload.procurementReviewId, 100);
      const parent = await db.prepare(`SELECT fiscal_year FROM accounting_procurement_reviews WHERE id=?`).bind(procurementReviewId).first<any>();
      if (!parent) return json({ ok: false, message: '연결할 입찰참가 검토자료를 찾을 수 없습니다.' }, 404);
      const id = clean(payload.id, 100) || `GRN-${randomHex(20)}`;
      const existing = await db.prepare(`SELECT guarantee_no FROM accounting_procurement_guarantees WHERE id=?`).bind(id).first<any>();
      const guaranteeNo = existing?.guarantee_no || await nextComplianceNumber(db, 'guarantee', Number(parent.fiscal_year));
      const provider = clean(payload.provider, 160), type = clean(payload.guaranteeType, 40);
      if (!provider || !type) return json({ ok: false, message: '보증종류와 보증기관을 입력해 주세요.' }, 400);
      await db.batch([
        db.prepare(`INSERT INTO accounting_procurement_guarantees (id,guarantee_no,procurement_review_id,guarantee_type,provider,policy_no,amount,fee,start_date,end_date,recovered,memo,created_by,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET guarantee_type=excluded.guarantee_type,provider=excluded.provider,policy_no=excluded.policy_no,amount=excluded.amount,fee=excluded.fee,start_date=excluded.start_date,end_date=excluded.end_date,recovered=excluded.recovered,memo=excluded.memo,updated_at=excluded.updated_at`)
          .bind(id,guaranteeNo,procurementReviewId,type,provider,clean(payload.policyNo,120)||null,positiveMoney(payload.amount),positiveMoney(payload.fee),dateOrNull(payload.startDate),dateOrNull(payload.endDate),flag(payload.recovered)?1:0,clean(payload.memo,1000)||null,me.name,now,now),
        operationAudit(db, 'save', 'procurement-guarantee', id, me, { guaranteeNo, procurementReviewId, type, provider }, now),
      ]);
      return json({ ok: true, id, guaranteeNo, message: '보증·하자보수 자료를 저장했습니다.' });
    }

    if (action === 'save-reserve') {
      const id = clean(payload.id, 100) || `RSV-${randomHex(20)}`;
      const existing = await db.prepare(`SELECT reserve_no FROM accounting_purpose_reserves WHERE id=?`).bind(id).first<any>();
      const reserveNo = existing?.reserve_no || await nextComplianceNumber(db, 'reserve', year);
      const setDate = clean(payload.setDate, 10), amount = positiveMoney(payload.setAmount);
      if (!validComplianceDate(setDate) || !setDate || amount <= 0) return json({ ok: false, message: '설정일과 설정액을 확인해 주세요.' }, 400);
      await db.batch([
        db.prepare(`INSERT INTO accounting_purpose_reserves (id,reserve_no,fiscal_year,set_date,set_amount,use_deadline,fund_id,tax_review_status,reviewer,memo,created_by,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET fiscal_year=excluded.fiscal_year,set_date=excluded.set_date,set_amount=excluded.set_amount,use_deadline=excluded.use_deadline,fund_id=excluded.fund_id,tax_review_status=excluded.tax_review_status,reviewer=excluded.reviewer,memo=excluded.memo,updated_at=excluded.updated_at`)
          .bind(id,reserveNo,year,setDate,amount,dateOrNull(payload.useDeadline),clean(payload.fundId,100)||'FUND-RESERVE',clean(payload.taxReviewStatus,30)||'review',clean(payload.reviewer,100)||null,clean(payload.memo,1200)||null,me.name,now,now),
        operationAudit(db, 'save', 'purpose-reserve', id, me, { reserveNo, amount, setDate }, now),
      ]);
      return json({ ok: true, id, reserveNo, message: '고유목적사업준비금 설정자료를 저장했습니다.' });
    }

    if (action === 'add-reserve-transaction') {
      const reserveId = clean(payload.reserveId, 100), type = clean(payload.transactionType, 20), amount = positiveMoney(payload.amount), purpose = clean(payload.purpose, 500), date = clean(payload.transactionDate, 10);
      if (!['use','reversal'].includes(type) || !validComplianceDate(date) || !date || amount <= 0 || !purpose) return json({ ok: false, message: '준비금 사용·환입 내역을 정확히 입력해 주세요.' }, 400);
      const reserve = await db.prepare(`SELECT set_amount FROM accounting_purpose_reserves WHERE id=?`).bind(reserveId).first<any>();
      if (!reserve) return json({ ok: false, message: '준비금 자료를 찾을 수 없습니다.' }, 404);
      const sum = await db.prepare(`SELECT COALESCE(SUM(amount),0) AS used FROM accounting_purpose_reserve_transactions WHERE reserve_id=?`).bind(reserveId).first<any>();
      if (Number(sum?.used || 0) + amount > Number(reserve.set_amount || 0)) return json({ ok: false, message: '사용·환입 누계가 준비금 설정액을 초과할 수 없습니다.' }, 400);
      const id = `RSVT-${randomHex(20)}`;
      await db.batch([
        db.prepare(`INSERT INTO accounting_purpose_reserve_transactions (id,reserve_id,transaction_date,transaction_type,amount,purpose,resolution_id,memo,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
          .bind(id,reserveId,date,type,amount,purpose,clean(payload.resolutionId,100)||null,clean(payload.memo,1000)||null,me.name,now),
        operationAudit(db, 'save', 'purpose-reserve-transaction', id, me, { reserveId, type, amount, purpose }, now),
      ]);
      return json({ ok: true, id, message: type === 'use' ? '준비금 사용내역을 등록했습니다.' : '준비금 환입내역을 등록했습니다.' });
    }

    if (action === 'save-check') {
      const periodType = clean(payload.periodType, 20) === 'quarter' ? 'quarter' : 'month';
      const periodKey = clean(payload.periodKey, 10) || (periodType === 'quarter' ? 'Q1' : '01');
      const snapshot = await buildComplianceSnapshot(db, year, periodType, periodKey);
      const id = clean(payload.id, 100) || `CHK-${randomHex(20)}`;
      const existing = await db.prepare(`SELECT check_no FROM accounting_compliance_checks WHERE id=?`).bind(id).first<any>();
      const checkNo = existing?.check_no || await nextComplianceNumber(db, 'check', year);
      const status = clean(payload.status, 20) || 'open';
      await db.batch([
        db.prepare(`INSERT INTO accounting_compliance_checks (id,check_no,fiscal_year,period_type,period_key,snapshot_json,findings,corrective_action,status,reported_chairman,reported_auditor,completed_by,completed_at,created_by,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET fiscal_year=excluded.fiscal_year,period_type=excluded.period_type,period_key=excluded.period_key,snapshot_json=excluded.snapshot_json,findings=excluded.findings,corrective_action=excluded.corrective_action,status=excluded.status,reported_chairman=excluded.reported_chairman,reported_auditor=excluded.reported_auditor,completed_by=excluded.completed_by,completed_at=excluded.completed_at,updated_at=excluded.updated_at`)
          .bind(id,checkNo,year,periodType,periodKey,JSON.stringify(snapshot),clean(payload.findings,3000)||null,clean(payload.correctiveAction,3000)||null,status,flag(payload.reportedChairman)?1:0,flag(payload.reportedAuditor)?1:0,status==='completed'?me.name:null,status==='completed'?now:null,me.name,now,now),
        operationAudit(db, 'save', 'compliance-check', id, me, { checkNo, periodType, periodKey, snapshot, status }, now),
      ]);
      return json({ ok: true, id, checkNo, snapshot, message: '회계점검 결과를 저장했습니다.' });
    }

    if (action === 'save-incident') {
      const id = clean(payload.id, 100) || `INC-${randomHex(20)}`;
      const existing = await db.prepare(`SELECT report_no FROM accounting_finance_incidents WHERE id=?`).bind(id).first<any>();
      const reportNo = existing?.report_no || await nextComplianceNumber(db, 'incident', year);
      const occurredAt = clean(payload.occurredAt, 30) || now;
      const category = clean(payload.category, 80), title = clean(payload.title, 240), detail = clean(payload.detail, 4000);
      if (!category || !title || !detail) return json({ ok: false, message: '즉시보고 유형, 제목, 상세내용을 입력해 주세요.' }, 400);
      const status = clean(payload.status, 20) || 'open';
      await db.batch([
        db.prepare(`INSERT INTO accounting_finance_incidents (id,report_no,fiscal_year,occurred_at,category,title,detail,immediate_action,chairman_notified,auditor_notified,status,resolved_at,created_by,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET fiscal_year=excluded.fiscal_year,occurred_at=excluded.occurred_at,category=excluded.category,title=excluded.title,detail=excluded.detail,immediate_action=excluded.immediate_action,chairman_notified=excluded.chairman_notified,auditor_notified=excluded.auditor_notified,status=excluded.status,resolved_at=excluded.resolved_at,updated_at=excluded.updated_at`)
          .bind(id,reportNo,year,occurredAt,category,title,detail,clean(payload.immediateAction,3000)||null,flag(payload.chairmanNotified)?1:0,flag(payload.auditorNotified)?1:0,status,status==='resolved'?now:null,me.name,now,now),
        operationAudit(db, 'save', 'finance-incident', id, me, { reportNo, category, title, status }, now),
      ]);
      return json({ ok: true, id, reportNo, message: '중요 회계사항 즉시보고를 저장했습니다.' });
    }

    if (action === 'save-vehicle') {
      const id = clean(payload.id, 100) || `VEH-${randomHex(20)}`;
      const existing = await db.prepare(`SELECT vehicle_no FROM accounting_vehicle_records WHERE id=?`).bind(id).first<any>();
      const vehicleNo = existing?.vehicle_no || await nextComplianceNumber(db, 'vehicle', year);
      const managementType = clean(payload.managementType, 20), modelName = clean(payload.modelName, 160), purpose = clean(payload.purpose, 1200);
      if (!['owned','lease','rental'].includes(managementType) || !modelName || !purpose) return json({ ok: false, message: '차량 관리유형, 차종·차량명, 업무용도를 입력해 주세요.' }, 400);
      const contractStart = dateOrNull(payload.contractStart), contractEnd = dateOrNull(payload.contractEnd);
      const renewalFlag = flag(payload.renewalFlag);
      let requiredApproval = 'chairman';
      let contractDays = 0;
      if (contractStart && contractEnd) contractDays = Math.max(0, Math.round((Date.parse(contractEnd) - Date.parse(contractStart)) / 86400000));
      if (managementType === 'rental' && contractDays > 0 && contractDays <= 30 && !renewalFlag) requiredApproval = 'secretary_general';
      if (managementType === 'owned' || contractDays > 365 || renewalFlag) requiredApproval = 'board';
      const requestedApproval = clean(payload.approvalLevel, 30) || 'auto';
      const rank: Record<string, number> = { secretary_general: 1, chairman: 2, board: 3 };
      const approvalLevel = requestedApproval === 'auto' ? requiredApproval : ((rank[requestedApproval] || 0) >= (rank[requiredApproval] || 0) ? requestedApproval : requiredApproval);
      const status = clean(payload.status, 20) || 'active';
      if (!['active','returned','disposed'].includes(status)) return json({ ok: false, message: '차량 상태 값이 올바르지 않습니다.' }, 400);
      const decisionNo = clean(payload.decisionNo, 120);
      if (approvalLevel === 'board' && !decisionNo && status === 'active') return json({ ok: false, message: '이사회 의결 대상 차량은 의결번호를 입력해 주세요.' }, 400);
      const successionCandidate = clean(payload.successionCandidate, 120);
      const successionPrice = positiveMoney(payload.successionPrice);
      const successionPriceBasis = clean(payload.successionPriceBasis, 1200);
      const successionCounterpartyConsent = flag(payload.successionCounterpartyConsent);
      const successionNoLoss = flag(payload.successionNoLoss);
      const successionDecisionNo = clean(payload.successionDecisionNo, 120);
      if (successionCandidate && (!successionDecisionNo || successionPrice <= 0 || !successionPriceBasis || !successionCounterpartyConsent || !successionNoLoss)) {
        return json({ ok: false, message: '임차권 승계는 상대방 동의, 법인 손실 없음 확인, 승계대가·산정근거와 이사회 의결번호를 모두 입력해 주세요.' }, 400);
      }
      await db.batch([
        db.prepare(`INSERT INTO accounting_vehicle_records (id,vehicle_no,management_type,asset_id,contract_id,plate_no,model_name,primary_user,purpose,contract_start,contract_end,monthly_cost,insurer,insurance_end,approval_level,decision_no,renewal_flag,status,succession_candidate,succession_price,succession_price_basis,succession_counterparty_consent,succession_no_loss,succession_decision_no,memo,created_by,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET management_type=excluded.management_type,asset_id=excluded.asset_id,contract_id=excluded.contract_id,plate_no=excluded.plate_no,model_name=excluded.model_name,primary_user=excluded.primary_user,purpose=excluded.purpose,contract_start=excluded.contract_start,contract_end=excluded.contract_end,monthly_cost=excluded.monthly_cost,insurer=excluded.insurer,insurance_end=excluded.insurance_end,approval_level=excluded.approval_level,decision_no=excluded.decision_no,renewal_flag=excluded.renewal_flag,status=excluded.status,succession_candidate=excluded.succession_candidate,succession_price=excluded.succession_price,succession_price_basis=excluded.succession_price_basis,succession_counterparty_consent=excluded.succession_counterparty_consent,succession_no_loss=excluded.succession_no_loss,succession_decision_no=excluded.succession_decision_no,memo=excluded.memo,updated_at=excluded.updated_at`)
          .bind(id,vehicleNo,managementType,clean(payload.assetId,100)||null,clean(payload.contractId,100)||null,clean(payload.plateNo,40)||null,modelName,clean(payload.primaryUser,100)||null,purpose,contractStart,contractEnd,positiveMoney(payload.monthlyCost),clean(payload.insurer,160)||null,dateOrNull(payload.insuranceEnd),approvalLevel,decisionNo||null,renewalFlag?1:0,status,successionCandidate||null,successionPrice,successionPriceBasis||null,successionCounterpartyConsent?1:0,successionNoLoss?1:0,successionDecisionNo||null,clean(payload.memo,1800)||null,me.name,now,now),
        operationAudit(db, 'save', 'vehicle', id, me, { vehicleNo, managementType, modelName, approvalLevel, requiredApproval, renewalFlag, status }, now),
      ]);
      return json({ ok: true, id, vehicleNo, approvalLevel, message: '업무용 차량 관리자료를 저장했습니다.' });
    }

    if (action === 'save-vehicle-succession') {
      const id = clean(payload.id, 100);
      if (!id) return json({ ok: false, message: '승계 대상 차량을 선택해 주세요.' }, 400);
      const vehicle = await db.prepare(`SELECT id,vehicle_no,status,management_type FROM accounting_vehicle_records WHERE id=?`).bind(id).first<any>();
      if (!vehicle) return json({ ok: false, message: '업무용 차량 자료를 찾을 수 없습니다.' }, 404);
      if (!['lease','rental'].includes(String(vehicle.management_type||''))) return json({ ok: false, message: '임차권·리스 승계 관리는 임차·렌트 또는 리스 차량에만 적용할 수 있습니다.' }, 400);
      const successionCandidate = clean(payload.successionCandidate, 120);
      const successionPrice = positiveMoney(payload.successionPrice);
      const successionPriceBasis = clean(payload.successionPriceBasis, 1200);
      const successionCounterpartyConsent = flag(payload.successionCounterpartyConsent);
      const successionNoLoss = flag(payload.successionNoLoss);
      const successionDecisionNo = clean(payload.successionDecisionNo, 120);
      const completeTransfer = flag(payload.completeTransfer);
      if (!successionCandidate || successionPrice <= 0 || !successionPriceBasis || !successionCounterpartyConsent || !successionNoLoss || !successionDecisionNo) {
        return json({ ok: false, message: '승계희망자, 승계대가·산정근거, 계약상대방 동의, 법인 손실 없음 확인, 이사회 의결번호를 모두 입력해 주세요.' }, 400);
      }
      const status = completeTransfer ? 'transferred' : String(vehicle.status || 'active');
      await db.batch([
        db.prepare(`UPDATE accounting_vehicle_records SET succession_candidate=?,succession_price=?,succession_price_basis=?,succession_counterparty_consent=1,succession_no_loss=1,succession_decision_no=?,status=?,updated_at=? WHERE id=?`)
          .bind(successionCandidate,successionPrice,successionPriceBasis,successionDecisionNo,status,now,id),
        operationAudit(db, completeTransfer ? 'transfer' : 'save', 'vehicle-succession', id, me, { vehicleNo: vehicle.vehicle_no, successionCandidate, successionPrice, successionDecisionNo, status }, now),
      ]);
      return json({ ok: true, id, status, message: completeTransfer ? '승계 완료 처리하여 업무용 차량 현행 목록에서 제외했습니다.' : '차량 승계 검토자료를 저장했습니다.' });
    }

    if (action === 'set-vehicle-status') {
      const id = clean(payload.id, 100), status = clean(payload.status, 20);
      if (!id || !['active','returned','disposed'].includes(status)) return json({ ok: false, message: '차량과 변경할 상태를 확인해 주세요.' }, 400);
      const vehicle = await db.prepare(`SELECT id,vehicle_no,status FROM accounting_vehicle_records WHERE id=?`).bind(id).first<any>();
      if (!vehicle) return json({ ok: false, message: '업무용 차량 자료를 찾을 수 없습니다.' }, 404);
      await db.batch([
        db.prepare(`UPDATE accounting_vehicle_records SET status=?,updated_at=? WHERE id=?`).bind(status,now,id),
        operationAudit(db, 'status', 'vehicle', id, me, { vehicleNo: vehicle.vehicle_no, from: vehicle.status, to: status }, now),
      ]);
      return json({ ok: true, id, status, message: `차량 상태를 ${status === 'active' ? '사용중' : status === 'returned' ? '반납' : '처분'}으로 변경했습니다.` });
    }

    if (action === 'add-vehicle-log') {
      const vehicleId = clean(payload.vehicleId, 100), useDate = clean(payload.useDate, 10), purpose = clean(payload.purpose, 500), driver = clean(payload.driver, 100);
      if (!vehicleId || !validComplianceDate(useDate) || !useDate || !purpose || !driver) return json({ ok: false, message: '차량, 운행일, 운행목적, 운전자를 입력해 주세요.' }, 400);
      const vehicle = await db.prepare(`SELECT id FROM accounting_vehicle_records WHERE id=?`).bind(vehicleId).first();
      if (!vehicle) return json({ ok: false, message: '업무용 차량 자료를 찾을 수 없습니다.' }, 404);
      const id = `VLOG-${randomHex(20)}`;
      await db.batch([
        db.prepare(`INSERT INTO accounting_vehicle_logs (id,vehicle_id,use_date,purpose,route,distance_km,driver,memo,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
          .bind(id,vehicleId,useDate,purpose,clean(payload.route,300)||null,Math.max(0,Number(payload.distanceKm||0)),driver,clean(payload.memo,1000)||null,me.name,now),
        operationAudit(db, 'save', 'vehicle-log', id, me, { vehicleId, useDate, purpose, driver }, now),
      ]);
      return json({ ok: true, id, message: '차량 운행기록을 등록했습니다.' });
    }

    return json({ ok: false, message: '지원하지 않는 저장 요청입니다.' }, 400);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ ok: false, message }, 500);
  }
};
