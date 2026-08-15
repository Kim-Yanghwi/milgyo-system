import { authenticateSession, clean, ensureTables, formatDepartmentDisplay, json, normalizeDepartmentValue } from '../../_shared/helpers';
import { canViewAllAccounting, ensureAccountingTables, hasAccountingAccess, isAccountingManager } from '../../_shared/accounting';
import { getDimensionMaster } from '../../_shared/accounting-special';
import { ensureAccountingOperationsTables } from '../../_shared/accounting-operations';
import {
  buildComplianceSnapshot,
  ensureAccountingComplianceTables,
  getPriorYearIncome,
  getProcurementAnnualContractTotal,
  getProcurementApproval,
} from '../../_shared/accounting-compliance';

interface Env { DB: D1Database; ACCOUNTING_DB: D1Database; }
type Payload = Record<string, unknown> & { token?: string; action?: string };
const currentYear = () => new Date(Date.now() + 9 * 60 * 60 * 1000).getUTCFullYear();
const toYear = (value: unknown) => {
  const y = Number(value || currentYear());
  return Number.isInteger(y) && y >= 2000 && y <= 2200 ? y : currentYear();
};
const toLimit = (value: unknown, fallback = 200) => Math.max(10, Math.min(500, Number(value || fallback) || fallback));

const ORGANIZATION_DEPARTMENT_TREE = [
  { name: '이사장' }, { name: '이사회' }, { name: '감사' }, { name: '종정' },
  { name: '사무처', children: ['재정국', '준법윤리국', '국제교류국', '문화홍보국', '사회공헌국'] },
  { name: '총무원' }, { name: '교육·포교원' },
  { name: '소속기관·교구', children: ['람림불교교육원', '서울·인천·경기교구', '강원교구', '대전·세종·충남교구', '충북교구', '전남광주·전북교구', '대구·경북교구', '부산·울산·경남교구', '제주교구'] },
  { name: '위원회·신도단체', children: ['신도회', '사찰운영위원회'] },
] as const;

