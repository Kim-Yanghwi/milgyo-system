import { authenticateSession, clean, ensureTables, json } from '../../_shared/helpers';
import {
  accountingEventStatement,
  ensureAccountingIntegrationSchema,
  processAccountingOutbox,
} from '../../_shared/accounting-integration';

interface Env { DB: D1Database; ACCOUNTING_DB?: D1Database; }
type DecideBatchPayload = { token?: string; ids?: unknown; action?: string; memo?: string };
const MAX_BATCH = 50;
type LineRow = { id:string; document_id:string; line_order:number; line_type:'검토'|'협조'|'결재'|'전결'; user_id:string; status:string };
const statusForLineType = (lineType: LineRow['line_type']) => lineType === '검토' ? '검토대기' : lineType === '협조' ? '협조대기' : lineType === '전결' ? '전결대기' : '결재대기';
const completedActionForLine = (lineType: LineRow['line_type']) => lineType === '검토' ? '검토완료' : lineType === '협조' ? '협조완료' : lineType === '전결' ? '전결' : '승인';

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB) return json({ ok:false, message:'DB가 연결되지 않았습니다.' },500);
  let payload: DecideBatchPayload;
  try { payload=await request.json(); } catch { return json({ ok:false,message:'요청 형식이 올바르지 않습니다.' },400); }
  await ensureTables(env.DB);
  await ensureAccountingIntegrationSchema(env.DB);
  const auth=await authenticateSession(env.DB,clean(payload.token,200));
  if(!auth.ok)return json({ok:false,message:auth.message},auth.status);
  const me=auth.user;
  const ids=(Array.isArray(payload.ids)?payload.ids:[]).map(v=>clean(v,60)).filter((v,i,a)=>v&&a.indexOf(v)===i).slice(0,MAX_BATCH);
  const action=clean(payload.action,10),memo=clean(payload.memo,2000);
  if(!ids.length)return json({ok:false,message:'처리할 문서를 선택해 주세요.'},400);
  if(!['승인','반려'].includes(action))return json({ok:false,message:'일괄 처리는 승인 또는 반려만 가능합니다.'},400);

  try{
    const placeholders=ids.map(()=>'?').join(',');
    const [documents,lines,linkedRows,allLineDocs]=await env.DB.batch([
      env.DB.prepare(`SELECT id,status,CAST(reviewer_user_id AS TEXT) AS reviewer_user_id,
        CAST(approver_user_id AS TEXT) AS approver_user_id,approval_track,approval_mode
        FROM documents WHERE id IN (${placeholders})`).bind(...ids),
      env.DB.prepare(`SELECT id,document_id,line_order,line_type,CAST(user_id AS TEXT) AS user_id,status
        FROM document_approval_lines WHERE document_id IN (${placeholders}) AND status IN ('대기','예정')
        ORDER BY document_id,line_order`).bind(...ids),
      env.DB.prepare(`SELECT DISTINCT document_id FROM accounting_outbox
        WHERE event_type='resolution.create' AND document_id IN (${placeholders})`).bind(...ids),
      env.DB.prepare(`SELECT DISTINCT document_id FROM document_approval_lines WHERE document_id IN (${placeholders})`).bind(...ids),
    ]);
    const lineMap=new Map<string,LineRow[]>();
    for(const line of (lines.results||[]) as LineRow[]){const list=lineMap.get(line.document_id)||[];list.push(line);lineMap.set(line.document_id,list)}
    const linked=new Set((linkedRows.results||[]).map((r:any)=>String(r.document_id)));
    const hasLines=new Set((allLineDocs.results||[]).map((r:any)=>String(r.document_id)));
    const now=new Date().toISOString(),statements:D1PreparedStatement[]=[],processed:string[]=[],skipped:string[]=[],integrationIds:string[]=[];

    for(const row of (documents.results||[]) as any[]){
      const docLines=lineMap.get(String(row.id))||[],currentLine=docLines[0];
      let finalStatus='',recordedAction=action,role=me.position||'처리자';
      if(currentLine){
        if(me.role!=='admin'&&currentLine.user_id!==me.id){skipped.push(row.id);continue}
        const expectedStatus=statusForLineType(currentLine.line_type);
        if(row.status!==expectedStatus){skipped.push(row.id);continue}
        role=`${currentLine.line_type}자`;
        if(action==='반려'){
          finalStatus='반려';recordedAction='반려';
          statements.push(env.DB.prepare(`UPDATE document_approval_lines SET status='반려',acted_at=?,memo=? WHERE id=? AND status IN ('대기','예정')`).bind(now,memo||null,currentLine.id));
        }else{
          const nextLine=docLines.find(line=>line.status==='예정'&&line.line_order>currentLine.line_order);
          finalStatus=nextLine?statusForLineType(nextLine.line_type):'승인';
          recordedAction=completedActionForLine(currentLine.line_type);
          statements.push(env.DB.prepare(`UPDATE document_approval_lines SET status='완료',acted_at=?,memo=? WHERE id=? AND status IN ('대기','예정')`).bind(now,memo||null,currentLine.id));
          if(nextLine)statements.push(env.DB.prepare(`UPDATE document_approval_lines SET status='대기' WHERE id=? AND status='예정'`).bind(nextLine.id));
        }
      }else if(hasLines.has(String(row.id))){skipped.push(row.id);continue
      }else if(row.status==='검토대기'&&(me.role==='admin'||row.reviewer_user_id===me.id)){
        recordedAction=action==='승인'?'검토완료':'반려';finalStatus=recordedAction==='검토완료'?'결재대기':'반려';
      }else if(['결재대기','전결대기'].includes(row.status)&&(me.role==='admin'||row.approver_user_id===me.id)){
        recordedAction=action==='반려'?'반려':(row.status==='전결대기'||row.approval_mode==='전결'?'전결':'승인');
        finalStatus=action==='반려'?'반려':'승인';
      }else{skipped.push(row.id);continue}

      processed.push(row.id);
      statements.push(env.DB.prepare(`UPDATE documents SET status=?,completed_at=CASE WHEN ? IN ('승인','반려') THEN ? ELSE NULL END,updated_at=? WHERE id=? AND status=?`)
        .bind(finalStatus,finalStatus,now,now,row.id,row.status));
      const auditId=currentLine?`AP-DEC-${currentLine.id}`:`AP-LEGACY-${row.id}-${row.status}`;
      statements.push(env.DB.prepare(`INSERT INTO document_approvals (id,document_id,action,approver_name,approver_role,memo,created_at)
        VALUES (?,?,?,?,?,?,?)`).bind(auditId,row.id,recordedAction,me.name,role,memo||null,now));
      if(linked.has(String(row.id))&&['승인','반려'].includes(finalStatus)){
        const eventType=finalStatus==='승인'?'resolution.approve':'resolution.reject';
        const eventKey=`${eventType}:${row.id}`;
        const eventPayload=finalStatus==='승인'
          ? {documentId:row.id,approvedBy:me.name,occurredAt:now}
          : {documentId:row.id,rejectedBy:me.name,memo,occurredAt:now};
        statements.push(accountingEventStatement(env.DB,eventType,row.id,eventPayload,eventKey,now));
        integrationIds.push(row.id);
      }
    }
    if(!processed.length)return json({ok:false,message:'현재 계정이 처리할 수 있는 문서가 없습니다.'},400);
    await env.DB.batch(statements);
    let integrationPending=false;
    if(integrationIds.length){
      if(!env.ACCOUNTING_DB)integrationPending=true;
      else try{const result=await processAccountingOutbox(env.DB,env.ACCOUNTING_DB,{limit:50,ignoreSchedule:true});integrationPending=result.failed>0}
      catch(error){integrationPending=true;console.error('batch accounting outbox processing failed',error)}
    }
    return json({ok:true,processed:processed.length,skipped,integrationPending,
      message:`${processed.length}건을 처리했습니다.${skipped.length?` 제외 ${skipped.length}건`:''}${integrationPending?' 회계 반영 일부는 재처리 대기 중입니다.':''}`});
  }catch(error){const message=error instanceof Error?error.message:String(error);if(/UNIQUE constraint failed:\s*document_approvals\.id|accounting_outbox\.event_key/i.test(message))return json({ok:false,message:'일부 문서가 다른 요청에서 먼저 처리되었습니다. 새로고침 후 다시 선택해 주세요.'},409);console.error('batch decide failed',error);return json({ok:false,message:'일괄 처리 중 오류가 발생했습니다.'},500)}
};
export const onRequestGet: PagesFunction = async () => json({ok:false,message:'POST 방식으로 요청해 주세요.'},405);
