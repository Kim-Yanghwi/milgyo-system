import { randomHex } from './helpers';
import { ensureAccountingTables, prepareResolutionPosting } from './accounting';
export type AccountingEventType='resolution.create'|'resolution.approve'|'resolution.reject';
type OutboxRow={id:string;event_key:string;event_type:AccountingEventType;document_id:string;payload_json:string;status:string;attempt_count:number;created_at:string};
const integrationReady=new WeakSet<object>();
const integrationPromises=new WeakMap<object,Promise<void>>();
export const ensureAccountingIntegrationSchema=async(mainDb:D1Database)=>{
  const key=mainDb as unknown as object;
  if(integrationReady.has(key))return;
  let pending=integrationPromises.get(key);
  if(!pending){pending=(async()=>{
    const row=await mainDb.prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='accounting_outbox'`).first<{ok:number}>();
    if(!row)throw new Error('전자문서 DB의 회계연계 스키마가 준비되지 않았습니다. main DB용 v26 마이그레이션을 먼저 적용해 주세요.');
    integrationReady.add(key);
  })().catch((e)=>{integrationPromises.delete(key);throw e;});
    integrationPromises.set(key,pending);
  }
  await pending;
};
export const accountingEventStatement=(mainDb:D1Database,eventType:AccountingEventType,documentId:string,payload:Record<string,unknown>,eventKey:string,now=new Date().toISOString())=>
  mainDb.prepare(`INSERT INTO accounting_outbox (id,event_key,event_type,document_id,payload_json,status,attempt_count,created_at,updated_at) VALUES (?,?,?,?,?,'pending',0,?,?) ON CONFLICT(event_key) DO NOTHING`)
    .bind(`AOB-${randomHex(24)}`,eventKey,eventType,documentId,JSON.stringify(payload),now,now);

const applyCreate=async(db:D1Database,payload:any,eventId:string)=>{
  const r=payload.resolution||{},d=payload.dimensions||{},now=String(payload.occurredAt||new Date().toISOString());
  if(!r.id||!r.documentId||!r.resolutionNo)throw new Error('결의서 생성 연계자료가 올바르지 않습니다.');
  await db.batch([
    db.prepare(`INSERT INTO accounting_resolutions (id,resolution_no,resolution_type,fiscal_year,resolution_date,title,department,project,counterparty,account_code,settlement_account_code,amount,tax_amount,payment_method,memo,document_id,status,created_by_user_id,created_by_name,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET resolution_no=excluded.resolution_no,resolution_type=excluded.resolution_type,fiscal_year=excluded.fiscal_year,resolution_date=excluded.resolution_date,title=excluded.title,department=excluded.department,project=excluded.project,counterparty=excluded.counterparty,account_code=excluded.account_code,settlement_account_code=excluded.settlement_account_code,amount=excluded.amount,tax_amount=excluded.tax_amount,payment_method=excluded.payment_method,memo=excluded.memo,document_id=excluded.document_id,status=CASE WHEN accounting_resolutions.status IN ('posted','cancelled') THEN accounting_resolutions.status ELSE excluded.status END,updated_at=excluded.updated_at`)
      .bind(r.id,r.resolutionNo,r.resolutionType,r.fiscalYear,r.resolutionDate,r.title,r.department||'',r.project||'',r.counterparty||'',r.accountCode,r.settlementAccountCode,Number(r.amount||0),Number(r.taxAmount||0),r.paymentMethod||null,r.memo||null,r.documentId,r.status||'approval_pending',r.createdByUserId,r.createdByName,r.createdAt||now,now),
    db.prepare(`INSERT INTO accounting_resolution_dimensions (resolution_id,book_type_code,entity_id,fund_id,source_category,created_at,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(resolution_id) DO UPDATE SET book_type_code=excluded.book_type_code,entity_id=excluded.entity_id,fund_id=excluded.fund_id,source_category=excluded.source_category,updated_at=excluded.updated_at`).bind(r.id,d.bookTypeCode||'general',d.entityId||'ENTITY-HQ',d.fundId||'',d.sourceCategory||'',r.createdAt||now,now),
    db.prepare(`INSERT OR IGNORE INTO accounting_audit_logs (id,action,entity_type,entity_id,actor_user_id,actor_name,detail_json,created_at) VALUES (?, 'create','resolution',?,?,?,?,?)`).bind(`OUTBOX-${eventId}`,r.id,r.createdByUserId||null,r.createdByName||null,JSON.stringify({resolutionNo:r.resolutionNo,documentId:r.documentId,amount:r.amount}),now),
  ]);
  if(r.status==='approved'||r.status==='posted'){
    const resolution=await db.prepare(`SELECT * FROM accounting_resolutions WHERE id=?`).bind(r.id).first<any>();
    if(!resolution)throw new Error('즉시승인 결의서를 회계 DB에서 찾을 수 없습니다.');
    await db.prepare(`UPDATE accounting_resolutions SET status='approved',updated_at=? WHERE id=? AND status<>'posted'`).bind(now,r.id).run();
    const posting=await prepareResolutionPosting(db,resolution,payload.approvedBy||r.createdByName||'자동승인');
    if(posting.statements.length)await db.batch(posting.statements);
  }
};
const applyApprove=async(db:D1Database,payload:any,eventId:string)=>{
  const documentId=String(payload.documentId||'');if(!documentId)throw new Error('승인 연계 문서번호가 없습니다.');
  const resolution=await db.prepare(`SELECT * FROM accounting_resolutions WHERE document_id=? LIMIT 1`).bind(documentId).first<any>();
  if(!resolution)throw new Error('승인할 회계 결의서가 아직 생성되지 않았습니다. 잠시 후 재처리됩니다.');
  if(['rejected','cancelled'].includes(resolution.status))return;
  const now=String(payload.occurredAt||new Date().toISOString());
  await db.prepare(`UPDATE accounting_resolutions SET status='approved',updated_at=? WHERE id=? AND status<>'posted'`).bind(now,resolution.id).run();
  const refreshed=await db.prepare(`SELECT * FROM accounting_resolutions WHERE id=?`).bind(resolution.id).first<any>();
  const posting=await prepareResolutionPosting(db,refreshed,payload.approvedBy||'결재자');
  if(posting.statements.length)await db.batch(posting.statements);
  await db.prepare(`INSERT OR IGNORE INTO accounting_audit_logs (id,action,entity_type,entity_id,actor_name,detail_json,created_at) VALUES (?, 'approve','resolution',?,?,?,?)`).bind(`OUTBOX-${eventId}`,resolution.id,payload.approvedBy||null,JSON.stringify({documentId}),now).run();
};
const applyReject=async(db:D1Database,payload:any,eventId:string)=>{
  const documentId=String(payload.documentId||'');if(!documentId)throw new Error('반려 연계 문서번호가 없습니다.');
  const resolution=await db.prepare(`SELECT id,status FROM accounting_resolutions WHERE document_id=? LIMIT 1`).bind(documentId).first<{id:string;status:string}>();
  if(!resolution)throw new Error('반려할 회계 결의서가 아직 생성되지 않았습니다. 잠시 후 재처리됩니다.');
  if(['posted','cancelled'].includes(resolution.status))return;
  const now=String(payload.occurredAt||new Date().toISOString());
  await db.batch([
    db.prepare(`UPDATE accounting_resolutions SET status='rejected',updated_at=? WHERE id=?`).bind(now,resolution.id),
    db.prepare(`INSERT OR IGNORE INTO accounting_audit_logs (id,action,entity_type,entity_id,actor_name,detail_json,created_at) VALUES (?, 'reject','resolution',?,?,?,?)`).bind(`OUTBOX-${eventId}`,resolution.id,payload.rejectedBy||null,JSON.stringify({documentId,memo:payload.memo||''}),now),
  ]);
};
const applyEvent=async(db:D1Database,row:OutboxRow)=>{
  let p:any;try{p=JSON.parse(row.payload_json||'{}')}catch{throw new Error('회계연계 JSON 자료가 손상되었습니다.')}
  if(row.event_type==='resolution.create')return applyCreate(db,p,row.id);
  if(row.event_type==='resolution.approve')return applyApprove(db,p,row.id);
  if(row.event_type==='resolution.reject')return applyReject(db,p,row.id);
  throw new Error(`지원하지 않는 회계연계 이벤트입니다: ${row.event_type}`);
};
export const processAccountingOutbox=async(mainDb:D1Database,accountingDb:D1Database,options:{ids?:string[];limit?:number;ignoreSchedule?:boolean}={})=>{
  await ensureAccountingIntegrationSchema(mainDb);await ensureAccountingTables(accountingDb);
  const limit=Math.max(1,Math.min(50,Number(options.limit||20))),ids=(options.ids||[]).filter(Boolean).slice(0,50);
  const now=new Date(),nowIso=now.toISOString(),staleIso=new Date(now.getTime()-5*60*1000).toISOString();
  const conditions=[`(status IN ('pending','failed') OR (status='processing' AND updated_at<=?))`],values:unknown[]=[staleIso];
  if(ids.length){conditions.push(`id IN (${ids.map(()=>'?').join(',')})`);values.push(...ids)}else if(!options.ignoreSchedule){conditions.push(`(next_attempt_at IS NULL OR next_attempt_at<=?)`);values.push(nowIso)}
  const rows=await mainDb.prepare(`SELECT id,event_key,event_type,document_id,payload_json,status,attempt_count,created_at FROM accounting_outbox WHERE ${conditions.join(' AND ')} ORDER BY created_at,id LIMIT ${limit}`).bind(...values).all<OutboxRow>();
  const result={processed:0,failed:0,errors:[] as Array<{id:string;message:string}>};
  for(const row of rows.results||[]){
    const claimed=await mainDb.prepare(`UPDATE accounting_outbox SET status='processing',attempt_count=attempt_count+1,last_error=NULL,updated_at=?
      WHERE id=? AND (status IN ('pending','failed') OR (status='processing' AND updated_at<=?)) RETURNING id`)
      .bind(new Date().toISOString(),row.id,staleIso).first<{id:string}>();
    if(!claimed)continue;
    try{await applyEvent(accountingDb,row);const done=new Date().toISOString();await mainDb.prepare(`UPDATE accounting_outbox SET status='succeeded',processed_at=?,next_attempt_at=NULL,last_error=NULL,updated_at=? WHERE id=?`).bind(done,done,row.id).run();result.processed++}
    catch(error){const message=error instanceof Error?error.message.slice(0,1000):'알 수 없는 회계연계 오류';const attempt=Number(row.attempt_count||0)+1;const next=new Date(Date.now()+Math.min(60,Math.max(1,2**Math.min(5,attempt-1)))*60000).toISOString();await mainDb.prepare(`UPDATE accounting_outbox SET status='failed',last_error=?,next_attempt_at=?,updated_at=? WHERE id=?`).bind(message,next,new Date().toISOString(),row.id).run();result.failed++;result.errors.push({id:row.id,message});if(row.event_type==='resolution.create')break}
  }
  return result;
};
export const getAccountingOutboxSummary=async(mainDb:D1Database)=>{
  await ensureAccountingIntegrationSchema(mainDb);
  const [counts,failures]=await mainDb.batch([
    mainDb.prepare(`SELECT status,COUNT(*) AS count FROM accounting_outbox GROUP BY status`),
    mainDb.prepare(`SELECT id,event_type,document_id,attempt_count,last_error,created_at,updated_at FROM accounting_outbox WHERE status='failed' ORDER BY updated_at DESC LIMIT 20`),
  ]);
  const summary:Record<string,number>={pending:0,processing:0,succeeded:0,failed:0};
  for(const row of counts.results||[])summary[String((row as any).status)]=Number((row as any).count||0);
  return {summary,failures:failures.results||[]};
};
