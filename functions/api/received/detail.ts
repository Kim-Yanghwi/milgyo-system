import { authenticateSession, clean, ensureTables, json } from '../../_shared/helpers';
interface Env { DB:D1Database; }
type Payload={token?:string;id?:string};
export const onRequestPost:PagesFunction<Env>=async({request,env})=>{
  if(!env.DB)return json({ok:false,message:'DB가 연결되지 않았습니다.'},500);
  let payload:Payload;try{payload=await request.json();}catch{return json({ok:false,message:'요청 형식이 올바르지 않습니다.'},400);}
  await ensureTables(env.DB);const auth=await authenticateSession(env.DB,clean(payload.token,200));if(!auth.ok)return json({ok:false,message:auth.message},auth.status);
  const id=clean(payload.id,60);const document=await env.DB.prepare('SELECT * FROM received_documents WHERE id=?').bind(id).first();
  if(!document)return json({ok:false,message:'등록 문서를 찾을 수 없습니다.'},404);
  const attachments=await env.DB.prepare('SELECT id,file_name,mime_type,size_bytes,created_at FROM received_attachments WHERE received_document_id=? ORDER BY created_at').bind(id).all();
  return json({ok:true,document,attachments:attachments.results??[]});
};
export const onRequestGet:PagesFunction=async()=>json({ok:false,message:'POST 방식으로 요청해 주세요.'},405);
