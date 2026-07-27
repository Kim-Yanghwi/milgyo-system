import { authenticateSession, clean, ensureTables, json } from '../../_shared/helpers';
import { canViewAllAccounting, ensureAccountingTables, hasAccountingAccess, isAccountingManager } from '../../_shared/accounting';
import { getDimensionMaster } from '../../_shared/accounting-special';
import { getAccountingOutboxSummary } from '../../_shared/accounting-integration';

interface Env { DB: D1Database; ACCOUNTING_DB: D1Database; }
type Payload = {
  token?: string; action?: string; year?: number; month?: number; accountCode?: string; id?: string;
  status?: string; department?: string; project?: string; query?: string; bookTypeCode?: string;
  entityId?: string; fundId?: string; limit?: number;
};
const toYear=(value:unknown)=>{const current=new Date(Date.now()+9*60*60*1000).getUTCFullYear();const year=Number(value||current);return year>=2000&&year<=2200?year:current;};
const toLimit=(value:unknown,fallback=100)=>Math.max(10,Math.min(200,Number(value||fallback)||fallback));
const documentStatusMap=async(mainDb:D1Database,documentIds:string[])=>{
  const ids=[...new Set(documentIds.filter(Boolean))].slice(0,200);if(!ids.length)return new Map<string,string>();
  const rows=await mainDb.prepare(`SELECT id,status FROM documents WHERE id IN (${ids.map(()=>'?').join(',')})`).bind(...ids).all<{id:string;status:string}>();
  return new Map((rows.results||[]).map((r)=>[r.id,r.status]));
};