const organizationDepartmentOptions: Array<{ value: string; label: string }> = ORGANIZATION_DEPARTMENT_TREE.flatMap((department) => {
  const base: Array<{ value: string; label: string }> = [{ value: department.name, label: department.name }];
  const children = 'children' in department ? department.children : undefined;
  if (!children) return base;
  return base.concat(children.map((child) => ({ value: `${department.name} - ${child}`, label: `${department.name}(${child})` })));
});

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
  const manager = isAccountingManager(me);
  const viewAll = canViewAllAccounting(me);
  const action = clean(payload.action, 60) || 'init';
  const year = toYear(payload.year);
  const limit = toLimit(payload.limit);

  try {
    if (action === 'init') {
      const [dimensions, fiscalYears, accounts, contracts, assets, summary, priorYearIncome, annualProcurementTotal, organizationUsersRaw] = await Promise.all([
        getDimensionMaster(db),
        db.prepare(`SELECT year,name,start_date,end_date,status FROM accounting_fiscal_years ORDER BY year`).all(),
        db.prepare(`SELECT code,name,account_type FROM accounting_accounts WHERE active=1 ORDER BY code`).all(),
        db.prepare(`SELECT c.id,c.contract_no,c.title,c.contract_amount,c.start_date,c.end_date,c.status,c.book_type_code,bt.name AS book_type_name FROM accounting_contracts c LEFT JOIN accounting_book_types bt ON bt.code=c.book_type_code ORDER BY c.contract_date DESC,c.created_at DESC LIMIT 300`).all(),
        db.prepare(`SELECT id,asset_no,name,category,status FROM accounting_assets WHERE status<>'disposed' ORDER BY name LIMIT 300`).all(),
        db.prepare(`SELECT
          (SELECT COUNT(*) FROM accounting_revenue_businesses WHERE fiscal_year=? AND status IN ('review','approved','active')) AS revenue_businesses,
          (SELECT COUNT(*) FROM accounting_procurement_reviews WHERE fiscal_year=? AND status IN ('review','approved','contracted')) AS procurements,
          (SELECT COUNT(*) FROM accounting_finance_incidents WHERE fiscal_year=? AND status='open') AS incidents,
          (SELECT COUNT(*) FROM accounting_compliance_checks WHERE fiscal_year=? AND status='open') AS checks,
          (SELECT COUNT(*) FROM accounting_vehicle_records WHERE status='active') AS vehicles,
          (SELECT COUNT(*) FROM accounting_procurement_guarantees WHERE recovered=0 AND end_date<>'' AND end_date<=date('now','+45 days')) AS expiring_guarantees,
          (SELECT COALESCE(SUM(r.set_amount),0)-COALESCE((SELECT SUM(t.amount) FROM accounting_purpose_reserve_transactions t JOIN accounting_purpose_reserves rr ON rr.id=t.reserve_id WHERE rr.fiscal_year=?),0) FROM accounting_purpose_reserves r WHERE r.fiscal_year=?) AS reserve_balance
        `).bind(year, year, year, year, year, year).first<any>(),
        getPriorYearIncome(db, year),
        getProcurementAnnualContractTotal(db, year),
        env.DB.prepare(`SELECT CAST(id AS TEXT) AS id,name,position,department,role FROM system_users WHERE active=1 ORDER BY name`).all(),
      ]);
      const organizationUsers = (organizationUsersRaw.results || []).map((row: any) => {
        const department = normalizeDepartmentValue(row.department, row.position || '');
        return {
          id: String(row.id || ''),
          name: String(row.name || ''),
          position: String(row.position || ''),
          department,
          departmentLabel: department ? formatDepartmentDisplay(department, row.position || '') : '',
          role: String(row.role || ''),
        };
      });
      return json({
        ok: true,
        me,
        year,
        permissions: { manager, canViewAll: viewAll, audit: me.role === 'audit' },
        ...dimensions,
        fiscalYears: fiscalYears.results || [],
        accounts: accounts.results || [],
        contracts: contracts.results || [],
        assets: assets.results || [],
        organizationDepartments: organizationDepartmentOptions,
        organizationUsers,
        summary: summary || {},
        priorYearIncome,
        annualProcurementTotal,
        annualProcurementLimit: Math.floor(priorYearIncome * 0.5),
      });
    }

    if (action === 'revenue-businesses') {
      const rows = await db.prepare(`SELECT * FROM accounting_revenue_businesses WHERE fiscal_year=? ORDER BY created_at DESC LIMIT ${limit}`).bind(year).all();
      return json({ ok: true, rows: rows.results || [] });
    }

    if (action === 'procurements') {
      const rows = await db.prepare(`SELECT p.*,r.business_no AS revenue_business_no,r.title AS revenue_business_title,c.contract_no,c.title AS contract_title,
        (SELECT COUNT(*) FROM accounting_procurement_guarantees g WHERE g.procurement_review_id=p.id) AS guarantee_count
        FROM accounting_procurement_reviews p
        LEFT JOIN accounting_revenue_businesses r ON r.id=p.revenue_business_id
        LEFT JOIN accounting_contracts c ON c.id=p.contract_id
        WHERE p.fiscal_year=? ORDER BY p.created_at DESC LIMIT ${limit}`).bind(year).all();
      const [priorYearIncome, annualTotal] = await Promise.all([getPriorYearIncome(db, year), getProcurementAnnualContractTotal(db, year)]);
      return json({ ok: true, rows: rows.results || [], priorYearIncome, annualTotal, annualLimit: Math.floor(priorYearIncome * 0.5) });
    }

    if (action === 'procurement-detail') {
      const id = clean(payload.id, 100);
      const row = await db.prepare(`SELECT p.*,r.business_no AS revenue_business_no,r.title AS revenue_business_title,c.contract_no,c.title AS contract_title
        FROM accounting_procurement_reviews p LEFT JOIN accounting_revenue_businesses r ON r.id=p.revenue_business_id
        LEFT JOIN accounting_contracts c ON c.id=p.contract_id WHERE p.id=?`).bind(id).first<any>();
      if (!row) return json({ ok: false, message: '입찰참가 검토자료를 찾을 수 없습니다.' }, 404);
      const guarantees = await db.prepare(`SELECT * FROM accounting_procurement_guarantees WHERE procurement_review_id=? ORDER BY end_date,created_at`).bind(id).all();
      const approval = await getProcurementApproval(db, {
        estimatedPrice: row.estimated_price, plannedBidAmount: row.planned_bid_amount, actualContractAmount: row.actual_contract_amount,
        basicPropertyCollateral: !!row.basic_property_collateral, borrowingOrGuarantee: !!row.borrowing_or_guarantee,
        materialFinancialRisk: !!row.material_financial_risk, contractStart: row.contract_start, contractEnd: row.contract_end,
        priorYearIncomeOverride: row.prior_year_income_override,
      }, Number(row.fiscal_year), id);
      return json({ ok: true, row, guarantees: guarantees.results || [], approval });
    }

    if (action === 'procurement-preview') {
      const approval = await getProcurementApproval(db, payload, year, clean(payload.id, 100));
      const costs = ['costMaterial','costOutsource','costLabor','costDelivery','costGuarantee','costOther','costContingency']
        .reduce((sum, key) => sum + Math.max(0, Math.round(Number(payload[key] || 0))), 0);
      const bid = Math.max(0, Math.round(Number(payload.plannedBidAmount || 0)));
      const expectedProfit = bid - costs;
      const expectedProfitRate = bid > 0 ? Math.round((expectedProfit / bid) * 1000) / 10 : 0;
      const profitWarning = bid > 0 && (expectedProfit < 0 || expectedProfitRate < 5) ? '예상이익이 음수이거나 이익률이 5% 미만입니다. 입찰 참가 여부를 재검토해 주세요.' : '';
      return json({ ok: true, approval, totalCost: costs, expectedProfit, expectedProfitRate, profitWarning });
    }

    if (action === 'reserves') {
      const rows = await db.prepare(`SELECT r.*,f.name AS fund_name,
        COALESCE(SUM(CASE WHEN t.transaction_type='use' THEN t.amount ELSE 0 END),0) AS used_amount,
        COALESCE(SUM(CASE WHEN t.transaction_type='reversal' THEN t.amount ELSE 0 END),0) AS reversed_amount
        FROM accounting_purpose_reserves r LEFT JOIN accounting_funds f ON f.id=r.fund_id
        LEFT JOIN accounting_purpose_reserve_transactions t ON t.reserve_id=r.id
        WHERE r.fiscal_year=? GROUP BY r.id ORDER BY r.set_date DESC,r.created_at DESC LIMIT ${limit}`).bind(year).all();
      return json({ ok: true, rows: rows.results || [] });
    }

    if (action === 'reserve-detail') {
      const id = clean(payload.id, 100);
      const row = await db.prepare(`SELECT r.*,f.name AS fund_name FROM accounting_purpose_reserves r LEFT JOIN accounting_funds f ON f.id=r.fund_id WHERE r.id=?`).bind(id).first<any>();
      if (!row) return json({ ok: false, message: '고유목적사업준비금 자료를 찾을 수 없습니다.' }, 404);
      const transactions = await db.prepare(`SELECT * FROM accounting_purpose_reserve_transactions WHERE reserve_id=? ORDER BY transaction_date DESC,created_at DESC`).bind(id).all();
      return json({ ok: true, row, transactions: transactions.results || [] });
    }

    if (action === 'compliance-preview') {
      const periodType = clean(payload.periodType, 20) === 'quarter' ? 'quarter' : 'month';
      const periodKey = clean(payload.periodKey, 10) || (periodType === 'quarter' ? 'Q1' : '01');
      const snapshot = await buildComplianceSnapshot(db, year, periodType, periodKey);
      return json({ ok: true, snapshot });
    }

    if (action === 'checks') {
      const rows = await db.prepare(`SELECT * FROM accounting_compliance_checks WHERE fiscal_year=? ORDER BY created_at DESC LIMIT ${limit}`).bind(year).all();
      return json({ ok: true, rows: (rows.results || []).map((row: any) => ({ ...row, snapshot: (() => { try { return JSON.parse(row.snapshot_json || '{}'); } catch { return {}; } })() })) });
    }

    if (action === 'incidents') {
      const rows = await db.prepare(`SELECT * FROM accounting_finance_incidents WHERE fiscal_year=? ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END,occurred_at DESC,created_at DESC LIMIT ${limit}`).bind(year).all();
      return json({ ok: true, rows: rows.results || [] });
    }

    if (action === 'vehicles') {
      const rows = await db.prepare(`SELECT v.*,a.asset_no,a.name AS asset_name,c.contract_no,c.title AS contract_title,
        (SELECT COUNT(*) FROM accounting_vehicle_logs l WHERE l.vehicle_id=v.id) AS log_count,
        (SELECT MAX(l.use_date) FROM accounting_vehicle_logs l WHERE l.vehicle_id=v.id) AS last_log_date
        FROM accounting_vehicle_records v LEFT JOIN accounting_assets a ON a.id=v.asset_id LEFT JOIN accounting_contracts c ON c.id=v.contract_id
        ORDER BY CASE v.status WHEN 'active' THEN 0 ELSE 1 END,v.created_at DESC LIMIT ${limit}`).all();
      return json({ ok: true, rows: rows.results || [] });
    }

    if (action === 'vehicle-detail') {
      const id = clean(payload.id, 100);
      const row = await db.prepare(`SELECT v.*,a.asset_no,a.name AS asset_name,c.contract_no,c.title AS contract_title FROM accounting_vehicle_records v LEFT JOIN accounting_assets a ON a.id=v.asset_id LEFT JOIN accounting_contracts c ON c.id=v.contract_id WHERE v.id=?`).bind(id).first<any>();
      if (!row) return json({ ok: false, message: '업무용 차량 자료를 찾을 수 없습니다.' }, 404);
      const logs = await db.prepare(`SELECT * FROM accounting_vehicle_logs WHERE vehicle_id=? ORDER BY use_date DESC,created_at DESC LIMIT 300`).bind(id).all();
      return json({ ok: true, row, logs: logs.results || [] });
    }

    return json({ ok: false, message: '지원하지 않는 조회 요청입니다.' }, 400);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ ok: false, message }, 500);
  }
};
