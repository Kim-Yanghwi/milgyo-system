import { authenticateSession, clean, ensureTables, json, randomHex } from '../../_shared/helpers';
import { writeManagementAudit } from '../../_shared/management';
interface Env { DB: D1Database; FILES?: R2Bucket; }
type Payload = { token?: string; registerId?: string; fileName?: string; mimeType?: string; dataBase64?: string };
const MAX_FILE_BYTES=4*1024*1024; const MAX_D1_FALLBACK_BYTES=1250*1024;
const BLOCKED=/\.(html?|js|mjs|svg|exe|dll|bat|cmd|com|ps1|sh|php|jsp|asp|aspx)$/i;
const decode=(value:string)=>{ if(!/^[A-Za-z0-9+/]*={0,2}$/.test(value)||value.length%4===1)return null; try{const b=atob(value);return Uint8Array.from(b,c=>c.charCodeAt(0));}catch{return null;} };
const safe=(name:string)=>name.replace(/[^0-9A-Za-z._-]+/g,'_').slice(-120)||'attachment.bin';
export const onRequestPost: PagesFunction<Env> = async ({request,env})=>{
  if(!env.DB)return json({ok:false,message:'DB가 연결되지 않았습니다.'},500);
  let p:Payload;try{p=await request.json();}catch{return json({ok:false,message:'요청 형식이 올바르지 않습니다.'},400);}
  await ensureTables(env.DB);const auth=await authenticateSession(env.DB,clean(p.token,200));if(!auth.ok)return json({ok:false,message:auth.message},auth.status);
  const registerId=clean(p.registerId,80),fileName=clean(p.fileName,200),mimeType=clean(p.mimeType,120)||'application/octet-stream',data=typeof p.dataBase64==='string'?p.dataBase64:'';
  if(!registerId||!fileName||!data)return json({ok:false,message:'첨부파일 정보가 부족합니다.'},400);
  if(BLOCKED.test(fileName))return json({ok:false,message:'보안상 등록할 수 없는 파일 형식입니다.'},400);
  const bytes=decode(data);if(!bytes)return json({ok:false,message:'첨부파일 인코딩이 올바르지 않습니다.'},400);if(bytes.byteLength>MAX_FILE_BYTES)return json({ok:false,message:'첨부파일은 4MB 이하만 등록할 수 있습니다.'},400);
  const row=await env.DB.prepare('SELECT applicant_user_id,status FROM management_registers WHERE id=?').bind(registerId).first<any>();
  if(!row)return json({ok:false,message:'대장 신청내역을 찾을 수 없습니다.'},404);
  if(auth.user.role!=='admin'&&String(row.applicant_user_id||'')!==auth.user.id)return json({ok:false,message:'신청자 또는 관리자만 첨부할 수 있습니다.'},403);
  if(['완료','반려','취소'].includes(String(row.status||'')))return json({ok:false,message:'처리가 끝난 신청에는 첨부파일을 추가할 수 없습니다.'},400);
  const cnt=await env.DB.prepare('SELECT COUNT(*) AS count FROM management_register_attachments WHERE register_id=?').bind(registerId).first<{count:number}>();
  if(Number(cnt?.count||0)>=10)return json({ok:false,message:'신청건당 첨부파일은 최대 10개입니다.'},400);
  const id=`MRATT-${randomHex(20)}`;let storageType='d1',r2Key:string|null=null,stored=data;
  if(env.FILES){storageType='r2';stored='';r2Key=`registers/${registerId}/${id}-${safe(fileName)}`;await env.FILES.put(r2Key,bytes,{httpMetadata:{contentType:mimeType},customMetadata:{originalName:fileName,registerId}});}else if(bytes.byteLength>MAX_D1_FALLBACK_BYTES){return json({ok:false,message:'1.2MB를 넘는 파일은 R2 저장소(FILES)가 필요합니다.'},400);}
  try{await env.DB.prepare(`INSERT INTO management_register_attachments(id,register_id,file_name,mime_type,size_bytes,data_base64,storage_type,r2_key,created_at) VALUES(?,?,?,?,?,?,?,?,?)`).bind(id,registerId,fileName,mimeType,bytes.byteLength,stored,storageType,r2Key,new Date().toISOString()).run();await writeManagementAudit(env.DB,auth.user,'대장관리','첨부등록',registerId,{attachmentId:id,fileName,sizeBytes:bytes.byteLength});return json({ok:true,id,fileName,sizeBytes:bytes.byteLength,message:'첨부파일이 등록되었습니다.'});}catch{if(r2Key&&env.FILES)await env.FILES.delete(r2Key).catch(()=>undefined);return json({ok:false,message:'첨부파일 저장 중 오류가 발생했습니다.'},500);}
};
export const onRequestGet: PagesFunction=async()=>json({ok:false,message:'POST 방식으로 요청해 주세요.'},405);