export const onRequestPost:PagesFunction<Env>=async({request,env})=>{
  if(!env.DB||!env.ACCOUNTING_DB)return json({ok:false,message:'전자문서 DB 또는 회계 전용 DB가 연결되지 않았습니다.'},500);
  let payload:Payload;try{payload=await request.json()}catch{return json({ok:false,message:'요청 형식이 올바르지 않습니다.'},400)}
  await ensureTables(env.DB);
  const auth=await authenticateSession(env.DB,clean(payload.token,200));if(!auth.ok)return json({ok:false,message:auth.message},auth.status);
  if(!hasAccountingAccess(auth.user))return json({ok:false,message:'종단 회계관리 접속 권한이 없습니다. 관리자에게 회계권한 부여를 요청해 주세요.'},403);
  await ensureAccountingTables(env.ACCOUNTING_DB);
  const db=env.ACCOUNTING_DB,me=auth.user,action=clean(payload.action,40)||'init',year=toYear(payload.year),canViewAll=canViewAllAccounting(me),manager=isAccountingManager(me),limit=toLimit(payload.limit);
  try{
    if(action==='init'){
      const [fiscal,accounts,summaryRows,recentRows,closingRows,dimensions,integration]=await Promise.all([
        db.prepare(`SELECT year,name,start_date,end_date,base_currency,status,closed_at FROM accounting_fiscal_years ORDER BY year DESC`).all(),
        db.prepare(`SELECT code,name,account_type,normal_side,parent_code,active,system_account FROM accounting_accounts WHERE active=1 ORDER BY code`).all(),
        db.prepare(`SELECT COALESCE(SUM(CASE WHEN a.account_type='revenue' THEN s.credit_total-s.debit_total ELSE 0 END),0) AS income,COALESCE(SUM(CASE WHEN a.account_type='expense' THEN s.debit_total-s.credit_total ELSE 0 END),0) AS expense,COALESCE(SUM(s.debit_total),0) AS total_debit,COALESCE(SUM(s.credit_total),0) AS total_credit FROM accounting_monthly_summary s JOIN accounting_accounts a ON a.code=s.account_code WHERE s.fiscal_year=?`).bind(year).all(),
        (canViewAll?db.prepare(`SELECT r.*,a.name AS account_name,s.name AS settlement_account_name FROM accounting_resolutions r LEFT JOIN accounting_accounts a ON a.code=r.account_code LEFT JOIN accounting_accounts s ON s.code=r.settlement_account_code WHERE r.fiscal_year=? ORDER BY r.created_at DESC LIMIT 8`).bind(year):db.prepare(`SELECT r.*,a.name AS account_name,s.name AS settlement_account_name FROM accounting_resolutions r LEFT JOIN accounting_accounts a ON a.code=r.account_code LEFT JOIN accounting_accounts s ON s.code=r.settlement_account_code WHERE r.fiscal_year=? AND r.created_by_user_id=? ORDER BY r.created_at DESC LIMIT 8`).bind(year,me.id)).all(),
        db.prepare(`SELECT period_month,status,closed_by,closed_at,memo FROM accounting_closings WHERE fiscal_year=? ORDER BY period_month`).bind(year).all(),
        getDimensionMaster(db),
        manager?getAccountingOutboxSummary(env.DB).catch(()=>({summary:{pending:0,processing:0,succeeded:0,failed:0},failures:[]})):Promise.resolve(null),
      ]);
      return json({ok:true,me,permissions:{manager,canViewAll,audit:me.role==='audit'},year,fiscalYears:fiscal.results||[],accounts:accounts.results||[],summary:summaryRows.results?.[0]||{income:0,expense:0,total_debit:0,total_credit:0},recentResolutions:recentRows.results||[],closings:closingRows.results||[],...dimensions,integration});
    }
    if(action==='accounts'){
      const rows=await db.prepare(`SELECT code,name,account_type,normal_side,parent_code,active,system_account,created_at,updated_at FROM accounting_accounts ORDER BY code`).all();
      return json({ok:true,rows:rows.results||[]});
    }
    if(action==='budgets'||action==='budget-execution'){
      const department=clean(payload.department,80),project=clean(payload.project,100),bookTypeCode=clean(payload.bookTypeCode,30),entityId=clean(payload.entityId,80),fundId=clean(payload.fundId,80);
      const conditions=['b.fiscal_year=?'];const values:unknown[]=[year];
      if(department){conditions.push('b.department=?');values.push(department)}if(project){conditions.push('b.project=?');values.push(project)}if(bookTypeCode){conditions.push('b.book_type_code=?');values.push(bookTypeCode)}if(entityId){conditions.push('b.entity_id=?');values.push(entityId)}if(fundId){conditions.push('b.fund_id=?');values.push(fundId)}
      const rows=await db.prepare(`SELECT b.*,a.name AS account_name,bt.name AS book_type_name,e.name AS entity_name,f.name AS fund_name,(b.original_amount+b.supplementary_amount+b.transfer_in-b.transfer_out) AS revised_amount,COALESCE(x.executed_amount,0) AS executed_amount FROM accounting_budget_plans b JOIN accounting_accounts a ON a.code=b.account_code LEFT JOIN accounting_book_types bt ON bt.code=b.book_type_code LEFT JOIN accounting_entities e ON e.id=b.entity_id LEFT JOIN accounting_funds f ON f.id=b.fund_id LEFT JOIN (SELECT fiscal_year,book_type_code,entity_id,fund_id,account_code,department,project,SUM(debit_total-credit_total) AS executed_amount FROM accounting_monthly_summary GROUP BY fiscal_year,book_type_code,entity_id,fund_id,account_code,department,project) x ON x.fiscal_year=b.fiscal_year AND x.book_type_code=b.book_type_code AND x.entity_id=b.entity_id AND x.fund_id=b.fund_id AND x.account_code=b.account_code AND x.department=b.department AND x.project=b.project WHERE ${conditions.join(' AND ')} ORDER BY b.book_type_code,e.name,f.name,b.department,b.project,b.account_code`).bind(...values).all();
      return json({ok:true,rows:rows.results||[]});
    }
    if(action==='resolutions'){
      const conditions=['r.fiscal_year=?'];const values:unknown[]=[year];if(!canViewAll){conditions.push('r.created_by_user_id=?');values.push(me.id)}
      const status=clean(payload.status,30);if(status){conditions.push('r.status=?');values.push(status)}const q=clean(payload.query,120);if(q){conditions.push(`(r.title LIKE ? OR r.counterparty LIKE ? OR r.resolution_no LIKE ?)`);values.push(`%${q}%`,`%${q}%`,`%${q}%`)}
      const result=await db.prepare(`SELECT r.*,a.name AS account_name,s.name AS settlement_account_name,COALESCE(rd.book_type_code,'general') AS book_type_code,COALESCE(rd.entity_id,'ENTITY-HQ') AS entity_id,COALESCE(rd.fund_id,'') AS fund_id,bt.name AS book_type_name,e.name AS entity_name,f.name AS fund_name FROM accounting_resolutions r LEFT JOIN accounting_accounts a ON a.code=r.account_code LEFT JOIN accounting_accounts s ON s.code=r.settlement_account_code LEFT JOIN accounting_resolution_dimensions rd ON rd.resolution_id=r.id LEFT JOIN accounting_book_types bt ON bt.code=COALESCE(rd.book_type_code,'general') LEFT JOIN accounting_entities e ON e.id=COALESCE(rd.entity_id,'ENTITY-HQ') LEFT JOIN accounting_funds f ON f.id=rd.fund_id WHERE ${conditions.join(' AND ')} ORDER BY r.resolution_date DESC,r.created_at DESC,r.id DESC LIMIT ${limit}`).bind(...values).all<any>();
      const rows=result.results||[],statuses=await documentStatusMap(env.DB,rows.map((r)=>r.document_id));return json({ok:true,rows:rows.map((r)=>({...r,document_status:statuses.get(r.document_id)||null})),limit});
    }
    if(action==='journals'){
      if(!canViewAll)return json({ok:false,message:'전표와 장부는 회계담당자·관리자·감사만 조회할 수 있습니다.'},403);
      const q=clean(payload.query,120);const rows=await db.prepare(`SELECT j.*,COALESCE(SUM(l.debit),0) AS debit_total,COALESCE(SUM(l.credit),0) AS credit_total FROM accounting_journals j LEFT JOIN accounting_journal_lines l ON l.journal_id=j.id WHERE j.fiscal_year=? ${q?'AND (j.journal_no LIKE ? OR j.description LIKE ?)':''} GROUP BY j.id ORDER BY j.journal_date DESC,j.created_at DESC,j.id DESC LIMIT ${limit}`).bind(...(q?[year,`%${q}%`,`%${q}%`]:[year])).all();
      return json({ok:true,rows:rows.results||[],limit});
    }
    if(action==='journal-detail'){
      if(!canViewAll)return json({ok:false,message:'전표를 조회할 권한이 없습니다.'},403);const id=clean(payload.id,80);
      const [journal,lines]=await db.batch([db.prepare(`SELECT * FROM accounting_journals WHERE id=?`).bind(id),db.prepare(`SELECT l.*,a.name AS account_name,COALESCE(d.book_type_code,'general') AS book_type_code,COALESCE(d.entity_id,'ENTITY-HQ') AS entity_id,COALESCE(d.fund_id,'') AS fund_id FROM accounting_journal_lines l JOIN accounting_accounts a ON a.code=l.account_code LEFT JOIN accounting_journal_line_dimensions d ON d.journal_line_id=l.id WHERE l.journal_id=? ORDER BY l.line_no`).bind(id)]);
      return json({ok:true,journal:journal.results?.[0]||null,lines:lines.results||[]});
    }
    if(action==='ledger'){
      if(!canViewAll)return json({ok:false,message:'장부를 조회할 권한이 없습니다.'},403);const code=clean(payload.accountCode,20);if(!code)return json({ok:false,message:'계정과목을 선택해 주세요.'},400);
      const rows=await db.prepare(`SELECT j.journal_no,j.journal_date,j.description,j.document_id,j.status,l.debit,l.credit,l.department,l.project,l.counterparty,l.memo,SUM(CASE WHEN a.normal_side='debit' THEN l.debit-l.credit ELSE l.credit-l.debit END) OVER (ORDER BY j.journal_date,j.created_at,l.line_no) AS running_balance FROM accounting_journal_lines l JOIN accounting_journals j ON j.id=l.journal_id JOIN accounting_accounts a ON a.code=l.account_code WHERE j.fiscal_year=? AND j.status IN ('posted','reversed') AND l.account_code=? ORDER BY j.journal_date,j.created_at,l.line_no LIMIT ${limit}`).bind(year,code).all();return json({ok:true,rows:rows.results||[],limit});
    }
    if(action==='trial-balance'||action==='statement'){
      if(!canViewAll)return json({ok:false,message:'결산자료를 조회할 권한이 없습니다.'},403);
      const rows=await db.prepare(`SELECT a.code,a.name,a.account_type,a.normal_side,COALESCE(SUM(s.debit_total),0) AS debit,COALESCE(SUM(s.credit_total),0) AS credit,CASE WHEN a.normal_side='debit' THEN COALESCE(SUM(s.debit_total-s.credit_total),0) ELSE COALESCE(SUM(s.credit_total-s.debit_total),0) END AS balance FROM accounting_accounts a LEFT JOIN accounting_monthly_summary s ON s.account_code=a.code AND s.fiscal_year=? WHERE a.active=1 GROUP BY a.code,a.name,a.account_type,a.normal_side ORDER BY a.code`).bind(year).all();const allRows=(rows.results||[]) as any[];return json({ok:true,rows:action==='statement'?allRows.filter((r)=>['revenue','expense'].includes(r.account_type)):allRows});
    }
    if(action==='closings'){const rows=await db.prepare(`SELECT * FROM accounting_closings WHERE fiscal_year=? ORDER BY period_month`).bind(year).all();return json({ok:true,rows:rows.results||[]})}
    if(action==='integration-status'){if(!manager)return json({ok:false,message:'회계연계 상태 조회 권한이 없습니다.'},403);return json({ok:true,...await getAccountingOutboxSummary(env.DB)})}
    return json({ok:false,message:'지원하지 않는 조회입니다.'},400);
  }catch(error){console.error('accounting query failed',action,error);return json({ok:false,message:error instanceof Error?error.message:'회계자료 조회 중 오류가 발생했습니다.'},500)}
};
export const onRequestGet:PagesFunction=async()=>json({ok:false,message:'POST 방식으로 요청해 주세요.'},405);
