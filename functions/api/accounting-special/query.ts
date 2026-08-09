import { authenticateSession, clean, ensureTables, json } from '../../_shared/helpers';
import { canViewAllAccounting, ensureAccountingTables, hasAccountingAccess, isAccountingManager } from '../../_shared/accounting';
import { ensureAccountingSpecialTables, getDimensionMaster } from '../../_shared/accounting-special';
import { ensureAccountingTaxTables } from '../../_shared/accounting-tax';

interface Env { DB: D1Database; ACCOUNTING_DB: D1Database; }
type Payload = Record<string, unknown> & { token?: string; action?: string };
const toYear = (value: unknown) => {
  const current = new Date(Date.now() + 9 * 60 * 60 * 1000).getUTCFullYear();
  const year = Number(value || current);
  return year >= 2000 && year <= 2200 ? year : current;
};
const requestedLimit=(value:unknown,defaultValue=50)=>Math.max(1,Math.min(200,Number(value||defaultValue)||defaultValue));
const EXPORT_PAGE_SIZE=1000,EXPORT_MAX_ROWS=100000;
const fetchCompleteRows=async<T>(db:D1Database,selectSql:string,values:unknown[],orderBy:string,label:string)=>{
  const count=await db.prepare(`SELECT COUNT(*) AS count FROM (${selectSql}) export_count`).bind(...values).first<{count:number}>();
  const expected=Number(count?.count||0);if(expected>EXPORT_MAX_ROWS)throw new Error(`${label}이 ${EXPORT_MAX_ROWS.toLocaleString('ko-KR')}건을 초과합니다. 회계연도나 조건을 나누어 내보내 주세요.`);
  const rows:T[]=[];for(let offset=0;offset<expected;offset+=EXPORT_PAGE_SIZE){const page=await db.prepare(`${selectSql} ${orderBy} LIMIT ? OFFSET ?`).bind(...values,EXPORT_PAGE_SIZE,offset).all<T>();rows.push(...(page.results||[]))}
  if(rows.length!==expected)throw new Error(`${label} 전체 건수 검증에 실패했습니다. 예상 ${expected}건, 추출 ${rows.length}건입니다. 입력 작업이 끝난 뒤 다시 시도해 주세요.`);
  return {rows,expected};
};
const calcAsset = (row: any, asOf: Date) => {
  const cost = Number(row.acquisition_cost || 0);
  const residual = Number(row.residual_value || 0);
  const life = Number(row.useful_life_months || 0);
  if (row.depreciation_method === 'nondepreciable' || life <= 0) return { accumulated: 0, bookValue: cost };
  const start = new Date(`${row.acquisition_date}T00:00:00Z`);
  const months = Math.max(0, Math.min(life, (asOf.getUTCFullYear() - start.getUTCFullYear()) * 12 + asOf.getUTCMonth() - start.getUTCMonth() + 1));
  const depreciable = Math.max(0, cost - residual);
  const accumulated = Math.min(depreciable, Math.round((depreciable / life) * months));
  return { accumulated, bookValue: Math.max(residual, cost - accumulated) };
};

