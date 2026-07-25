import { authenticateSession, clean, ensureTables, json, randomHex } from '../../_shared/helpers';
interface Env { DB:D1Database }
type Payload={token?:string;id?:string;sentMethod?:string};
export const onRequestPost:PagesFunction<Env>=async({request,env})=>{
  if(!env.DB)return json({ok:false,message:'DB가 연결되지 않았습니다.'},500);
  let p:Payload;try{p=await request.json();}catch{return json({ok:false,message:'요청 형식이 올바르지 않습니다.'},400);}
  await ensureTables(env.DB);const auth=await authenticateSession(env.DB,clean(p.token,200));if(!auth.ok)return json({ok:false,message:auth.message},auth.status);
  const id=clean(p.id,60),sentMethod=clean(p.sentMethod,80);if(!id||!sentMethod)return json({ok:false,message:'문서번호와 발송방법을 입력해 주세요.'},400);
  const doc=await env.DB.prepare('SELECT id,doc_type,status,drafter_user_id FROM documents WHERE id=?').bind(id).first<any>();
  if(!doc)return json({ok:false,message:'해당 문서를 찾을 수 없습니다.'},404);if(doc.doc_type!=='발송'||doc.status!=='승인')return json({ok:false,message:'승인된 발송문서만 발송완료 처리할 수 있습니다.'},400);
  if(auth.user.role!=='admin'&&doc.drafter_user_id!==auth.user.id)return json({ok:false,message:'기안자 또는 관리자만 발송완료 처리할 수 있습니다.'},403);
  const now=new Date().toISOString();await env.DB.batch([
    env.DB.prepare("UPDATE documents SET status='발송완료',sent_method=?,sent_at=?,completed_at=?,updated_at=? WHERE id=?").bind(sentMethod,now,now,now,id),
    env.DB.prepare("INSERT INTO document_approvals(id,document_id,action,approver_name,approver_role,memo,created_at) VALUES(?,?,'발송완료',?,?,?,?)").bind(`AP-${randomHex(20)}`,id,auth.user.name,auth.user.position||'담당자',`발송방법: ${sentMethod}`,now)
  ]);return json({ok:true,message:'발송완료로 처리되었습니다.'});
};
export const onRequestGet:PagesFunction=async()=>json({ok:false,message:'POST 방식으로 요청해 주세요.'},405);
