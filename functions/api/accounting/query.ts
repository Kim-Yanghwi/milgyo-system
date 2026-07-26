import { authenticateSession, clean, ensureTables, json } from '../../_shared/helpers';
import { canViewAllAccounting, ensureAccountingTables, isAccountingManager } from '../../_shared/accounting';
import { getDimensionMaster } from '../../_shared/accounting-special';

interface Env { DB: D1Database; }
type Payload = { token?: string; action?: string; year?: number; month?: number; accountCode?: string; id?: string; status?: string; department?: string; project?: string; query?: string; bookTypeCode?: string; entityId?: string; fundId?: string };

const toYear = (value: unknown) => {
  const current = new Date(Date.now() + 9 * 60 * 60 * 1000).getUTCFullYear();
  const year = Number(value || current);
  return year >= 2000 && year <= 2200 ? year : current;
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB) return json({ ok:false, message:'DB가 연결되지 않았습니다.' },500);
  let payload: Payload;
  try { payload = await request.json(); } catch { return json({ok:false,message:'요청 형식이 올바르지 않습니다.'},400); }
  await ensureTables(env.DB);
  await ensureAccountingTables(env.DB);
  const auth = await authenticateSession(env.DB, clean(payload.token,200));
  if (!auth.ok) return json({ok:false,message:auth.message},auth.status);
  const me = auth.user;
  const action = clean(payload.action,40) || 'init';
  const year = toYear(payload.year);
  const canViewAll = canViewAllAccounting(me);
  const manager = isAccountingManager(me);

  try {
    if (action === 'init') {
      const [fiscal, accounts, summaryRows, recentRows, closingRows] = await env.DB.batch([
        env.DB.prepare(`SELECT year,name,start_date,end_date,base_currency,status,closed_at FROM accounting_fiscal_years ORDER BY year DESC`),
        env.DB.prepare(`SELECT code,name,account_type,normal_side,parent_code,active,system_account FROM accounting_accounts WHERE active=1 ORDER BY code`),
        env.DB.prepare(`SELECT
          COALESCE(SUM(CASE WHEN a.account_type='revenue' THEN l.credit-l.debit ELSE 0 END),0) AS income,
          COALESCE(SUM(CASE WHEN a.account_type='expense' THEN l.debit-l.credit ELSE 0 END),0) AS expense,
          COALESCE(SUM(l.debit),0) AS total_debit,
          COALESCE(SUM(l.credit),0) AS total_credit
          FROM accounting_journals j
          JOIN accounting_journal_lines l ON l.journal_id=j.id
          JOIN accounting_accounts a ON a.code=l.account_code
          WHERE j.fiscal_year=? AND j.status IN ('posted','reversed')`).bind(year),
        canViewAll
          ? env.DB.prepare(`SELECT r.*, a.name AS account_name, s.name AS settlement_account_name FROM accounting_resolutions r
              LEFT JOIN accounting_accounts a ON a.code=r.account_code LEFT JOIN accounting_accounts s ON s.code=r.settlement_account_code
              WHERE r.fiscal_year=? ORDER BY r.created_at DESC LIMIT 8`).bind(year)
          : env.DB.prepare(`SELECT r.*, a.name AS account_name, s.name AS settlement_account_name FROM accounting_resolutions r
              LEFT JOIN accounting_accounts a ON a.code=r.account_code LEFT JOIN accounting_accounts s ON s.code=r.settlement_account_code
              WHERE r.fiscal_year=? AND r.created_by_user_id=? ORDER BY r.created_at DESC LIMIT 8`).bind(year,me.id),
        env.DB.prepare(`SELECT period_month,status,closed_by,closed_at,memo FROM accounting_closings WHERE fiscal_year=? ORDER BY period_month`).bind(year),
      ]);
      const summary = summaryRows.results?.[0] || {income:0,expense:0,total_debit:0,total_credit:0};
      const dimensions=await getDimensionMaster(env.DB);
      return json({
        ok:true, me, permissions:{manager,canViewAll,audit:me.role==='audit'}, year,
        fiscalYears:fiscal.results||[], accounts:accounts.results||[], summary,
        recentResolutions:recentRows.results||[], closings:closingRows.results||[],...dimensions,
      });
    }

    if (action === 'accounts') {
      const rows = await env.DB.prepare(`SELECT code,name,account_type,normal_side,parent_code,active,system_account,created_at,updated_at
        FROM accounting_accounts ORDER BY code`).all();
      return json({ok:true,rows:rows.results||[]});
    }

    if (action === 'budgets' || action === 'budget-execution') {
      const department = clean(payload.department,80);
      const project = clean(payload.project,100);
      const bookTypeCode=clean(payload.bookTypeCode,30);
      const entityId=clean(payload.entityId,80);
      const fundId=clean(payload.fundId,80);
      const conditions = ['b.fiscal_year=?']; const values: unknown[] = [year];
      if (department) { conditions.push('b.department=?'); values.push(department); }
      if (project) { conditions.push('b.project=?'); values.push(project); }
      if (bookTypeCode) { conditions.push('b.book_type_code=?'); values.push(bookTypeCode); }
      if (entityId) { conditions.push('b.entity_id=?'); values.push(entityId); }
      if (fundId) { conditions.push('b.fund_id=?'); values.push(fundId); }
      const statement = env.DB.prepare(`SELECT b.*, a.name AS account_name,
        bt.name AS book_type_name,e.name AS entity_name,f.name AS fund_name,
        (b.original_amount+b.supplementary_amount+b.transfer_in-b.transfer_out) AS revised_amount,
        COALESCE((SELECT SUM(l.debit-l.credit) FROM accounting_journal_lines l
          JOIN accounting_journals j ON j.id=l.journal_id
          LEFT JOIN accounting_journal_line_dimensions d ON d.journal_line_id=l.id
          WHERE j.status IN ('posted','reversed') AND j.fiscal_year=b.fiscal_year AND l.account_code=b.account_code
            AND l.department=b.department AND l.project=b.project
            AND COALESCE(d.book_type_code,'general')=b.book_type_code
            AND COALESCE(d.entity_id,'ENTITY-HQ')=b.entity_id
            AND COALESCE(d.fund_id,'')=b.fund_id),0) AS executed_amount
        FROM accounting_budget_plans b JOIN accounting_accounts a ON a.code=b.account_code
        LEFT JOIN accounting_book_types bt ON bt.code=b.book_type_code
        LEFT JOIN accounting_entities e ON e.id=b.entity_id
        LEFT JOIN accounting_funds f ON f.id=b.fund_id
        WHERE ${conditions.join(' AND ')} ORDER BY b.book_type_code,e.name,f.name,b.department,b.project,b.account_code`);
      const rows = await statement.bind(...values).all();
      return json({ok:true,rows:rows.results||[]});
    }

    if (action === 'resolutions') {
      const conditions = ['r.fiscal_year=?']; const values: unknown[] = [year];
      if (!canViewAll) { conditions.push('r.created_by_user_id=?'); values.push(me.id); }
      const status = clean(payload.status,30); if (status) { conditions.push('r.status=?'); values.push(status); }
      const q = clean(payload.query,120); if (q) { conditions.push(`(r.title LIKE ? OR r.counterparty LIKE ? OR r.resolution_no LIKE ?)`); values.push(`%${q}%`,`%${q}%`,`%${q}%`); }
      const rows = await env.DB.prepare(`SELECT r.*, a.name AS account_name, s.name AS settlement_account_name,
          d.status AS document_status,COALESCE(rd.book_type_code,'general') AS book_type_code,
          COALESCE(rd.entity_id,'ENTITY-HQ') AS entity_id,COALESCE(rd.fund_id,'') AS fund_id,
          bt.name AS book_type_name,e.name AS entity_name,f.name AS fund_name
        FROM accounting_resolutions r
        LEFT JOIN accounting_accounts a ON a.code=r.account_code
        LEFT JOIN accounting_accounts s ON s.code=r.settlement_account_code
        LEFT JOIN documents d ON d.id=r.document_id
        LEFT JOIN accounting_resolution_dimensions rd ON rd.resolution_id=r.id
        LEFT JOIN accounting_book_types bt ON bt.code=COALESCE(rd.book_type_code,'general')
        LEFT JOIN accounting_entities e ON e.id=COALESCE(rd.entity_id,'ENTITY-HQ')
        LEFT JOIN accounting_funds f ON f.id=rd.fund_id
        WHERE ${conditions.join(' AND ')} ORDER BY r.resolution_date DESC,r.created_at DESC LIMIT 500`).bind(...values).all();
      return json({ok:true,rows:rows.results||[]});
    }

    if (action === 'journals') {
      if (!canViewAll) return json({ok:false,message:'전표와 장부는 회계담당자·관리자·감사만 조회할 수 있습니다.'},403);
      const q = clean(payload.query,120);
      const rows = await env.DB.prepare(`SELECT j.*,
        COALESCE((SELECT SUM(debit) FROM accounting_journal_lines l WHERE l.journal_id=j.id),0) AS debit_total,
        COALESCE((SELECT SUM(credit) FROM accounting_journal_lines l WHERE l.journal_id=j.id),0) AS credit_total
        FROM accounting_journals j WHERE j.fiscal_year=? ${q ? 'AND (j.journal_no LIKE ? OR j.description LIKE ?)' : ''}
        ORDER BY j.journal_date DESC,j.created_at DESC LIMIT 1000`)
        .bind(...(q ? [year,`%${q}%`,`%${q}%`] : [year])).all();
      return json({ok:true,rows:rows.results||[]});
    }

    if (action === 'journal-detail') {
      if (!canViewAll) return json({ok:false,message:'전표를 조회할 권한이 없습니다.'},403);
      const id=clean(payload.id,80);
      const [journal,lines] = await env.DB.batch([
        env.DB.prepare(`SELECT * FROM accounting_journals WHERE id=?`).bind(id),
        env.DB.prepare(`SELECT l.*,a.name AS account_name,COALESCE(d.book_type_code,'general') AS book_type_code,COALESCE(d.entity_id,'ENTITY-HQ') AS entity_id,COALESCE(d.fund_id,'') AS fund_id FROM accounting_journal_lines l JOIN accounting_accounts a ON a.code=l.account_code LEFT JOIN accounting_journal_line_dimensions d ON d.journal_line_id=l.id WHERE l.journal_id=? ORDER BY l.line_no`).bind(id),
      ]);
      return json({ok:true,journal:journal.results?.[0]||null,lines:lines.results||[]});
    }

    if (action === 'ledger') {
      if (!canViewAll) return json({ok:false,message:'장부를 조회할 권한이 없습니다.'},403);
      const code=clean(payload.accountCode,20);
      if (!code) return json({ok:false,message:'계정과목을 선택해 주세요.'},400);
      const rows = await env.DB.prepare(`SELECT j.journal_no,j.journal_date,j.description,j.document_id,j.status,
          l.debit,l.credit,l.department,l.project,l.counterparty,l.memo,
          SUM(CASE WHEN a.normal_side='debit' THEN l.debit-l.credit ELSE l.credit-l.debit END)
            OVER (ORDER BY j.journal_date,j.created_at,l.line_no) AS running_balance
        FROM accounting_journal_lines l JOIN accounting_journals j ON j.id=l.journal_id
        JOIN accounting_accounts a ON a.code=l.account_code
        WHERE j.fiscal_year=? AND j.status IN ('posted','reversed') AND l.account_code=?
        ORDER BY j.journal_date,j.created_at,l.line_no`).bind(year,code).all();
      return json({ok:true,rows:rows.results||[]});
    }

    if (action === 'trial-balance' || action === 'statement') {
      if (!canViewAll) return json({ok:false,message:'결산자료를 조회할 권한이 없습니다.'},403);
      const rows = await env.DB.prepare(`SELECT a.code,a.name,a.account_type,a.normal_side,
          COALESCE(SUM(CASE WHEN j.status IN ('posted','reversed') THEN l.debit ELSE 0 END),0) AS debit,
          COALESCE(SUM(CASE WHEN j.status IN ('posted','reversed') THEN l.credit ELSE 0 END),0) AS credit,
          CASE WHEN a.normal_side='debit'
            THEN COALESCE(SUM(CASE WHEN j.status IN ('posted','reversed') THEN l.debit-l.credit ELSE 0 END),0)
            ELSE COALESCE(SUM(CASE WHEN j.status IN ('posted','reversed') THEN l.credit-l.debit ELSE 0 END),0) END AS balance
        FROM accounting_accounts a
        LEFT JOIN accounting_journal_lines l ON l.account_code=a.code
        LEFT JOIN accounting_journals j ON j.id=l.journal_id AND j.fiscal_year=?
        WHERE a.active=1 GROUP BY a.code,a.name,a.account_type,a.normal_side ORDER BY a.code`).bind(year).all();
      const allRows=(rows.results||[]) as any[];
      return json({ok:true,rows:action==='statement'?allRows.filter((r)=>['revenue','expense'].includes(r.account_type)):allRows});
    }

    if (action === 'closings') {
      const rows=await env.DB.prepare(`SELECT * FROM accounting_closings WHERE fiscal_year=? ORDER BY period_month`).bind(year).all();
      return json({ok:true,rows:rows.results||[]});
    }

    return json({ok:false,message:'지원하지 않는 조회입니다.'},400);
  } catch (error) {
    console.error('accounting query failed',action,error);
    return json({ok:false,message:'회계자료 조회 중 오류가 발생했습니다.'},500);
  }
};

export const onRequestGet: PagesFunction = async () => json({ok:false,message:'POST 방식으로 요청해 주세요.'},405);