const summaryStatement = (db: D1Database, year: number) => db.prepare(`SELECT
  (SELECT COUNT(*) FROM accounting_entities WHERE active=1) AS entity_count,
  (SELECT COUNT(*) FROM accounting_donors WHERE active=1) AS donor_count,
  (SELECT COALESCE(SUM(amount),0) FROM accounting_donations WHERE fiscal_year=?) AS donation_total,
  (SELECT COUNT(*) FROM accounting_donations WHERE fiscal_year=? AND receipt_status='requested') AS receipt_pending,
  (SELECT COUNT(*) FROM accounting_assets WHERE status='in_use') AS asset_count,
  (SELECT COALESCE(SUM(acquisition_cost),0) FROM accounting_assets WHERE status='in_use') AS asset_cost,
  (SELECT COUNT(*) FROM accounting_card_transactions WHERE status='unmatched') AS unmatched_cards,
  (SELECT COUNT(*) FROM accounting_branch_reports WHERE fiscal_year=? AND status='submitted') AS submitted_reports`)
  .bind(year, year, year);

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB || !env.ACCOUNTING_DB) return json({ ok: false, message: '전자문서 DB 또는 회계 전용 DB가 연결되지 않았습니다.' }, 500);
  let payload: Payload;
  try { payload = await request.json(); }
  catch { return json({ ok: false, message: '요청 형식이 올바르지 않습니다.' }, 400); }
  const accountingDb=env.ACCOUNTING_DB;
  await ensureTables(env.DB);
  const auth = await authenticateSession(env.DB, clean(payload.token, 200));
  if (!auth.ok) return json({ ok: false, message: auth.message }, auth.status);
  if (!hasAccountingAccess(auth.user)) return json({ ok: false, message: '종단 회계관리 접속 권한이 없습니다. 관리자에게 회계권한 부여를 요청해 주세요.' }, 403);
  await ensureAccountingTables(accountingDb);
  await ensureAccountingSpecialTables(accountingDb);
  const me = auth.user;
  const action = clean(payload.action, 60) || 'init';
  const year = toYear(payload.year);
  const canViewAll = canViewAllAccounting(me);
  const manager = isAccountingManager(me);

  try {
    if (action === 'init') {
      const master = await getDimensionMaster(accountingDb);
      const [accountingResults, chairpersons] = await Promise.all([
        accountingDb.batch([
          summaryStatement(accountingDb, year),
          accountingDb.prepare(`SELECT year,name,start_date,end_date,base_currency,status FROM accounting_fiscal_years ORDER BY year`),
          accountingDb.prepare(`SELECT code,name,account_type,normal_side,parent_code,active,system_account FROM accounting_accounts WHERE active=1 ORDER BY code`),
        ]),
        env.DB.prepare(`SELECT CAST(id AS TEXT) AS id,name,position,department
          FROM system_users WHERE active=1 AND (COALESCE(position,'') LIKE '%이사장%' OR COALESCE(department,'') LIKE '%이사장%')
          ORDER BY name`).all(),
      ]);
      const [summary, fiscalYears, accounts] = accountingResults;
      return json({
        ok: true,
        me,
        permissions: { manager, canViewAll, audit: me.role === 'audit' },
        year,
        ...master,
        summary: summary.results?.[0] || {},
        donors: [],
        donations: [],
        assets: [],
        cards: [],
        cardTransactions: [],
        cardPayments: [],
        branchReports: [],
        fiscalYears: fiscalYears.results || [],
        accounts: accounts.results || [],
        chairpersons: chairpersons.results || [],
      });
    }

    if (action === 'summary') {
      const result = await summaryStatement(accountingDb, year).all();
      return json({ ok: true, summary: result.results?.[0] || {} });
    }

    if (action === 'master') return json({ ok: true, ...(await getDimensionMaster(accountingDb)) });

    if (action === 'donors') {
      const q = clean(payload.query, 120);
      const limit=requestedLimit(payload.limit);
      const rows = await accountingDb.prepare(`SELECT * FROM accounting_donors WHERE active=1
        ${q ? 'AND (name LIKE ? OR donor_no LIKE ? OR phone LIKE ?)' : ''}
        ORDER BY created_at DESC LIMIT ${limit}`)
        .bind(...(q ? [`%${q}%`, `%${q}%`, `%${q}%`] : [])).all();
      return json({ ok: true, rows: rows.results || [] });
    }

    if (action === 'donations' || action === 'donations-export') {
      const limit=requestedLimit(payload.limit);
      const conditions = ['d.fiscal_year=?'];
      const values: unknown[] = [year];
      const q = clean(payload.query, 120);
      const entityId = clean(payload.entityId, 80);
      const fundId = clean(payload.fundId, 80);
      const bookTypeCode = clean(payload.bookTypeCode, 30);
      const receiptStatus = clean(payload.receiptStatus, 30);
      if (entityId) { conditions.push('d.entity_id=?'); values.push(entityId); }
      if (fundId) { conditions.push('d.fund_id=?'); values.push(fundId); }
      if (bookTypeCode) { conditions.push('d.book_type_code=?'); values.push(bookTypeCode); }
      if (receiptStatus) { conditions.push('d.receipt_status=?'); values.push(receiptStatus); }
      if (q) { conditions.push(`(d.donation_no LIKE ? OR o.name LIKE ? OR d.purpose LIKE ?)`); values.push(`%${q}%`, `%${q}%`, `%${q}%`); }
      const selectSql = `SELECT d.*,COALESCE(o.name,'익명') AS donor_name,o.donor_no,
          b.name AS book_type_name,e.name AS entity_name,f.name AS fund_name
        FROM accounting_donations d LEFT JOIN accounting_donors o ON o.id=d.donor_id
        LEFT JOIN accounting_book_types b ON b.code=d.book_type_code
        LEFT JOIN accounting_entities e ON e.id=d.entity_id LEFT JOIN accounting_funds f ON f.id=d.fund_id
        WHERE ${conditions.join(' AND ')}`;
      const orderBy='ORDER BY d.donation_date DESC,d.created_at DESC,d.donation_no DESC,d.id DESC';
      if(action==='donations-export'){const exported=await fetchCompleteRows<any>(accountingDb,selectSql,values,orderBy,'기부금 내보내기 자료');return json({ok:true,rows:exported.rows,expectedCount:exported.expected,complete:true})}
      const rows=await accountingDb.prepare(`${selectSql} ${orderBy} LIMIT ${limit}`).bind(...values).all();
      return json({ ok: true, rows: rows.results || [], limit, complete: false });
    }

    if (action === 'receipt-detail') {
      const id = clean(payload.id, 80);
      const row = await accountingDb.prepare(`SELECT d.*,o.donor_no,o.name AS donor_name,o.donor_type,
          o.identifier_masked,o.address AS donor_address,o.phone AS donor_phone,
          e.name AS entity_name,e.registration_no,e.representative,e.address AS entity_address,f.name AS fund_name,
          COALESCE(NULLIF(d.receipt_org_name,''),e.name) AS resolved_receipt_org_name,
          COALESCE(NULLIF(d.receipt_org_registration_no,''),e.registration_no) AS resolved_receipt_org_registration_no,
          COALESCE(NULLIF(d.receipt_org_address,''),e.address) AS resolved_receipt_org_address,
          COALESCE(NULLIF(d.receipt_issuer_name,''),e.representative) AS resolved_receipt_issuer_name
        FROM accounting_donations d JOIN accounting_donors o ON o.id=d.donor_id
        LEFT JOIN accounting_entities e ON e.id=d.entity_id LEFT JOIN accounting_funds f ON f.id=d.fund_id
        WHERE d.id=?`).bind(id).first();
      return row ? json({ ok: true, row }) : json({ ok: false, message: '영수증 자료를 찾을 수 없습니다.' }, 404);
    }

    if (action === 'assets' || action === 'assets-export') {
      const limit=requestedLimit(payload.limit);
      const entityId = clean(payload.entityId, 80);
      const status = clean(payload.status, 30);
      const conditions = ['1=1'];
      const values: unknown[] = [];
      if (entityId) { conditions.push('a.entity_id=?'); values.push(entityId); }
      if (status) { conditions.push('a.status=?'); values.push(status); }
      const selectSql = `SELECT a.*,b.name AS book_type_name,e.name AS entity_name,f.name AS fund_name
        FROM accounting_assets a LEFT JOIN accounting_book_types b ON b.code=a.book_type_code
        LEFT JOIN accounting_entities e ON e.id=a.entity_id LEFT JOIN accounting_funds f ON f.id=a.fund_id
        WHERE ${conditions.join(' AND ')}`;
      const orderBy='ORDER BY a.status,a.acquisition_date DESC,a.asset_no,a.id';
      const exported=action==='assets-export'?await fetchCompleteRows<any>(accountingDb,selectSql,values,orderBy,'자산 내보내기 자료'):null;
      const rows=exported?.rows||((await accountingDb.prepare(`${selectSql} ${orderBy} LIMIT ${limit}`).bind(...values).all<any>()).results||[]);
      const asOf = new Date(`${year}-12-31T00:00:00Z`);
      return json({ ok: true, rows: rows.map((row:any) => ({ ...row, ...calcAsset(row, asOf) })),
        expectedCount: exported?.expected, limit: action==='assets-export'?null:limit, complete: action === 'assets-export' });
    }

    if (action === 'cards') {
      await ensureAccountingTaxTables(accountingDb);
      const limit=requestedLimit(payload.limit);
      const [cards, transactions, payments] = await accountingDb.batch([
        accountingDb.prepare(`SELECT c.*,b.name AS book_type_name,e.name AS entity_name,
          (SELECT COUNT(*) FROM accounting_card_transactions t WHERE t.card_id=c.id) AS transaction_count,
          COALESCE((SELECT SUM(t.amount) FROM accounting_card_transactions t
            JOIN accounting_journals tj ON tj.id=t.journal_id
            WHERE t.card_id=c.id AND tj.status='posted'),0) AS posted_amount,
          COALESCE((SELECT SUM(p.amount) FROM accounting_card_payments p JOIN accounting_journals j ON j.id=p.journal_id
            WHERE p.card_id=c.id AND j.status='posted'),0) AS paid_amount
          FROM accounting_cards c
          LEFT JOIN accounting_book_types b ON b.code=c.book_type_code LEFT JOIN accounting_entities e ON e.id=c.entity_id
          WHERE c.active=1 ORDER BY c.card_code`),
        accountingDb.prepare(`SELECT t.*,c.card_label,c.masked_number,a.name AS account_name,e.name AS entity_name,f.name AS fund_name,
          j.status AS journal_status
          FROM accounting_card_transactions t JOIN accounting_cards c ON c.id=t.card_id
          LEFT JOIN accounting_accounts a ON a.code=t.account_code LEFT JOIN accounting_entities e ON e.id=t.entity_id
          LEFT JOIN accounting_funds f ON f.id=t.fund_id LEFT JOIN accounting_journals j ON j.id=t.journal_id
          WHERE t.transaction_date>=? AND t.transaction_date<? ORDER BY t.transaction_date DESC,t.created_at DESC LIMIT ${limit}`).bind(`${year}-01-01`, `${year+1}-01-01`),
        accountingDb.prepare(`SELECT p.*,c.card_code,c.card_label,c.issuer,c.masked_number,
          pa.name AS payable_account_name,ba.name AS bank_account_name,e.name AS entity_name,f.name AS fund_name,j.journal_no,j.status AS journal_status
          FROM accounting_card_payments p JOIN accounting_cards c ON c.id=p.card_id
          JOIN accounting_journals j ON j.id=p.journal_id
          LEFT JOIN accounting_accounts pa ON pa.code=p.payable_account_code LEFT JOIN accounting_accounts ba ON ba.code=p.bank_account_code
          LEFT JOIN accounting_entities e ON e.id=p.entity_id LEFT JOIN accounting_funds f ON f.id=p.fund_id
          WHERE p.fiscal_year=? ORDER BY p.payment_date DESC,p.created_at DESC LIMIT ${limit}`).bind(year),
      ]);
      return json({ ok: true, cards: (cards.results || []).map((row:any)=>({ ...row,
        outstanding_amount: Number(row.posted_amount||0)-Number(row.paid_amount||0) })),
        transactions: transactions.results || [], payments: payments.results || [] });
    }

    if (action === 'branch-reports') {
      const limit=requestedLimit(payload.limit);
      const rows = await accountingDb.prepare(`SELECT r.*,e.name AS entity_name,b.name AS book_type_name
        FROM accounting_branch_reports r LEFT JOIN accounting_entities e ON e.id=r.entity_id
        LEFT JOIN accounting_book_types b ON b.code=r.book_type_code
        WHERE r.fiscal_year=? ORDER BY r.period_type,r.period_key,e.name LIMIT ${limit}`).bind(year).all();
      return json({ ok: true, rows: rows.results || [] });
    }

    if (action === 'consolidated-report') {
      if (!canViewAll) return json({ ok: false, message: '종단 취합자료 조회 권한이 없습니다.' }, 403);
      const periodType = clean(payload.periodType, 20) || 'annual';
      const periodKey = clean(payload.periodKey, 20) || String(year);
      const rows = await accountingDb.prepare(`SELECT r.id,e.entity_type,e.entity_code,e.name AS entity_name,b.name AS book_type_name,
          r.income_total,r.expense_total,r.asset_total,r.liability_total,r.cash_balance,r.donation_total,r.status
        FROM accounting_branch_reports r JOIN accounting_entities e ON e.id=r.entity_id
        JOIN accounting_book_types b ON b.code=r.book_type_code
        WHERE r.fiscal_year=? AND r.period_type=? AND r.period_key=? AND r.status IN ('submitted','confirmed')
        ORDER BY e.entity_type,e.entity_code,b.code`).bind(year, periodType, periodKey).all<any>();
      const totals = (rows.results || []).reduce((acc: any, row: any) => {
        ['income_total', 'expense_total', 'asset_total', 'liability_total', 'cash_balance', 'donation_total']
          .forEach((key) => { acc[key] += Number(row[key] || 0); });
        return acc;
      }, { income_total: 0, expense_total: 0, asset_total: 0, liability_total: 0, cash_balance: 0, donation_total: 0 });
      return json({ ok: true, rows: rows.results || [], totals });
    }

    if (action === 'special-summary') {
      if (!canViewAll) return json({ ok: false, message: '특화 결산자료 조회 권한이 없습니다.' }, 403);
      const [byBook, byEntity, byFund, donationByCategory, assetSummary, cardSummary] = await accountingDb.batch([
        accountingDb.prepare(`SELECT s.book_type_code AS code,b.name,
          COALESCE(SUM(CASE WHEN a.account_type='revenue' THEN s.credit_total-s.debit_total ELSE 0 END),0) AS income,
          COALESCE(SUM(CASE WHEN a.account_type='expense' THEN s.debit_total-s.credit_total ELSE 0 END),0) AS expense
          FROM accounting_monthly_summary s JOIN accounting_accounts a ON a.code=s.account_code
          LEFT JOIN accounting_book_types b ON b.code=s.book_type_code
          WHERE s.fiscal_year=? GROUP BY s.book_type_code,b.name ORDER BY code`).bind(year),
        accountingDb.prepare(`SELECT s.entity_id AS id,e.name,
          COALESCE(SUM(CASE WHEN a.account_type='revenue' THEN s.credit_total-s.debit_total ELSE 0 END),0) AS income,
          COALESCE(SUM(CASE WHEN a.account_type='expense' THEN s.debit_total-s.credit_total ELSE 0 END),0) AS expense
          FROM accounting_monthly_summary s JOIN accounting_accounts a ON a.code=s.account_code
          LEFT JOIN accounting_entities e ON e.id=s.entity_id
          WHERE s.fiscal_year=? GROUP BY s.entity_id,e.name ORDER BY e.name`).bind(year),
        accountingDb.prepare(`SELECT CASE WHEN s.fund_id='' THEN 'NO-FUND' ELSE s.fund_id END AS id,
          COALESCE(f.name,'재원 미지정') AS name,
          COALESCE(SUM(CASE WHEN a.account_type='revenue' THEN s.credit_total-s.debit_total ELSE 0 END),0) AS income,
          COALESCE(SUM(CASE WHEN a.account_type='expense' THEN s.debit_total-s.credit_total ELSE 0 END),0) AS expense
          FROM accounting_monthly_summary s JOIN accounting_accounts a ON a.code=s.account_code
          LEFT JOIN accounting_funds f ON f.id=NULLIF(s.fund_id,'')
          WHERE s.fiscal_year=? GROUP BY s.fund_id,COALESCE(f.name,'재원 미지정') ORDER BY name`).bind(year),
        accountingDb.prepare(`SELECT donation_category,COUNT(*) AS count,COALESCE(SUM(amount),0) AS amount
          FROM accounting_donations WHERE fiscal_year=? GROUP BY donation_category ORDER BY donation_category`).bind(year),
        accountingDb.prepare(`SELECT category,COUNT(*) AS count,COALESCE(SUM(acquisition_cost),0) AS acquisition_cost
          FROM accounting_assets WHERE status='in_use' GROUP BY category ORDER BY category`),
        accountingDb.prepare(`SELECT status,COUNT(*) AS count,COALESCE(SUM(amount),0) AS amount
          FROM accounting_card_transactions WHERE transaction_date>=? AND transaction_date<? GROUP BY status ORDER BY status`).bind(`${year}-01-01`, `${year+1}-01-01`),
      ]);
      return json({
        ok: true,
        byBook: byBook.results || [],
        byEntity: byEntity.results || [],
        byFund: byFund.results || [],
        donationByCategory: donationByCategory.results || [],
        assetSummary: assetSummary.results || [],
        cardSummary: cardSummary.results || [],
      });
    }

    return json({ ok: false, message: '지원하지 않는 종단 특화회계 조회입니다.' }, 400);
  } catch (error) {
    console.error('accounting-special query failed', action, error);
    return json({ ok: false, message: '종단 특화회계 자료 조회 중 오류가 발생했습니다.' }, 500);
  }
};

export const onRequestGet: PagesFunction = async () => json({ ok: false, message: 'POST 방식으로 요청해 주세요.' }, 405);
