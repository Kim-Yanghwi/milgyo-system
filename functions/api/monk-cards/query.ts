import { clean, json } from '../../_shared/helpers';
import { cardHandler, postOnly, cardToday, addDays, resultRow, cardPublicFields, registryDefaults, searchTerm, reserveCardNumber, cardLabels, CARD_TYPES, CARD_FILE_TYPES, CARD_TEMPLATE_ID, CARD_CONSENT_TEMPLATE_ID, type MonkCardEnv, type Row } from '../../_shared/monk-cards';
export const onRequestPost: PagesFunction<MonkCardEnv> = async ({request,env})=>cardHandler(request,env,async(p,user)=>{
 const op=clean(p.operation,40)||'list';
 if(op==='options')return json({ok:true,me:{id:user.id,name:user.name},today:cardToday(),issueTypes:CARD_TYPES,fileTypes:CARD_FILE_TYPES,labels:cardLabels,
  applicationTemplate:CARD_TEMPLATE_ID,consentTemplate:CARD_CONSENT_TEMPLATE_ID});
 if(op==='number-preview')return json({ok:true,estimated:true,number:await reserveCardNumber(env.DB,clean(p.issueDate,10),true)});
 if(op==='registry-detail'){
  const r=await env.DB.prepare(`SELECT ${cardPublicFields} FROM monastic_registry WHERE id=?`).bind(clean(p.id,80)).first<Row>();
  return r?json({ok:true,row:registryDefaults(r)}):json({ok:false,message:'승적원부를 찾을 수 없습니다.'},404);
 }
 if(op==='search-registry'){
  const t=searchTerm(p.query);
  const r=await env.DB.prepare(`SELECT ${cardPublicFields} FROM monastic_registry WHERE status='재적'
   AND (monastic_no LIKE ? ESCAPE '!' OR dharma_name_ko LIKE ? ESCAPE '!' OR temple LIKE ? ESCAPE '!')
   ORDER BY dharma_name_ko,monastic_no LIMIT 51`).bind(t,t,t).all<Row>();
  return json({ok:true,rows:(r.results||[]).slice(0,50).map(registryDefaults),hasMore:(r.results||[]).length>50});
 }
 if(op==='documents'){
  const t=searchTerm(p.query);
  const r=await env.DB.prepare(`SELECT id,title,status,template_name FROM documents WHERE status IN ('승인','발송완료')
   AND (id LIKE ? ESCAPE '!' OR title LIKE ? ESCAPE '!') ORDER BY created_at DESC LIMIT 51`).bind(t,t).all();
  return json({ok:true,rows:(r.results||[]).slice(0,50),hasMore:(r.results||[]).length>50});
 }
 if(op==='previous'){
  const r=await env.DB.prepare(`SELECT c.id,c.card_no,c.issue_date,c.valid_until,c.invalid_date,c.return_date,c.destroyed_date,c.version,
    EXISTS(SELECT 1 FROM monk_cards n WHERE n.previous_id=c.id) AS replaced
    FROM monk_cards c WHERE registry_id=? ORDER BY issue_date DESC,created_at DESC LIMIT 100`).bind(clean(p.registryId,80)).all<Row>();
  return json({ok:true,rows:(r.results||[]).map(resultRow)});
 }
 if(op==='detail'){
  const id=clean(p.id,80);
  const [rows,changes,attachments]=await env.DB.batch([
   env.DB.prepare(`SELECT c.*,r.status AS registry_status,p.card_no AS previous_card_no FROM monk_cards c
    JOIN monastic_registry r ON r.id=c.registry_id LEFT JOIN monk_cards p ON p.id=c.previous_id WHERE c.id=?`).bind(id),
   env.DB.prepare('SELECT * FROM monk_card_changes WHERE card_id=? ORDER BY created_at DESC,id LIMIT 200').bind(id),
   env.DB.prepare('SELECT id,file_name,file_kind,mime_type,size_bytes,state,created_at FROM monk_card_attachments WHERE card_id=? ORDER BY created_at,id').bind(id)
  ]);
  const r=rows.results?.[0];if(!r)return json({ok:false,message:'발급 기록을 찾을 수 없습니다.'},404);
  return json({ok:true,row:resultRow(r),changes:changes.results||[],attachments:attachments.results||[]});
 }
 if(op!=='list')return json({ok:false,message:'지원하지 않는 조회입니다.'},400);
 const page=Math.max(1,Math.min(10000,Math.trunc(Number(p.page)||1))),pageSize=Math.max(10,Math.min(50,Math.trunc(Number(p.pageSize)||20)));
 const params:unknown[]=[],where:string[]=[];
 if(clean(p.query,100)){const t=searchTerm(p.query);where.push(`(c.card_no LIKE ? ESCAPE '!' OR c.monastic_no LIKE ? ESCAPE '!' OR c.dharma_name_ko LIKE ? ESCAPE '!' OR c.temple LIKE ? ESCAPE '!' OR c.internal_document_no LIKE ? ESCAPE '!')`);params.push(t,t,t,t,t);}
 const today=cardToday(),state=clean(p.status,20),invalid="(c.invalid_date<>'' OR c.return_date<>'' OR c.destroyed_date<>'' OR r.status<>'재적')";
 if(state==='무효')where.push(invalid);
 else if(state==='만료'){where.push(`NOT ${invalid} AND c.valid_until<?`);params.push(today);}
 else if(state==='유효'){where.push(`NOT ${invalid} AND c.valid_until>=?`);params.push(today);}
 else if(state==='갱신대상'){where.push(`NOT ${invalid} AND c.valid_until BETWEEN ? AND ?`);params.push(today,addDays(today,90));}
 else if(state)return json({ok:false,message:'상태값을 확인해 주세요.'},400);
 const from=`FROM monk_cards c JOIN monastic_registry r ON r.id=c.registry_id ${where.length?'WHERE '+where.join(' AND '):''}`;
 const [count,data]=await env.DB.batch([
  env.DB.prepare(`SELECT COUNT(*) AS total ${from}`).bind(...params),
  env.DB.prepare(`SELECT c.*,r.status AS registry_status,(SELECT COUNT(*) FROM monk_card_attachments a WHERE a.card_id=c.id) AS attachment_count ${from} ORDER BY c.issue_date DESC,c.created_at DESC,c.id LIMIT ? OFFSET ?`).bind(...params,pageSize,(page-1)*pageSize)
 ]);
 const total=Number(count.results?.[0]?.total||0);
 return json({ok:true,total,page,pages:Math.max(1,Math.ceil(total/pageSize)),pageSize,rows:(data.results||[]).map(resultRow)});
});
export const onRequestGet=postOnly;
