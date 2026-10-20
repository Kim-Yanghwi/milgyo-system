import {clean,json,randomHex} from '../../_shared/helpers';
import {cardHandler,postOnly,must,changeStatement,type MonkCardEnv,type Row} from '../../_shared/monk-cards';
export const onRequestPost:PagesFunction<MonkCardEnv>=async({request,env})=>cardHandler(request,env,async(p,user)=>{
 const reason=clean(p.reason,500);must(reason,'증빙 삭제·파기 사유가 필요합니다.');must(env.FILES,'R2(FILES) 연결을 확인해 주세요.',409);
 const id=clean(p.attachmentId,80),a=await env.DB.prepare('SELECT * FROM monk_card_attachments WHERE id=?').bind(id).first<Row>();
 must(a,'증빙파일을 찾을 수 없습니다.',404);
 must(String(a!.r2_key).startsWith(`monk-cards/${a!.card_id}/${a!.id}.`),'증빙 저장 경로를 확인해 주세요.',409);
 const now=new Date().toISOString();
 await env.DB.batch([env.DB.prepare("UPDATE monk_card_attachments SET state='deleting' WHERE id=?").bind(id),changeStatement(env.DB,a!.card_id,'증빙 삭제 요청',reason,{attachmentId:id},{},user,now)]);
 try{await env.FILES!.delete(a!.r2_key);}catch{return json({ok:false,code:'R2_DELETE_PENDING',message:'R2 삭제에 실패했습니다. 증빙 목록의 삭제 다시 시도를 이용해 주세요.'},409);}
 await env.DB.batch([env.DB.prepare("DELETE FROM monk_card_attachments WHERE id=? AND state='deleting'").bind(id),
 changeStatement(env.DB,a!.card_id,'증빙 삭제 완료',reason,{attachmentId:id},{},user,new Date().toISOString())]);
 return json({ok:true,message:'R2 파일을 삭제하고 처리이력을 보존했습니다.'});
});
export const onRequestGet=postOnly;
