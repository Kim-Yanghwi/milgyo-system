import { clean, json, randomHex } from '../../_shared/helpers';
import { cardHandler,postOnly,cardDate,cardExpiry,cardToday,addDays,must,CardError,linkedDocument,reserveCardNumber,changeStatement,auditStatement,resultRow,CARD_TYPES,type Row,type MonkCardEnv } from '../../_shared/monk-cards';
const selected = (value:unknown,max=200)=>clean(value,max);
export const onRequestPost:PagesFunction<MonkCardEnv>=async({request,env})=>cardHandler(request,env,async(p,user)=>{
 const op=clean(p.operation,30),v=p.content&&typeof p.content==='object'&&!Array.isArray(p.content)?p.content as Row:{};
 const today=cardToday(),now=new Date().toISOString();
 if(op==='create'){
  const requestId=selected(p.requestId,100);must(/^[A-Za-z0-9_-]{12,100}$/.test(requestId),'요청 식별값이 없습니다. 다시 열어 주세요.');
  const prior=await env.DB.prepare('SELECT * FROM monk_cards WHERE request_id=? AND created_by_user_id=?').bind(requestId,user.id).first<Row>();
  if(prior)return json({ok:true,row:resultRow(prior),repeated:true,message:'이미 저장된 발급 기록입니다.'});
  const registryId=selected(v.registryId,80),r=await env.DB.prepare('SELECT * FROM monastic_registry WHERE id=?').bind(registryId).first<Row>();
  must(r,'승적원부를 선택해 주세요.',404);
  must(r!.status==='재적','재적 승려만 등록할 수 있습니다.',409);
  must(r!.processing_basis!=='비동의'&&r!.sensitive_basis!=='비동의','원부의 비동의 기록을 먼저 확인해 주세요.',409);
  must(v.generalConsent==='동의'&&v.sensitiveConsent==='동의','승려증 발급용 일반정보와 민감정보의 별도 동의를 확인해 주세요.');
  must(v.documentsConfirmed===true&&v.eligibilityConfirmed===true,'신청서류 및 발급 제한 사유가 없음을 확인해 주세요.');
  const abbot=selected(v.abbotConfirmation,40);must(['주지 확인','신청인이 주지','변동 없는 갱신'].includes(abbot),'주지 확인 여부를 선택해 주세요.');
  const kind=selected(v.issueKind,10);must((CARD_TYPES as readonly string[]).includes(kind),'발급 구분을 선택해 주세요.');
  if(abbot==='변동 없는 갱신')must(kind==='갱신','주지 확인 생략은 변동 없는 갱신에 한합니다.');
  const issued=cardDate(v.issueDate,'발급일'),app=cardDate(v.applicationDate,'신청일'),received=cardDate(v.receiptDate,'접수일'),born=cardDate(v.birthDate,'생년월일'),ord=cardDate(v.ordinationDate,'수계일');
  must(issued<=today&&app<=received&&received<=issued&&born<=ord&&ord<=issued,'신청일·접수일·발급일 또는 생년월일·수계일 순서를 확인해 주세요.');
  const days=Number(v.supplementDays||0);must(Number.isInteger(days)&&days>=0&&days<=3660,'보완 소요일을 확인해 주세요.');
  const rank=selected(v.dharmaRank,80),name=selected(v.dharmaNameKo,80),hanja=selected(v.dharmaNameHanja,80),temple=selected(v.temple,120);
  must(rank&&name&&temple,'법명·법계·소속사찰을 입력해 주세요.');
  must(name===r!.dharma_name_ko&&temple===r!.temple&&born===r!.birth_date&&hanja===String(r!.dharma_name_hanja||''),'법명·사찰·생년월일이 원부와 다릅니다. 원부를 먼저 확인·정정해 주세요.',409);
  const doc=await linkedDocument(env.DB,v.linkedDocumentId,v.internalDocumentNo,String(r!.monastic_no));
  const previousId=selected(v.previousId,80),reason=selected(v.issueReason,100),handling=selected(v.previousHandling,40);
  let previous:Row|null=null;
  if(kind!=='신규'){
   previous=await env.DB.prepare('SELECT * FROM monk_cards WHERE id=? AND registry_id=?').bind(previousId,registryId).first<Row>();
   must(previous,'종전 승려증을 선택해 주세요.',404);
   must(issued>=previous!.issue_date,'종전 발급일 이전으로 재발급할 수 없습니다.');
   const next=await env.DB.prepare('SELECT id FROM monk_cards WHERE previous_id=?').bind(previousId).first();must(!next,'이미 대체 발급된 승려증입니다.',409);
   if(kind==='재발급'){
    must(['분실','훼손','기재사항 변경'].includes(reason),'재발급 사유를 선택해 주세요.');
    if(reason==='분실')must(previous!.invalid_date&&previous!.invalid_reason==='분실','분실은 종전 승려증에서 분실·무효 처리를 먼저 해 주세요.',409);
    else must(handling==='함께 반납','훼손·기재사항 변경은 종전 승려증 반납을 확인해 주세요.');
   }else must(app>=addDays(previous!.valid_until,-90)&&app<=previous!.valid_until,'갱신 신청일은 종전 만료일 전 90일부터 만료일까지입니다.');
  }else{
   must(!previousId,'신규는 종전 승려증을 선택하지 않습니다.');
   const existing=await env.DB.prepare('SELECT id FROM monk_cards WHERE registry_id=? LIMIT 1').bind(registryId).first();must(!existing,'기존 발급 기록이 있습니다. 재발급 또는 갱신으로 등록해 주세요.',409);
  }
  const number=await reserveCardNumber(env.DB,issued);
  const id='MCRD-'+randomHex(24), data:Row={id,card_no:number,monastic_no:r!.monastic_no,registry_id:registryId,issue_kind:kind,ordination_round:'00',issue_date:issued,valid_until:cardExpiry(issued),application_date:app,receipt_date:received,supplement_days:days,dharma_name_ko:name,dharma_name_hanja:hanja,dharma_rank:rank,temple,birth_date:born,ordination_date:ord,previous_id:previousId||null,issue_reason:reason,previous_handling:handling,general_consent:v.generalConsent,sensitive_consent:v.sensitiveConsent,abbot_confirmation:abbot,documents_confirmed:1,eligibility_confirmed:1,linked_document_id:doc.id,internal_document_no:doc.no,remarks:selected(v.remarks,1000),request_id:requestId,created_by_user_id:user.id,created_by_name:user.name,updated_by_user_id:user.id,updated_by_name:user.name,created_at:now,updated_at:now};
  const columns=Object.keys(data);
  const guards=["EXISTS(SELECT 1 FROM monastic_registry WHERE id=? AND status='재적' AND version=?)"],args:unknown[]=[registryId,r!.version];
  if(previous){guards.push('EXISTS(SELECT 1 FROM monk_cards WHERE id=? AND version=?)');args.push(previous.id,previous.version);}
  if(doc.id){guards.push("EXISTS(SELECT 1 FROM documents WHERE id=? AND status IN ('승인','발송완료'))");args.push(doc.id);}
  const statements=[env.DB.prepare(`INSERT INTO monk_cards(${columns.join(',')}) SELECT ${columns.map(()=>'?').join(',')} WHERE ${guards.join(' AND ')}`).bind(...Object.values(data),...args)];
  // Conditional inserts mean stale parent state cannot create an audit-only phantom card.
  statements.push(env.DB.prepare(`INSERT INTO monk_card_changes(id,card_id,action,reason,before_json,after_json,actor_user_id,actor_name,created_at) SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM monk_cards WHERE id=?)`).bind('MCCH-'+randomHex(24),id,'등록','발급관리대장 등록','{}',JSON.stringify(data),user.id,user.name,now,id));
  statements.push(env.DB.prepare(`INSERT INTO management_audit_logs(id,category,action,target_id,actor_user_id,actor_name,details_json,created_at) SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM monk_cards WHERE id=?)`).bind('MAL-'+randomHex(24),'승려증','등록',id,user.id,user.name,'{}',now,id));
  if(previous){
   statements.push(env.DB.prepare(`INSERT INTO monk_card_changes(id,card_id,action,reason,before_json,after_json,actor_user_id,actor_name,created_at) SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM monk_cards WHERE id=?)`).bind('MCCH-'+randomHex(24),previous.id,'대체발급',kind,JSON.stringify({invalid_date:previous.invalid_date}),JSON.stringify({invalid_date:previous.invalid_date||issued,replacement:number}),user.id,user.name,now,id));
   statements.push(env.DB.prepare(`UPDATE monk_cards SET invalid_date=CASE WHEN invalid_date='' THEN ? ELSE invalid_date END,invalid_reason=CASE WHEN invalid_reason='' THEN ? ELSE invalid_reason END,return_date=CASE WHEN return_date='' AND ?='함께 반납' THEN ? ELSE return_date END,return_reason=CASE WHEN return_reason='' AND ?='함께 반납' THEN ? ELSE return_reason END,version=version+1,updated_at=?,updated_by_user_id=?,updated_by_name=? WHERE id=? AND EXISTS(SELECT 1 FROM monk_cards WHERE id=?)`).bind(issued,kind,handling,issued,handling,kind,now,user.id,user.name,previous.id,id));
  }
  try {const results=await env.DB.batch(statements);must(Number(results[0].meta?.changes)===1,'원부나 근거문서가 변경되었습니다. 다시 조회해 주세요.',409);}
  catch(error){const again=await env.DB.prepare('SELECT * FROM monk_cards WHERE request_id=? AND created_by_user_id=?').bind(requestId,user.id).first<Row>();if(again)return json({ok:true,row:resultRow(again),repeated:true});if(String(error).includes('UNIQUE constraint'))throw new CardError('동일 승려나 종전 승려증에 발급이 먼저 처리되었습니다.',409);throw error;}
  const saved=await env.DB.prepare('SELECT * FROM monk_cards WHERE id=?').bind(id).first<Row>();
  return json({ok:true,row:resultRow(saved!),message:`${number} 발급 기록을 저장했습니다.`,overdue:issued>addDays(received,30+days)});
 }
 must(['update','receive','invalidate','return','destroy'].includes(op),'지원하지 않는 작업입니다.');
 const id=selected(p.id,80),r=await env.DB.prepare('SELECT * FROM monk_cards WHERE id=?').bind(id).first<Row>();must(r,'대장 기록을 찾을 수 없습니다.',404);
 must(Number(p.version)===Number(r!.version),'다른 담당자가 수정했습니다. 다시 조회해 주세요.',409);
 const reason=selected(p.reason,500);must(reason,'처리·정정 사유를 입력해 주세요.');
 const changed:Row={};let label='';
 if(op==='update'){
  label='기재 정정';
  for(const [camel,col,max] of [['dharmaNameKo','dharma_name_ko',80],['dharmaNameHanja','dharma_name_hanja',80],['dharmaRank','dharma_rank',80],['temple','temple',120],['remarks','remarks',1000]] as const)changed[col]=selected(v[camel],max);
  must(changed.dharma_name_ko&&changed.dharma_rank&&changed.temple,'법명·법계·사찰를 확인해 주세요.');
  changed.birth_date=cardDate(v.birthDate,'생년월일');changed.ordination_date=cardDate(v.ordinationDate,'수계일');must(changed.birth_date<=changed.ordination_date&&changed.ordination_date<=r!.issue_date,'날짜 순서를 확인해 주세요.');
  must(v.clericalCorrection===true,'실제 기재사항 변경은 재발급 대상입니다. 단순 기재오류 정정인지 확인해 주세요.');
  const doc=await linkedDocument(env.DB,v.linkedDocumentId,v.internalDocumentNo,String(r!.monastic_no));changed.linked_document_id=doc.id;changed.internal_document_no=doc.no;
 }else{
  const date=cardDate(p.date,'처리일');must(date<=today&&date>=r!.issue_date,'처리일은 발급일 이상, 오늘 이하여야 합니다.');
  if(op==='receive'){label='수령';must(!r!.invalid_date&&!r!.return_date&&!r!.destroyed_date&&date<=r!.valid_until,'무효·반납·만료 승려증은 교부할 수 없습니다.',409);changed.received_date=date;changed.receipt_confirmation=selected(p.receiptConfirmation,200);changed.registered_mail_no=selected(p.registeredMailNo,80);must(changed.receipt_confirmation||changed.registered_mail_no,'수령 확인 또는 등기번호를 입력해 주세요.');}
  if((op==='invalidate'||op==='return')&&r!.received_date)must(date>=r!.received_date,'처리일은 수령일 이후여야 합니다.');
  if(op==='invalidate'){label='무효';must(!r!.invalid_date,'이미 무효 처리된 승려증입니다.',409);changed.invalid_date=date;changed.invalid_reason=selected(p.invalidReason,100)||reason;}
  if(op==='return'){label='반납';must(!r!.return_date&&!r!.destroyed_date,'이미 반납·폐기된 승려증입니다.',409);changed.return_date=date;changed.return_reason=reason;if(!r!.invalid_date){changed.invalid_date=date;changed.invalid_reason='반납';}}
  if(op==='destroy'){label='폐기';must((r!.invalid_date||r!.return_date||r!.valid_until<today)&&!r!.destroyed_date,'효력 상실 또는 반납 후 폐기를 기록합니다.',409);must(date>=(r!.return_date||r!.invalid_date||r!.valid_until),'폐기일은 반납·무효일 이후여야 합니다.');changed.destroyed_date=date;changed.destruction_method=selected(p.destructionMethod,100);must(['천공','재단'].includes(changed.destruction_method),'폐기 방법(천공/재단)을 선택해 주세요.');}
 }
 const token=randomHex(24),before:Row={},after:Row={};for(const [k,val] of Object.entries(changed))if(String(r![k]??'')!==String(val)){before[k]=r![k];after[k]=val;}
 const cols=Object.keys(changed);
 const results=await env.DB.batch([
  env.DB.prepare(`UPDATE monk_cards SET ${cols.map(c=>c+'=?').join(',')},version=version+1,last_operation=?,updated_by_user_id=?,updated_by_name=?,updated_at=? WHERE id=? AND version=?`).bind(...Object.values(changed),token,user.id,user.name,now,id,p.version),
  env.DB.prepare(`INSERT INTO monk_card_changes(id,card_id,action,reason,before_json,after_json,actor_user_id,actor_name,created_at) SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM monk_cards WHERE id=? AND last_operation=?)`).bind('MCCH-'+randomHex(24),id,label,reason,JSON.stringify(before),JSON.stringify(after),user.id,user.name,now,id,token),
  env.DB.prepare(`INSERT INTO management_audit_logs(id,category,action,target_id,actor_user_id,actor_name,details_json,created_at) SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM monk_cards WHERE id=? AND last_operation=?)`).bind('MAL-'+randomHex(24),'승려증',label,id,user.id,user.name,'{}',now,id,token)
 ]);
 must(Number(results[0].meta?.changes)===1,'다른 요청이 기록을 먼저 변경했습니다. 다시 조회해 주세요.',409);
 return json({ok:true,message:'처리 결과와 변경이력을 저장했습니다.'});
});
export const onRequestGet=postOnly;
