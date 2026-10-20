import {clean,json,randomHex} from '../../_shared/helpers';
import {decodeUploadBase64,inspectMainAttachment} from '../../_shared/security/attachments';
import {cardHandler,postOnly,must,CARD_FILE_TYPES,type MonkCardEnv} from '../../_shared/monk-cards';
export const onRequestPost:PagesFunction<MonkCardEnv>=async({request,env})=>cardHandler(request,env,async(p,user)=>{
 must(env.FILES,'R2(FILES) 연결을 확인해 주세요.',409);
 const id=clean(p.cardId,80),name=clean(p.fileName,200),kind=clean(p.fileKind,40),bytes=decodeUploadBase64(typeof p.dataBase64==='string'?p.dataBase64:'');
 must(bytes,'파일이 비었거나 4MB를 초과합니다.');
 must((CARD_FILE_TYPES as readonly string[]).includes(kind),'증빙 종류를 선택해 주세요.');
 must(/\.(pdf|png|jpe?g|hwp|hwpx|docx)$/i.test(name),'PDF, JPG, PNG, HWP, HWPX, DOCX 파일만 허용합니다.');
 const check=inspectMainAttachment(name,bytes!);if(!check.ok)return json({ok:false,message:check.message},400);
 // Photographs in the supplied regulation are JPEG, >=600x800, portrait 3:4.
 if(kind==='사진'){
  must(/\.jpe?g$/i.test(name),'사진은 JPG 형식을 사용해 주세요.');
  let width=0,height=0,i=2;const b=bytes!;
  while(i+8<b.length){if(b[i]!==255){i++;continue;}const marker=b[i+1];if(marker===0xda||marker===0xd9)break;if(marker===0xd8||marker===0x01||(marker>=0xd0&&marker<=0xd7)){i+=2;continue;}if(marker===255){i++;continue;}const len=(b[i+2]<<8)|b[i+3];if(len<2||i+2+len>b.length)break;
   if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)){height=(b[i+5]<<8)|b[i+6];width=(b[i+7]<<8)|b[i+8];break;}i+=2+len;
  }
  must(width>=600&&height>=800&&width*4===height*3,'사진은 가로 600×세로 800화소 이상, 비율 3:4여야 합니다.');
 }
 const parent=await env.DB.prepare('SELECT id FROM monk_cards WHERE id=?').bind(id).first();must(parent,'발급대장을 먼저 저장해 주세요.',404);
 const attachmentId='MCATT-'+randomHex(24),ext=name.split('.').pop()!.toLowerCase(),key=`monk-cards/${id}/${attachmentId}.${ext}`,now=new Date().toISOString();
 await env.FILES!.put(key,bytes!,{httpMetadata:{contentType:check.mimeType},customMetadata:{cardId:id,attachmentId}});
 try{
  const results=await env.DB.batch([
   env.DB.prepare(`INSERT INTO monk_card_attachments(id,card_id,file_name,file_kind,mime_type,size_bytes,r2_key,created_by_user_id,created_at)
    SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM monk_cards WHERE id=?) AND (SELECT COUNT(*) FROM monk_card_attachments WHERE card_id=?)<10`).bind(attachmentId,id,name,kind,check.mimeType,bytes!.length,key,user.id,now,id,id),
   env.DB.prepare(`INSERT INTO monk_card_changes(id,card_id,action,reason,before_json,after_json,actor_user_id,actor_name,created_at)
    SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM monk_card_attachments WHERE id=?)`).bind('MCCH-'+randomHex(24),id,'증빙 등록',kind,'{}',JSON.stringify({attachmentId}),user.id,user.name,now,attachmentId)
  ]);
  if(Number(results[0].meta?.changes)!==1){await env.FILES!.delete(key);return json({ok:false,message:'증빙은 대장별 최대 10개까지 등록합니다.'},409);}
 }catch(error){await env.FILES!.delete(key).catch(()=>undefined);throw error;}
 return json({ok:true,id:attachmentId,message:'R2에 비공개 증빙을 저장했습니다.'});
});
export const onRequestGet=postOnly;
