import { authenticateSession, clean, ensureTables, json } from '../../_shared/helpers';
import { canViewAllAccounting, ensureAccountingTables, isAccountingManager } from '../../_shared/accounting';
import { ensureAccountingSpecialTables, getDimensionMaster } from '../../_shared/accounting-special';

interface Env { DB: D1Database; }
type Payload = Record<string, unknown> & { token?: string; action?: string };
const toYear = (value: unknown) => {
  const current = new Date(Date.now() + 9 * 60 * 60 * 1000).getUTCFullYear();
  const year = Number(value || current);
  return year >= 2000 && year <= 2200 ? year : current;
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

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB) return json({ ok: false, message: 'DB가 연결되지 않았습니다.' }, 500);
  let payload: Payload;
  try { payload = await request.json(); }
  catch { return json({ ok: false, message: '요청 형식이 올바르지 않습니다.' }, 400); }
  await ensureTables(env.DB);
  await ensureAccountingTables(env.DB);
  await ensureAccountingSpecialTables(env.DB);
  const auth = await authenticateSession(env.DB, clean(payload.token, 200));
  if (!auth.ok) return json({ ok: false, message: auth.message }, auth.status);
  const me = auth.user;
  const action = clean(payload.action, 60) || 'init';
  const year = toYear(payload.year);
  const canViewAll = canViewAllAccounting(me);
  const manager = isAccountingManager(me);

  try {
    if (action === 'init') {
      const master = await getDimensionMaster(env.DB);
      const [summary, donors, donations, assets, cards, cardTransactions, branchReports, fiscalYears, accounts] = await env.DB.batch([
        env.DB.prepare(`SELECT
          (SELECT COUNT(*) FROM accounting_entities WHERE active=1) AS entity_count,
          (SELECT COUNT(*) FROM accounting_donors WHERE active=1) AS donor_count,
          (SELECT COALESCE(SUM(amount),0) FROM accounting_donations WHERE fiscal_year=?) AS donation_total,
          (SELECT COUNT(*) FROM accounting_donations WHERE fiscal_year=? AND receipt_status='requested') AS receipt_pending,
          (SELECT COUNT(*) FROM accounting_assets WHERE status='in_use') AS asset_count,
          (SELECT COALESCE(SUM(acquisition_cost),0) FROM accounting_assets WHERE status='in_use') AS asset_cost,
          (SELECT COUNT(*) FROM accounting_card_transactions WHERE status='unmatched') AS unmatched_cards,
          (SELECT COUNT(*) FROM accounting_branch_reports WHERE fiscal_year=? AND status='submitted') AS submitted_reports`)
          .bind(year, year, year),
        env.DB.prepare(`SELECT * FROM accounting_donors WHERE active=1 ORDER BY created_at DESC LIMIT 200`),
        env.DB.prepare(`SELECT d.*,COALESCE(o.name,'익명') AS donor_name,b.name AS book_type_name,e.name AS entity_name,f.name AS fund_name
          FROM accounting_donations d
          LEFT JOIN accounting_donors o ON o.id=d.donor_id
          LEFT JOIN accounting_book_types b ON b.code=d.book_type_code
          LEFT JOIN accounting_entities e ON e.id=d.entity_id
          LEFT JOIN accounting_funds f ON f.id=d.fund_id
          WHERE d.fiscal_year=? ORDER BY d.donation_date DESC,d.created_at DESC LIMIT 200`).bind(year),
        env.DB.prepare(`SELECT a.*,b.name AS book_type_name,e.name AS entity_name,f.name AS fund_name
          FROM accounting_assets a LEFT JOIN accounting_book_types b ON b.code=a.book_type_code
          LEFT JOIN accounting_entities e ON e.id=a.entity_id LEFT JOIN accounting_funds f ON f.id=a.fund_id
          ORDER BY a.status,a.acquisition_date DESC LIMIT 300`),
        env.DB.prepare(`SELECT c.*,b.name AS book_type_name,e.name AS entity_name FROM accounting_cards c
          LEFT JOIN accounting_book_types b ON b.code=c.book_type_code LEFT JOIN accounting_entities e ON e.id=c.entity_id
          WHERE c.active=1 ORDER BY c.card_code`),
        env.DB.prepare(`SELECT t.*,c.card_label,c.masked_number,a.name AS account_name,e.name AS entity_name,f.name AS fund_name
          FROM accounting_card_transactions t JOIN accounting_cards c ON c.id=t.card_id
          LEFT JOIN accounting_accounts a ON a.code=t.account_code LEFT JOIN accounting_entities e ON e.id=t.entity_id
          LEFT JOIN accounting_funds f ON f.id=t.fund_id
          WHERE substr(t.transaction_date,1,4)=? ORDER BY t.transaction_date DESC,t.created_at DESC LIMIT 300`).bind(String(year)),
        env.DB.prepare(`SELECT r.*,e.name AS entity_name,b.name AS book_type_name FROM accounting_branch_reports r
          LEFT JOIN accounting_entities e ON e.id=r.entity_id LEFT JOIN accounting_book_types b ON b.code=r.book_type_code
          WHERE r.fiscal_year=? ORDER BY r.period_type,r.period_key,e.name`).bind(year),
        env.DB.prepare(`SELECT year,name,start_date,end_date,base_currency,status FROM accounting_fiscal_years ORDER BY year`),
        env.DB.prepare(`SELECT code,name,account_type,normal_side,parent_code,active,system_account FROM accounting_accounts WHERE active=1 ORDER BY code`),
      ]);
      const asOf = new Date(`${year}-12-31T00:00:00Z`);
      const assetRows = (assets.results || []).map((row: any) => ({ ...row, ...calcAsset(row, asOf) }));
      return json({
        ok: true,
        me,
        permissions: { manager, canViewAll, audit: me.role === 'audit' },
        year,
        ...master,
        summary: summary.results?.[0] || {},
        donors: donors.results || [],
        donations: donations.results || [],
        assets: assetRows,
        cards: cards.results || [],
        cardTransactions: cardTransactions.results || [],
        branchReports: branchReports.results || [],
        fiscalYears: fiscalYears.results || [],
        accounts: accounts.results || [],
      });
    }

    if (action === 'master') return json({ ok: true, ...(await getDimensionMaster(env.DB)) });

    if (action === 'donors') {
      const q = clean(payload.query, 120);
      const rows = await env.DB.prepare(`SELECT * FROM accounting_donors WHERE active=1
        ${q ? 'AND (name LIKE ? OR donor_no LIKE ? OR phone LIKE ?)' : ''}
        ORDER BY created_at DESC LIMIT 1000`)
        .bind(...(q ? [`%${q}%`, `%${q}%`, `%${q}%`] : [])).all();
      return json({ ok: true, rows: rows.results || [] });
    }

    if (action === 'donations') {
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
      const rows = await env.DB.prepare(`SELECT d.*,COALESCE(o.name,'익명') AS donor_name,o.donor_no,
          b.name AS book_type_name,e.name AS entity_name,f.name AS fund_name
        FROM accounting_donations d LEFT JOIN accounting_donors o ON o.id=d.donor_id
        LEFT JOIN accounting_book_types b ON b.code=d.book_type_code
        LEFT JOIN accounting_entities e ON e.id=d.entity_id LEFT JOIN accounting_funds f ON f.id=d.fund_id
        WHERE ${conditions.join(' AND ')} ORDER BY d.donation_date DESC,d.created_at DESC LIMIT 1000`)
        .bind(...values).all();
      return json({ ok: true, rows: rows.results || [] });
    }

    if (action === 'receipt-detail') {
      const id = clean(payload.id, 80);
      const row = await env.DB.prepare(`SELECT d.*,o.donor_no,o.name AS donor_name,o.donor_type,o.identifier_masked,o.address,
          e.name AS entity_name,e.registration_no,e.representative,e.address AS entity_address,f.name AS fund_name
        FROM accounting_donations d JOIN accounting_donors o ON o.id=d.donor_id
        LEFT JOIN accounting_entities e ON e.id=d.entity_id LEFT JOIN accounting_funds f ON f.id=d.fund_id
        WHERE d.id=?`).bind(id).first();
      return row ? json({ ok: true, row }) : json({ ok: false, message: '영수증 자료를 찾을 수 없습니다.' }, 404);
    }

    if (action === 'assets') {
      const entityId = clean(payload.entityId, 80);
      const status = clean(payload.status, 30);
      const conditions = ['1=1'];
      const values: unknown[] = [];
      if (entityId) { conditions.push('a.entity_id=?'); values.push(entityId); }
      if (status) { conditions.push('a.status=?'); values.push(status); }
      const rows = await env.DB.prepare(`SELECT a.*,b.name AS book_type_name,e.name AS entity_name,f.name AS fund_name
        FROM accounting_assets a LEFT JOIN accounting_book_types b ON b.code=a.book_type_code
        LEFT JOIN accounting_entities e ON e.id=a.entity_id LEFT JOIN accounting_funds f ON f.id=a.fund_id
        WHERE ${conditions.join(' AND ')} ORDER BY a.status,a.acquisition_date DESC`).bind(...values).all<any>();
      const asOf = new Date(`${year}-12-31T00:00:00Z`);
      return json({ ok: true, rows: (rows.results || []).map((row) => ({ ...row, ...calcAsset(row, asOf) })) });
    }

    if (action === 'cards') {
      const [cards, transactions] = await env.DB.batch([
        env.DB.prepare(`SELECT c.*,b.name AS book_type_name,e.name AS entity_name FROM accounting_cards c
          LEFT JOIN accounting_book_types b ON b.code=c.book_type_code LEFT JOIN accounting_entities e ON e.id=c.entity_id
          WHERE c.active=1 ORDER BY c.card_code`),
        env.DB.prepare(`SELECT t.*,c.card_label,c.masked_number,a.name AS account_name,e.name AS entity_name,f.name AS fund_name
          FROM accounting_card_transactions t JOIN accounting_cards c ON c.id=t.card_id
          LEFT JOIN accounting_accounts a ON a.code=t.account_code LEFT JOIN accounting_entities e ON e.id=t.entity_id
          LEFT JOIN accounting_funds f ON f.id=t.fund_id
          WHERE substr(t.transaction_date,1,4)=? ORDER BY t.transaction_date DESC,t.created_at DESC`).bind(String(year)),
      ]);
      return json({ ok: true, cards: cards.results || [], transactions: transactions.results || [] });
    }

    if (action === 'branch-reports') {
      const rows = await env.DB.prepare(`SELECT r.*,e.name AS entity_name,b.name AS book_type_name
        FROM accounting_branch_reports r LEFT JOIN accounting_entities e ON e.id=r.entity_id
        LEFT JOIN accounting_book_types b ON b.code=r.book_type_code
        WHERE r.fiscal_year=? ORDER BY r.period_type,r.period_key,e.name`).bind(year).all();
      return json({ ok: true, rows: rows.results || [] });
    }

    if (action === 'consolidated-report') {
      if (!canViewAll) return json({ ok: false, message: '종단 취합자료 조회 권한이 없습니다.' }, 403);
      const periodType = clean(payload.periodType, 20) || 'annual';
      const periodKey = clean(payload.periodKey, 20) || String(year);
      const rows = await env.DB.prepare(`SELECT e.entity_type,e.entity_code,e.name AS entity_name,b.name AS book_type_name,
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
      const [byBook, byEntity, byFund, donationByCategory, assetSummary, cardSummary] = await env.DB.batch([
        env.DB.prepare(`SELECT COALESCE(d.book_type_code,'general') AS code,b.name,
          COALESCE(SUM(CASE WHEN a.account_type='revenue' THEN l.credit-l.debit ELSE 0 END),0) AS income,
          COALESCE(SUM(CASE WHEN a.account_type='expense' THEN l.debit-l.credit ELSE 0 END),0) AS expense
          FROM accounting_journal_lines l JOIN accounting_journals j ON j.id=l.journal_id
          JOIN accounting_accounts a ON a.code=l.account_code
          LEFT JOIN accounting_journal_line_dimensions d ON d.journal_line_id=l.id
          LEFT JOIN accounting_book_types b ON b.code=COALESCE(d.book_type_code,'general')
          WHERE j.fiscal_year=? AND j.status IN ('posted','reversed')
          GROUP BY COALESCE(d.book_type_code,'general'),b.name ORDER BY code`).bind(year),
        env.DB.prepare(`SELECT COALESCE(d.entity_id,'ENTITY-HQ') AS id,e.name,
          COALESCE(SUM(CASE WHEN a.account_type='revenue' THEN l.credit-l.debit ELSE 0 END),0) AS income,
          COALESCE(SUM(CASE WHEN a.account_type='expense' THEN l.debit-l.credit ELSE 0 END),0) AS expense
          FROM accounting_journal_lines l JOIN accounting_journals j ON j.id=l.journal_id
          JOIN accounting_accounts a ON a.code=l.account_code
          LEFT JOIN accounting_journal_line_dimensions d ON d.journal_line_id=l.id
          LEFT JOIN accounting_entities e ON e.id=COALESCE(d.entity_id,'ENTITY-HQ')
          WHERE j.fiscal_year=? AND j.status IN ('posted','reversed')
          GROUP BY COALESCE(d.entity_id,'ENTITY-HQ'),e.name ORDER BY e.name`).bind(year),
        env.DB.prepare(`SELECT COALESCE(NULLIF(d.fund_id,''),'NO-FUND') AS id,COALESCE(f.name,'재원 미지정') AS name,
          COALESCE(SUM(CASE WHEN a.account_type='revenue' THEN l.credit-l.debit ELSE 0 END),0) AS income,
          COALESCE(SUM(CASE WHEN a.account_type='expense' THEN l.debit-l.credit ELSE 0 END),0) AS expense
          FROM accounting_journal_lines l JOIN accounting_journals j ON j.id=l.journal_id
          JOIN accounting_accounts a ON a.code=l.account_code
          LEFT JOIN accounting_journal_line_dimensions d ON d.journal_line_id=l.id
          LEFT JOIN accounting_funds f ON f.id=d.fund_id
          WHERE j.fiscal_year=? AND j.status IN ('posted','reversed')
          GROUP BY COALESCE(NULLIF(d.fund_id,''),'NO-FUND'),COALESCE(f.name,'재원 미지정') ORDER BY name`).bind(year),
        env.DB.prepare(`SELECT donation_category,COUNT(*) AS count,COALESCE(SUM(amount),0) AS amount
          FROM accounting_donations WHERE fiscal_year=? GROUP BY donation_category ORDER BY donation_category`).bind(year),
        env.DB.prepare(`SELECT category,COUNT(*) AS count,COALESCE(SUM(acquisition_cost),0) AS acquisition_cost
          FROM accounting_assets WHERE status='in_use' GROUP BY category ORDER BY category`),
        env.DB.prepare(`SELECT status,COUNT(*) AS count,COALESCE(SUM(amount),0) AS amount
          FROM accounting_card_transactions WHERE substr(transaction_date,1,4)=? GROUP BY status ORDER BY status`).bind(String(year)),
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
