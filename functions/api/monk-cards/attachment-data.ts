import {clean,json} from '../../_shared/helpers';
import {cardHandler,postOnly,must,type MonkCardEnv,type Row} from '../../_shared/monk-cards';
export const onRequestPost:PagesFunction<MonkCardEnv>=async({request,env})=>cardHandler(request,env,async(p)=>{
 const a=await env.DB.prepare("SELECT * FROM monk_card_attachments WHERE id=? AND state='active'").bind(clean(p.attachmentId,80)).first<Row>();
 must(a,'파일을 찾을 수 없습니다.',404);must(env.FILES,'R2(FILES) 연결을 확인해 주세요.',409);
 must(String(a!.r2_key).startsWith(`monk-cards/${a!.card_id}/${a!.id}.`),'증빙 저장 경로를 확인해 주세요.',409);
 const obj=await env.FILES!.get(a!.r2_key);must(obj,'R2에 증빙파일이 없습니다.',404);
 return new Response(obj!.body,{headers:{'Content-Type':a!.mime_type,'Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(a!.file_name)}`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
});
export const onRequestGet=postOnly;
