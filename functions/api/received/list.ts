import { authenticateSession, clean, ensureTables, isValidIsoDate, json } from '../../_shared/helpers';
interface Env { DB: D1Database; }
type ListPayload = { token?: string; direction?: string; query?: string; page?: number; pageSize?: number; dateFrom?: string; dateTo?: string; sort?: string };
const SORTS: Record<string,string> = { newest:'received_at DESC, created_at DESC', oldest:'received_at ASC, created_at ASC', title:'title ASC' };
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB) return json({ ok:false, message:'DB가 연결되지 않았습니다.' },500);
  let payload:ListPayload;
  try { payload=await request.json(); } catch { return json({ok:false,message:'요청 형식이 올바르지 않습니다.'},400); }
  await ensureTables(env.DB);
  const auth=await authenticateSession(env.DB,clean(payload.token,200));
  if(!auth.ok) return json({ok:false,message:auth.message},auth.status);
  const direction=clean(payload.direction,10), query=clean(payload.query,100), dateFrom=clean(payload.dateFrom,10), dateTo=clean(payload.dateTo,10);
  if(dateFrom&&!isValidIsoDate(dateFrom))return json({ok:false,message:'조회 시작일이 올바르지 않습니다.'},400);
  if(dateTo&&!isValidIsoDate(dateTo))return json({ok:false,message:'조회 종료일이 올바르지 않습니다.'},400);
  if(dateFrom&&dateTo&&dateFrom>dateTo)return json({ok:false,message:'조회 시작일은 종료일보다 늦을 수 없습니다.'},400);
  const page=Math.max(1,Math.min(10000,Number(payload.page)||1)), pageSize=Math.max(10,Math.min(100,Number(payload.pageSize)||20));
  const filters:string[]=[]; const bindings:unknown[]=[];
  if(direction && direction!=='전체'){ filters.push('direction=?'); bindings.push(direction); }
  if(query){ filters.push('(id LIKE ? OR title LIKE ? OR counterparty LIKE ? OR source_system LIKE ? OR external_doc_number LIKE ?)'); const k=`%${query}%`; bindings.push(k,k,k,k,k); }
  if(dateFrom){ filters.push('received_at>=?'); bindings.push(dateFrom); }
  if(dateTo){ filters.push('received_at<=?'); bindings.push(dateTo); }
  const where=filters.length?`WHERE ${filters.join(' AND ')}`:'';
  try{
    const countStmt=env.DB.prepare(`SELECT COUNT(*) AS count FROM received_documents ${where}`);
    const boundCount=bindings.length?countStmt.bind(...bindings):countStmt;
    const offset=(page-1)*pageSize;
    const stmt=env.DB.prepare(`SELECT id,direction,title,counterparty,source_system,external_doc_number,memo,department,related_document_id,handled_by,CAST(handled_by_user_id AS TEXT) AS handled_by_user_id,received_at,created_at,updated_at FROM received_documents ${where} ORDER BY ${SORTS[clean(payload.sort,20)]||SORTS.newest} LIMIT ? OFFSET ?`);
    const [countResult,rows]=await env.DB.batch([boundCount,stmt.bind(...bindings,pageSize,offset)]);
    const count=(countResult.results?.[0]||{}) as Record<string,unknown>;
    const total=Number(count.count||0);
    return json({ok:true,rows:rows.results??[],total,page,pageSize,pages:Math.max(1,Math.ceil(total/pageSize))});
  }catch(error){console.error('received list failed',error);return json({ok:false,message:'접수·발송대장 조회 중 오류가 발생했습니다.'},500);}
};
export const onRequestGet:PagesFunction=async()=>json({ok:false,message:'POST 방식으로 요청해 주세요.'},405);
