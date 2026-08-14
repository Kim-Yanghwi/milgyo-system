import { clean, randomHex, type SessionUser } from './helpers';
import { ensureAccountingSpecialTables, getResolutionDimensions } from './accounting-special';

export const ACCOUNTING_SCHEMA_VERSION='2026-07-30.2';
const REQUIRED_TABLES=['accounting_fiscal_years','accounting_accounts','accounting_resolutions','accounting_journals','accounting_journal_lines','accounting_closings','accounting_audit_logs','accounting_sequences','accounting_meta','accounting_monthly_summary','accounting_attachments','accounting_attachment_policy','accounting_attachment_integrity_issues','accounting_attachment_operations'];
const schemaReady=new WeakSet<object>();
const schemaPromises=new WeakMap<object,Promise<void>>();

export const parseMoney=(value:unknown)=>{
  if(typeof value==='number')return Number.isFinite(value)?Math.round(value):0;
  const text=String(value??'').trim();if(!text)return 0;
  const negative=/^\s*\(|^-/.test(text);
  const normalized=text.replace(/[^0-9.]/g,'');
  const amount=Number(normalized||0);
  if(!Number.isFinite(amount))return 0;
  return Math.round((negative?-1:1)*amount);
};

export const hasAccountingAccess=(user:SessionUser)=>user.role==='admin'||Number(user.can_accounting||0)===1;
export const isAccountingManager=(user:SessionUser)=>{
  if(!hasAccountingAccess(user))return false;
  if(user.role==='admin')return true;
  const scope=`${user.position||''} ${user.department||''}`;
  return /(이사장|사무총장|재정|회계)/.test(scope);
};
export const canViewAllAccounting=(user:SessionUser)=>hasAccountingAccess(user)&&(user.role==='admin'||user.role==='audit'||isAccountingManager(user));

// 운영 요청 중 DDL을 실행하지 않고 배포 전에 적용된 스키마만 1회 확인합니다.
export const ensureAccountingTables=async(db:D1Database)=>{
  const key=db as unknown as object;
  if(schemaReady.has(key))return;
  let pending=schemaPromises.get(key);
  if(!pending){pending=(async()=>{
    const placeholders=REQUIRED_TABLES.map(()=>'?').join(',');
    const [tables,version]=await db.batch([
      db.prepare(`SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name IN (${placeholders})`).bind(...REQUIRED_TABLES),
      db.prepare(`SELECT meta_value FROM accounting_meta WHERE meta_key='schema_version'`),
    ]);
    if(Number((tables.results?.[0] as any)?.count||0)!==REQUIRED_TABLES.length)throw new Error('회계 전용 DB 스키마가 준비되지 않았습니다. v27 회계 마이그레이션을 먼저 적용해 주세요.');
    if(!String((version.results?.[0] as any)?.meta_value||''))throw new Error('회계 전용 DB 스키마 버전을 확인할 수 없습니다.');
    await ensureAccountingSpecialTables(db);

    // 2026-08-15 직제 개편: 운영 DB에 남아 있는 과거 부서명도 최초 회계 요청 시 안전하게 정규화합니다.
    // 예산/월요약처럼 복합 UNIQUE 키가 있는 집계성 테이블은 기존 키 충돌 위험 때문에 직접 UPDATE하지 않고,
    // 조회 화면에서 호환 표시를 유지하면서 신규 저장값부터 새 직제를 사용합니다.
    const nomenclature = await db.prepare(`SELECT meta_value FROM accounting_meta WHERE meta_key='department_nomenclature_version'`)
      .first<{meta_value:string}>();
    if(String(nomenclature?.meta_value||'')!=='2026-08-15.1'){
      const rewrite=(column:string)=>`CASE
        WHEN TRIM(${column}) IN ('사무국','사무처') THEN '사무처'
        WHEN TRIM(${column}) IN ('재정국','준법윤리국','국제교류국','문화홍보국','사회공헌국') THEN '사무처 - ' || TRIM(${column})
        WHEN TRIM(${column}) IN ('재정·회계','사무국 - 재정·회계','사무처 - 재정·회계','사무국(재정·회계)','사무처(재정·회계)') THEN '사무처 - 재정국'
        WHEN TRIM(${column}) IN ('준법·윤리','사무국 - 준법·윤리','사무처 - 준법·윤리','사무국(준법·윤리)','사무처(준법·윤리)') THEN '사무처 - 준법윤리국'
        WHEN TRIM(${column}) IN ('문화·홍보','사무국 - 문화·홍보','사무처 - 문화·홍보','사무국(문화·홍보)','사무처(문화·홍보)') THEN '사무처 - 문화홍보국'
        WHEN TRIM(${column}) IN ('대외협력·사회공헌','사무국 - 대외협력·사회공헌','사무처 - 대외협력·사회공헌','사무국(대외협력·사회공헌)','사무처(대외협력·사회공헌)') THEN '사무처 - 국제교류국'
        ELSE REPLACE(${column},'사무국','사무처') END`;
      const update=(table:string,column:string)=>db.prepare(`UPDATE ${table} SET ${column}=${rewrite(column)} WHERE ${column} IS NOT NULL AND (${column} LIKE '%사무국%' OR ${column} IN ('재정·회계','준법·윤리','대외협력·사회공헌','문화·홍보','재정국','준법윤리국','국제교류국','문화홍보국','사회공헌국'))`);
      const targets:[string,string][]=[
        ['accounting_entities','department_path'],['accounting_resolutions','department'],['accounting_journal_lines','department'],
        ['accounting_assets','department'],['accounting_cards','department'],['accounting_card_transactions','department'],['accounting_contracts','department'],
      ];
      const targetNames=targets.map(([table])=>table);
      const found=await db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN (${targetNames.map(()=>'?').join(',')})`).bind(...targetNames).all<{name:string}>();
      const existing=new Set((found.results||[]).map((row)=>row.name));
      await db.batch([
        ...targets.filter(([table])=>existing.has(table)).map(([table,column])=>update(table,column)),
        db.prepare(`INSERT INTO accounting_meta (meta_key,meta_value,updated_at) VALUES ('department_nomenclature_version','2026-08-15.1',?) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value,updated_at=excluded.updated_at`).bind(new Date().toISOString()),
      ]);
    }
    schemaReady.add(key);
  })().catch((error)=>{schemaPromises.delete(key);throw error;});
    schemaPromises.set(key,pending);
  }
  await pending;
};

const nextSequence=async(db:D1Database,key:string)=>{
  await db.prepare(`INSERT OR IGNORE INTO accounting_sequences (seq_key,last_seq) VALUES (?,0)`).bind(key).run();
  const row=await db.prepare(`UPDATE accounting_sequences SET last_seq=last_seq+1 WHERE seq_key=? RETURNING last_seq`).bind(key).first<{last_seq:number}>();
  return Number(row?.last_seq||1);
};
export const nextAccountingNumber=async(db:D1Database,type:'resolution-income'|'resolution-expense'|'journal',year:number)=>{
  const prefix=type==='journal'?'전표':type==='resolution-income'?'수입결의':'지출결의';
  const seq=await nextSequence(db,`${type}:${year}`);
  return `${prefix}-${year}-${String(seq).padStart(4,'0')}`;
};

export const isPeriodClosed=async(db:D1Database,date:string)=>{
  const row=await db.prepare(`SELECT 1 AS yes FROM accounting_closings WHERE fiscal_year=? AND period_month=? AND status='closed'`)
    .bind(Number(date.slice(0,4)),Number(date.slice(5,7))).first<{yes:number}>();
  return !!row;
};

export type AccountingDimension={bookTypeCode?:string;entityId?:string;fundId?:string};
export type AccountingSummaryLine={accountCode:string;debit:number;credit:number;department?:string;project?:string};
export const monthlySummaryStatement=(db:D1Database,journalDate:string,line:AccountingSummaryLine,dimensions:AccountingDimension,now=new Date().toISOString())=>
  db.prepare(`INSERT INTO accounting_monthly_summary
    (fiscal_year,period_month,book_type_code,entity_id,fund_id,account_code,department,project,debit_total,credit_total,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(fiscal_year,period_month,book_type_code,entity_id,fund_id,account_code,department,project)
    DO UPDATE SET debit_total=debit_total+excluded.debit_total,credit_total=credit_total+excluded.credit_total,updated_at=excluded.updated_at`)
    .bind(Number(journalDate.slice(0,4)),Number(journalDate.slice(5,7)),dimensions.bookTypeCode||'general',dimensions.entityId||'ENTITY-HQ',dimensions.fundId||'',line.accountCode,line.department||'',line.project||'',Math.round(Number(line.debit||0)),Math.round(Number(line.credit||0)),now);

export const prepareResolutionPosting=async(db:D1Database,resolution:{id:string;resolution_type:string;fiscal_year:number;resolution_date:string;title:string;department:string;project:string;counterparty:string;account_code:string;settlement_account_code:string;amount:number;document_id:string|null;created_by_name:string},approvedBy:string)=>{
  if(await isPeriodClosed(db,resolution.resolution_date))throw new Error('해당 회계기간은 마감되어 전표를 생성할 수 없습니다.');
  const existing=await db.prepare(`SELECT id FROM accounting_journals WHERE source_type='resolution' AND source_id=? AND status IN ('posted','reversed')`).bind(resolution.id).first<{id:string}>();
  if(existing)return {statements:[] as D1PreparedStatement[],journalId:existing.id,duplicate:true};
  const journalId=`JRN-${randomHex(24)}`,journalNo=await nextAccountingNumber(db,'journal',resolution.fiscal_year),now=new Date().toISOString();
  const dimensions=await getResolutionDimensions(db,resolution.id);
  const line1Id=`JL-${randomHex(20)}`,line2Id=`JL-${randomHex(20)}`;
  const amount=Math.abs(Number(resolution.amount||0));if(!amount)throw new Error('결의금액이 0원입니다.');
  const isIncome=resolution.resolution_type==='income';
  const debitAccount=isIncome?resolution.settlement_account_code:resolution.account_code;
  const creditAccount=isIncome?resolution.account_code:resolution.settlement_account_code;
  const common=[resolution.department||'',resolution.project||'',resolution.counterparty||'',resolution.title];
  const statements:D1PreparedStatement[]=[
    db.prepare(`INSERT INTO accounting_journals (id,journal_no,fiscal_year,journal_date,source_type,source_id,description,status,document_id,created_by,approved_by,created_at) VALUES (?,?,?,?, 'resolution',?,?, 'posted',?,?,?,?)`).bind(journalId,journalNo,resolution.fiscal_year,resolution.resolution_date,resolution.id,resolution.title,resolution.document_id,resolution.created_by_name,approvedBy,now),
    db.prepare(`INSERT INTO accounting_journal_lines (id,journal_id,line_no,account_code,debit,credit,department,project,counterparty,memo) VALUES (?,?,?,?,?,0,?,?,?,?)`).bind(line1Id,journalId,1,debitAccount,amount,...common),
    db.prepare(`INSERT INTO accounting_journal_lines (id,journal_id,line_no,account_code,debit,credit,department,project,counterparty,memo) VALUES (?,?,?,?,0,?, ?,?,?,?)`).bind(line2Id,journalId,2,creditAccount,amount,...common),
    db.prepare(`INSERT INTO accounting_journal_line_dimensions (journal_line_id,book_type_code,entity_id,fund_id,created_at) VALUES (?,?,?,?,?)`).bind(line1Id,dimensions.bookTypeCode,dimensions.entityId,dimensions.fundId,now),
    db.prepare(`INSERT INTO accounting_journal_line_dimensions (journal_line_id,book_type_code,entity_id,fund_id,created_at) VALUES (?,?,?,?,?)`).bind(line2Id,dimensions.bookTypeCode,dimensions.entityId,dimensions.fundId,now),
    monthlySummaryStatement(db,resolution.resolution_date,{accountCode:debitAccount,debit:amount,credit:0,department:resolution.department,project:resolution.project},dimensions,now),
    monthlySummaryStatement(db,resolution.resolution_date,{accountCode:creditAccount,debit:0,credit:amount,department:resolution.department,project:resolution.project},dimensions,now),
    db.prepare(`UPDATE accounting_resolutions SET status='posted',journal_id=?,updated_at=? WHERE id=?`).bind(journalId,now,resolution.id),
    db.prepare(`UPDATE accounting_contract_payments SET journal_id=?,status='paid',paid_at=?,updated_at=? WHERE resolution_id=?`).bind(journalId,now,now,resolution.id),
    db.prepare(`UPDATE accounting_contracts SET status='completed',updated_at=? WHERE id IN (
      SELECT c.id FROM accounting_contracts c JOIN accounting_contract_payments p ON p.contract_id=c.id
      WHERE p.resolution_id=? GROUP BY c.id HAVING SUM(CASE WHEN p.status='paid' OR p.resolution_id=? THEN p.amount ELSE 0 END)>=c.contract_amount
    )`).bind(now,resolution.id,resolution.id),
    db.prepare(`INSERT OR IGNORE INTO accounting_audit_logs (id,action,entity_type,entity_id,actor_name,detail_json,created_at) VALUES (?, 'post','resolution',?,?,?,?)`).bind(`POST-${resolution.id}`,resolution.id,approvedBy,JSON.stringify({journalNo,amount}),now),
  ];
  return {statements,journalId,duplicate:false};
};

export const cleanAccountingText=(value:unknown,max=200)=>clean(value,max);
