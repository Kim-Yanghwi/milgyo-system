import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SQLiteD1, TestR2 } from './support/d1-sqlite.mjs';
import { createSession } from '../functions/_shared/security/sessions';
import { onRequestPost as registryAction } from '../functions/api/monastic-registry/action';
import { onRequestPost as cardAction } from '../functions/api/monk-cards/action';
import { onRequestPost as cardQuery } from '../functions/api/monk-cards/query';
import { onRequestPost as upload } from '../functions/api/monk-cards/upload-attachment';
import { onRequestPost as download, onRequestGet as downloadGet } from '../functions/api/monk-cards/attachment-data';
import { onRequestPost as deleteFile } from '../functions/api/monk-cards/delete-attachment';
import { onRequestPost as createDocument } from '../functions/api/documents/create';
import { onRequestPost as decideDocument } from '../functions/api/documents/decide';
import { onRequestPost as detailDocument } from '../functions/api/documents/detail';
import { onRequestPost as listTemplates } from '../functions/api/templates/list';
import { resetAllTestData } from '../functions/_shared/test-data-reset';
import { cardExpiry,cardToday,reserveCardNumber,validity,CARD_TEMPLATE_ID } from '../functions/_shared/monk-cards';
import { MONK_CARD_TEMPLATES } from '../functions/_shared/monk-card-templates';
import { validateMonkCardForm } from '../functions/_shared/monk-card-application';
const origin='https://system.example.test';
const call=async(handler:any,db:any,token:string,data:object,files?:any)=>{
 const request=new Request(origin+'/api/monk-cards/query',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Milgyo-Request':'1',...(token?{Cookie:`__Host-milgyo_session=${token}`}:{})},body:JSON.stringify(data)});
 const r=await handler({request,env:{DB:db,FILES:files}} as any);
 return{status:r.status,headers:r.headers,body:r.headers.get('content-type')?.includes('application/json')?await r.json() as any:Buffer.from(await r.arrayBuffer())};
};
const record=()=>({ordinationRound:'01',dharmaNameKo:'시험법명',dharmaNameHanja:'',layName:'비공개속명',birthDate:'1980-01-02',status:'재적',temple:'시험사찰',acquiredDate:'2000-01-01',firstRegisteredDate:'2000-01-01',lastVerifiedDate:'2000-01-01',ordination:[{kind:'구족계',date:'2000-01-01',place:'시험기관'}],career:[],processingBasis:'동의',sensitiveBasis:'동의',retentionPeriod:'5년',preparedBy:'user:admin'});
const setup=async()=>{
 const db=new SQLiteD1();db.sqlite.exec('PRAGMA foreign_keys=ON');const now=new Date().toISOString();
 await db.prepare(`INSERT INTO system_users(id,name,username,password_hash,role,active,position,can_approve,department,created_at)
 VALUES('admin','담당자','admin','x','admin',1,'사무총장',1,'사무처',?),('approver','결재자','approver','x','admin',1,'총무원장',1,'사무처',?),('viewer','일반사용자','viewer','x','user',1,'실무자',0,'사무처',?)`).bind(now,now,now).run();
 const admin=(await createSession(db as any,'admin')).token,viewer=(await createSession(db as any,'viewer')).token,approver=(await createSession(db as any,'approver')).token;
 const reg=await call(registryAction,db,admin,{operation:'create',content:record()});assert.equal(reg.status,200,reg.body.message);
 return{db,admin,viewer,approver,registry:reg.body.row};
};
const content=(s:any,overrides:object={})=>({registryId:s.registry.id,round:'01',issueKind:'신규',issueDate:cardToday(),applicationDate:cardToday(),receiptDate:cardToday(),supplementDays:0,dharmaNameKo:'시험법명',dharmaNameHanja:'',dharmaRank:'시험법계',temple:'시험사찰',birthDate:'1980-01-02',ordinationDate:'2000-01-01',generalConsent:'동의',sensitiveConsent:'동의',abbotConfirmation:'주지 확인',documentsConfirmed:true,eligibilityConfirmed:true,previousHandling:'해당 없음',...overrides});
const create=async(s:any,v={},requestId='v106-card-request-000001')=>call(cardAction,s.db,s.admin,{operation:'create',requestId,content:content(s,v)});
test('V106 additive migration creates isolated tables, immutable identity and regulation templates',()=>{
 const db=new SQLiteD1();try{assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name LIKE 'monk_%'").get().n,5);
 assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM document_templates WHERE id LIKE 'TPL-MONK-CARD-%'").get().n,2);
 db.sqlite.exec(readFileSync('migrations/main/0014_v106_monk_card_ledger.sql','utf8'));
 assert.deepEqual(db.sqlite.prepare('PRAGMA foreign_key_check').all(),[]);
 const layout=readFileSync('src/layouts/ManagementLayout.astro','utf8'),home=readFileSync('src/pages/index.astro','utf8');
 for(const s of[layout,home])assert.ok(s.indexOf('href="/monastic-register"')<s.indexOf('href="/monk-card-register"')&&s.indexOf('href="/monk-card-register"')<s.indexOf('href="/vehicle-register"'));
 }finally{db.close();}
});
test('dates: five-year minus one day; leap-day convention; irreversible invalidity before expiry',()=>{
 assert.equal(cardExpiry('2026-10-20'),'2031-10-19');assert.equal(cardExpiry('2024-02-29'),'2029-02-28');assert.throws(()=>cardExpiry('2026-02-29'));
 assert.equal(validity({issue_date:'2020-01-01',valid_until:'2025-01-01'},'2025-01-02'),'만료');
 assert.equal(validity({valid_until:'2031-01-01',invalid_date:'2026-01-01'},'2026-10-18'),'무효');
});
test('annual issue numbering is global across rounds, peeks do not reserve, 999 rolls to 1000',async()=>{
 const db=new SQLiteD1();try{
 assert.equal(await reserveCardNumber(db as any,'01','2026-01-01',true),'0126-001');assert.equal(await reserveCardNumber(db as any,'01','2026-01-01',true),'0126-001');
 assert.equal(await reserveCardNumber(db as any,'01','2026-01-01'),'0126-001');assert.equal(await reserveCardNumber(db as any,'02','2026-02-01'),'0226-002');
 await db.prepare('UPDATE monk_card_sequences SET last_seq=999 WHERE issue_year=2026').run();assert.equal(await reserveCardNumber(db as any,'30','2026-01-01'),'3026-1000');
 assert.equal(await reserveCardNumber(db as any,'01','2027-01-01'),'0127-001');
 const parallel=await Promise.all(Array.from({length:10},()=>reserveCardNumber(db as any,'01','2028-01-01')));assert.equal(new Set(parallel).size,10);
 }finally{db.close();}
});
test('all ledger/file endpoints require authenticated admin, even direct object requests',async()=>{
 const s=await setup();try{
 for(const h of[cardQuery,cardAction,upload,download,deleteFile]){
 assert.equal((await call(h,s.db,'',{})).status,401);assert.equal((await call(h,s.db,s.viewer,{})).status,403);
 }
 assert.equal((await downloadGet({} as any)).status,405);
 const r=await call(cardQuery,s.db,s.admin,{operation:'search-registry'});assert.equal(r.status,200);assert.equal(r.body.rows.length,1);
 assert.ok(!JSON.stringify(r.body).includes('비공개속명'));assert.equal(r.body.rows[0].ordinationDate,'2000-01-01');
 }finally{s.db.close();}
});
test('missing migration returns explicit schema readiness error to an admin',async()=>{
 const s=await setup();try{s.db.sqlite.exec('DROP TABLE monk_card_attachments');const r=await call(cardQuery,s.db,s.admin,{operation:'list'});assert.equal(r.status,409);assert.equal(r.body.code,'MONK_CARD_SCHEMA_NOT_READY');}finally{s.db.close();}
});
test('creation assigns server number and validity, persists document number, is idempotent',async()=>{
 const s=await setup();try{
 const a=await create(s,{cardNo:'forged',validUntil:'2099-01-01',internalDocumentNo:'종이-2026-001'});assert.equal(a.status,200,a.body.message);
 assert.equal(a.body.row.card_no,'01'+cardToday().slice(2,4)+'-001');assert.equal(a.body.row.valid_until,cardExpiry(cardToday()));assert.equal(a.body.row.internal_document_no,'종이-2026-001');
 const b=await create(s);assert.equal(b.body.repeated,true);assert.equal(b.body.row.card_no,a.body.row.card_no);
 assert.equal(s.db.sqlite.prepare('SELECT COUNT(*) n FROM monk_card_numbers').get().n,1);
 const list=await call(cardQuery,s.db,s.admin,{operation:'list'});assert.equal(list.body.total,1);assert.equal(list.body.rows[0].validity,'유효');
 assert.equal(s.db.sqlite.prepare('SELECT COUNT(*) n FROM monk_card_changes').get().n,1);
 assert.throws(()=>s.db.sqlite.prepare("UPDATE monk_cards SET card_no='bad' WHERE id=?").run(a.body.row.id),/IDENTITY_IMMUTABLE/);
 }finally{s.db.close();}
});
test('issuance rejects ineligible member, unconfirmed papers, non-consent, identity mismatch and bad dates',async()=>{
 const s=await setup();try{
 for(const v of [{eligibilityConfirmed:false},{documentsConfirmed:false},{generalConsent:'비동의'},{sensitiveConsent:'비동의'},{birthDate:'1980-01-03'},{temple:'다른사찰'},{issueDate:'2099-01-01'},{birthDate:'2026-02-30'},{round:'31'},{issueKind:'기타'}])assert.ok((await create(s,v)).status>=400,JSON.stringify(v));
 s.db.sqlite.prepare("UPDATE monastic_registry SET status='제적' WHERE id=?").run(s.registry.id);assert.equal((await create(s)).status,409);
 assert.equal(s.db.sqlite.prepare('SELECT COUNT(*) n FROM monk_cards').get().n,0);
 }finally{s.db.close();}
});
test('clerical corrections are versioned and cannot mutate issue identity or dates',async()=>{
 const s=await setup();try{
 const a=await create(s);const id=a.body.row.id;
 const v=content(s,{clericalCorrection:true,dharmaRank:'정정법계',issueDate:'2001-01-01',cardNo:'bad'});
 const changed=await call(cardAction,s.db,s.admin,{operation:'update',id,version:1,content:v,reason:'전산 오기'});assert.equal(changed.status,200,changed.body.message);
 assert.equal((await call(cardAction,s.db,s.admin,{operation:'update',id,version:1,content:v,reason:'낡은 페이지'})).status,409);
 const d=await call(cardQuery,s.db,s.admin,{operation:'detail',id});assert.equal(d.body.row.issue_date,a.body.row.issue_date);assert.equal(d.body.row.card_no,a.body.row.card_no);assert.equal(d.body.row.dharma_rank,'정정법계');assert.equal(d.body.changes.length,2);
 }finally{s.db.close();}
});
test('receive, loss, reissue, return and destruction preserve old invalid card and allocate new number',async()=>{
 const s=await setup();try{
 const a=await create(s);const id=a.body.row.id;
 assert.equal((await call(cardAction,s.db,s.admin,{operation:'receive',id,version:1,date:cardToday(),reason:'교부',registeredMailNo:'TEST-REGISTERED-MAIL'})).status,200);
 const bad=await create(s,{issueKind:'재발급',previousId:id,issueReason:'분실'},'v106-reissue-request-001');assert.equal(bad.status,409);
 assert.equal((await call(cardAction,s.db,s.admin,{operation:'invalidate',id,version:2,date:cardToday(),reason:'분실 접수',invalidReason:'분실'})).status,200);
 const b=await create(s,{issueKind:'재발급',previousId:id,issueReason:'분실',previousHandling:'분실 신고함'},'v106-reissue-request-001');assert.equal(b.status,200,b.body.message);assert.notEqual(b.body.row.card_no,a.body.row.card_no);
 let old=(await call(cardQuery,s.db,s.admin,{operation:'detail',id})).body.row;assert.equal(old.validity,'무효');
 assert.equal((await call(cardAction,s.db,s.admin,{operation:'return',id,version:old.version,date:cardToday(),reason:'분실 후 발견'})).status,200);
 old=(await call(cardQuery,s.db,s.admin,{operation:'detail',id})).body.row;
 assert.equal((await call(cardAction,s.db,s.admin,{operation:'destroy',id,version:old.version,date:cardToday(),reason:'반납 처리',destructionMethod:'천공'})).status,200);
 assert.equal((await call(cardAction,s.db,s.admin,{operation:'reactivate',id,version:9,reason:'not allowed'})).status,400);
 }finally{s.db.close();}
});
test('renewal enforces application window and invalidates replaced card in same DB batch',async()=>{
 const s=await setup();try{
 const [y,m,d]=cardToday().split('-').map(Number);const oldIssue=new Date(Date.UTC(y-5,m-1,d+1)).toISOString().slice(0,10);
 const a=await create(s,{issueDate:oldIssue,applicationDate:oldIssue,receiptDate:oldIssue});assert.equal(a.status,200,a.body.message);
 const b=await create(s,{issueKind:'갱신',previousId:a.body.row.id,applicationDate:oldIssue},'v106-renew-request-001');assert.equal(b.status,400);
 const good=await create(s,{issueKind:'갱신',previousId:a.body.row.id,previousHandling:'함께 반납'},'v106-renew-request-001');assert.equal(good.status,200,good.body.message);
 const old=(await call(cardQuery,s.db,s.admin,{operation:'detail',id:a.body.row.id})).body.row;assert.equal(old.validity,'무효');assert.equal(old.return_date,cardToday());assert.equal(good.body.row.valid_until,cardExpiry(cardToday()));
 }finally{s.db.close();}
});
test('registry status loss permanently invalidates cards and retains status-change history',async()=>{
 const s=await setup();try{
 const a=await create(s);s.db.sqlite.prepare("UPDATE monastic_registry SET status='제적' WHERE id=?").run(s.registry.id);
 s.db.sqlite.prepare("UPDATE monastic_registry SET status='재적' WHERE id=?").run(s.registry.id);
 const r=await call(cardQuery,s.db,s.admin,{operation:'detail',id:a.body.row.id});assert.equal(r.body.row.validity,'무효');assert.ok(r.body.changes.some((c:any)=>c.action==='무효'));
 }finally{s.db.close();}
});
test('failed card transaction rolls back ledger/audit but does not recycle reserved number',async()=>{
 const s=await setup();try{
 const baseline=s.db.sqlite.prepare('SELECT COUNT(*) n FROM management_audit_logs').get().n;
 s.db.beforeBatch=(stmts:any[])=>{if(stmts[0]?.sql.startsWith('INSERT INTO monk_cards'))throw new Error('simulated DB outage');};
 await assert.rejects(()=>create(s),/simulated/);s.db.beforeBatch=null;
 assert.equal(s.db.sqlite.prepare('SELECT COUNT(*) n FROM monk_cards').get().n,0);assert.equal(s.db.sqlite.prepare('SELECT COUNT(*) n FROM management_audit_logs').get().n,baseline);
 const good=await create(s);assert.equal(good.status,200,good.body.message);assert.ok(good.body.row.card_no.endsWith('-002'));
 }finally{s.db.close();}
});
test('search is literal and bound, R2 copies stay private with failed deletion safely retryable',async()=>{
 const s=await setup();try{
 const a=await create(s);const id=a.body.row.id,bucket=new TestR2(),file=Buffer.from('%PDF-1.7\nTEST');
 const search=await call(cardQuery,s.db,s.admin,{operation:'list',query:"%' OR 1=1--"});assert.equal(search.body.total,0);
 assert.equal((await call(upload,s.db,s.admin,{cardId:id,fileName:'x.pdf',fileKind:'승려증 사본',dataBase64:file.toString('base64')})).status,409);
 const u=await call(upload,s.db,s.admin,{cardId:id,fileName:'copy.pdf',fileKind:'승려증 사본',dataBase64:file.toString('base64')},bucket);assert.equal(u.status,200,u.body.message);
 const key=[...bucket.objects.keys()][0];assert.ok(key.startsWith('monk-cards/'+id+'/'));const read=await call(download,s.db,s.admin,{attachmentId:u.body.id},bucket);assert.equal(read.status,200);assert.deepEqual(read.body,file);assert.match(read.headers.get('cache-control')||'',/no-store/);
 const originalDelete=bucket.delete.bind(bucket);bucket.delete=async()=>{throw new Error('R2 down');};const fail=await call(deleteFile,s.db,s.admin,{attachmentId:u.body.id,reason:'보유기한 종료'},bucket);assert.equal(fail.body.code,'R2_DELETE_PENDING');assert.equal((await call(download,s.db,s.admin,{attachmentId:u.body.id},bucket)).status,404);assert.equal(bucket.objects.size,1);
 bucket.delete=originalDelete;assert.equal((await call(deleteFile,s.db,s.admin,{attachmentId:u.body.id,reason:'다시 시도'},bucket)).status,200);assert.equal(bucket.objects.size,0);assert.equal(s.db.sqlite.prepare('SELECT COUNT(*) n FROM monk_card_attachments').get().n,0);
 }finally{s.db.close();}
});
test('R2 upload validates extension/signature, attachment cap and rolls back orphan objects',async()=>{
 const s=await setup();try{
 const a=await create(s),b=new TestR2();const p={cardId:a.body.row.id,fileName:'x.pdf',fileKind:'승려증 사본',dataBase64:Buffer.from('%PDF-1.7\nTEST').toString('base64')};
 assert.equal((await call(upload,s.db,s.admin,{...p,fileName:'../x.pdf'},b)).status,400);assert.equal((await call(upload,s.db,s.admin,{...p,fileName:'bad.exe'},b)).status,400);
 assert.equal((await call(upload,s.db,s.admin,{...p,dataBase64:Buffer.from('BAD').toString('base64')},b)).status,400);
 for(let i=0;i<10;i++)assert.equal((await call(upload,s.db,s.admin,p,b)).status,200);
 const over=await call(upload,s.db,s.admin,p,b);assert.equal(over.status,409);assert.equal(b.objects.size,10);
 }finally{s.db.close();}
});
test('global test reset halts before any deletion when regulated monk-card records exist',async()=>{
 const s=await setup();try{
 await create(s);const files=new TestR2();files.objects.set('documents/keep.pdf',Buffer.from('KEEP'));
 await assert.rejects(()=>resetAllTestData({DB:s.db,ACCOUNTING_DB:s.db,FILES:files,ACCOUNTING_FILES:files} as any,{id:'admin',name:'담당자'} as any),/승려증/);
 assert.equal(files.objects.size,1);assert.equal(s.db.sqlite.prepare('SELECT COUNT(*) n FROM monk_cards').get().n,1);assert.equal(s.db.sqlite.prepare('SELECT COUNT(*) n FROM monk_card_numbers').get().n,1);
 }finally{s.db.close();}
});
test('application templates contain separate consent fields and cannot silently substitute for signatures',()=>{
 const app=MONK_CARD_TEMPLATES.find(t=>t.id===CARD_TEMPLATE_ID)!;assert.ok(app.fields.length<=30);assert.ok(app.bodyTemplate.includes('서명'));assert.ok(!app.fields.some(f=>/layName|address|registrationNumber/.test(f.id)));
 assert.ok(validateMonkCardForm(app.fields,{cardPrivacyConsent:'비동의',cardSensitiveConsent:'동의'}));
 const consent=MONK_CARD_TEMPLATES.find(t=>t.id==='TPL-MONK-CARD-CONSENT')!;assert.equal(validateMonkCardForm(consent.fields,{cardPrivacyConsent:'비동의',cardSensitiveConsent:'비동의'}),'');
});
test('template listing and draft submission preserve normal approval flow and force related-person access',async()=>{
 const s=await setup();try{
 const list=await call(listTemplates,s.db,s.admin,{});assert.ok(list.body.rows.find((r:any)=>r.id===CARD_TEMPLATE_ID));
 const draft=await call(createDocument,s.db,s.admin,{saveAsDraft:true,templateId:CARD_TEMPLATE_ID,title:'승려증 시험 신청',department:'사무처',body:'발급 신청 시험',accessScope:'전체',formData:{}});assert.equal(draft.status,200,draft.body.message);
 const r=s.db.sqlite.prepare('SELECT * FROM documents WHERE id=?').get(draft.body.id);assert.equal(r.status,'임시저장');assert.equal(r.access_scope,'관련자');
 assert.equal((await call(detailDocument,s.db,s.viewer,{id:r.id})).status,403);
 const pendingLink=await create(s,{linkedDocumentId:r.id});assert.equal(pendingLink.status,409);
 }finally{s.db.close();}
});
test('new screen JavaScript parses and includes controlled A4, escaping and private file endpoints',()=>{
 const s=readFileSync('src/pages/monk-card-register.astro','utf8');const js=s.split('<script is:inline>')[1].split('</script>')[0];new Function(js);
 assert.match(s,/data-list[>\s]/);assert.ok(s.indexOf('data-editor hidden')<s.indexOf('data-list>'));assert.ok(s.indexOf('data-list>')<s.indexOf('data-detail hidden'));
 assert.match(s,/@page\{size:A4 portrait/);assert.match(s,/monk-cards\/attachment-data/);assert.match(s,/data-application-link/);assert.doesNotMatch(s,/api\/public-forms/);
});


test('submitted application follows existing approval steps, then links the approved document to the card',async()=>{
 const s=await setup();try{
 const app=MONK_CARD_TEMPLATES.find(t=>t.id===CARD_TEMPLATE_ID)!;
 const data:Record<string,string>={};for(const f of app.fields){data[f.id]=f.type==='date'?cardToday():f.options?.[0]||'시험';}
 Object.assign(data,{monasticNo:s.registry.monastic_no,birthDate:'1980-01-02',ordinationDate:'2000-01-01',dharmaNameKo:s.registry.dharma_name_ko,temple:s.registry.temple,photoCheck:'확인',cardPrivacyConsent:'동의',cardSensitiveConsent:'동의',abbotConfirmation:'주지 확인'});
 const doc=await call(createDocument,s.db,s.admin,{templateId:CARD_TEMPLATE_ID,title:'승려증 발급 신청',body:'시험 발급 신청 본문',department:'사무처',approvalMode:'결재',approverUserId:'approver',accessScope:'전체',formData:data});
 assert.equal(doc.status,200,doc.body.message);assert.equal(doc.body.status,'결재대기');
 assert.equal(s.db.sqlite.prepare('SELECT COUNT(*) n FROM monk_cards').get().n,0,'submitting is not issuance');
 const decided=await call(decideDocument,s.db,s.approver,{id:doc.body.id,action:'승인',memo:'시험 승인'});assert.equal(decided.status,200,decided.body.message);assert.equal(decided.body.status,'승인');
 assert.equal(s.db.sqlite.prepare('SELECT COUNT(*) n FROM monk_cards').get().n,0,'approving does not silently issue');
 const record=await create(s,{linkedDocumentId:doc.body.id});assert.equal(record.status,200,record.body.message);assert.equal(record.body.row.internal_document_no,doc.body.id);
 const denied=await call(detailDocument,s.db,s.viewer,{id:doc.body.id});assert.equal(denied.status,403);
 }finally{s.db.close();}
});
test('incorrect person in approved card-application document is rejected',async()=>{
 const s=await setup();try{
 const draft=await call(createDocument,s.db,s.admin,{saveAsDraft:true,templateId:CARD_TEMPLATE_ID,title:'시험',department:'사무처',formData:{monasticNo:'wrong-person'}});
 s.db.sqlite.prepare("UPDATE documents SET status='승인' WHERE id=?").run(draft.body.id);
 assert.equal((await create(s,{linkedDocumentId:draft.body.id})).status,409);
 }finally{s.db.close();}
});
test('stale update between read and batch creates no false history entries',async()=>{
 const s=await setup();try{
 const created=await create(s);const id=created.body.row.id;const before=s.db.sqlite.prepare('SELECT COUNT(*) n FROM monk_card_changes').get().n;
 s.db.beforeBatch=(stmts:any[])=>{if(stmts[0]?.sql.startsWith('UPDATE monk_cards')){s.db.sqlite.prepare('UPDATE monk_cards SET version=version+1 WHERE id=?').run(id);s.db.beforeBatch=null;}};
 const r=await call(cardAction,s.db,s.admin,{operation:'receive',id,version:1,date:cardToday(),reason:'race',receiptConfirmation:'confirmed'});
 assert.equal(r.status,409);assert.equal(s.db.sqlite.prepare('SELECT COUNT(*) n FROM monk_card_changes').get().n,before);
 }finally{s.db.close();}
});
