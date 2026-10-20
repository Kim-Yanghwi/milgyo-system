/** Private ledger for the supplied monk-card regulation. No public card lookup or image issue endpoint. */
import { authenticateSession, getSessionToken, clean, ensureTables, isValidIsoDate, json, randomHex, type SessionUser } from './helpers';
export interface MonkCardEnv { DB: D1Database; FILES?: R2Bucket }
export type Row = Record<string, any>;
export const CARD_TYPES = ['신규','재발급','갱신'] as const;
export const CARD_FILE_TYPES = ['승려증 사본','발급신청서','사진','동의서','분실신고서','반납서','기타 증빙'] as const;
export const CARD_TEMPLATE_ID = 'TPL-MONK-CARD-APPLICATION';
export const CARD_CONSENT_TEMPLATE_ID = 'TPL-MONK-CARD-CONSENT';
export const cardToday = () => new Date(Date.now()+9*3600000).toISOString().slice(0,10);
export class CardError extends Error { constructor(message: string, public status=400, public code='MONK_CARD_INVALID'){super(message);} }
export const must = (value: unknown, message: string, status=400): void => { if(!value) throw new CardError(message,status); };
export const cardDate = (value: unknown, label: string, required=true): string => {
 const s=clean(value,10); if(!s&&!required)return '';
 must(/^\d{4}-\d{2}-\d{2}$/.test(s)&&isValidIsoDate(s)&&Number(s.slice(0,4))>=1900,`${label}: YYYY-MM-DD`);
 return s;
};
export const addDays = (value: string, n: number) => new Date(Date.parse(value+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
/** Feb 29 convention: JS UTC anniversary rolls to March 1, then subtract one day => Feb 28.
 * Regulation does not expressly specify leap-day handling; document this convention for owner approval. */
export const cardExpiry = (issued: string): string => {
 const valid=cardDate(issued,'발급일');const [y,m,d]=valid.split('-').map(Number);
 return new Date(Date.UTC(y+5,m-1,d)-86400000).toISOString().slice(0,10);
};
export const retentionDate = (end: string) => { const [y,m,d]=end.split('-').map(Number);return new Date(Date.UTC(y+1,m-1,d)).toISOString().slice(0,10); };
export const validity = (r: Row, today=cardToday()): string => r.invalid_date||r.return_date||r.destroyed_date|| (r.registry_status&&r.registry_status!=='재적') ? '무효' : r.valid_until<today ? '만료' : r.issue_date>today ? '유효 전' : '유효';
export const cardPublicFields = 'id,monastic_no,dharma_name_ko,dharma_name_hanja,birth_date,temple,ordination_json,status,version';
export const registryDefaults = (r: Row) => {
 let records: Row[]=[];try {const v=JSON.parse(r.ordination_json||'[]');if(Array.isArray(v))records=v;}catch{}
 const dates=records.filter(x=>x.kind!=='법계 / 품수'&&isValidIsoDate(String(x.date||''))).map(x=>x.date).sort();
 return {id:r.id,monasticNo:r.monastic_no,dharmaNameKo:r.dharma_name_ko,dharmaNameHanja:r.dharma_name_hanja||'',
 birthDate:r.birth_date||'',temple:r.temple||'',ordinationDate:dates[0]||'',status:r.status};
};
export const searchTerm = (value: unknown) => `%${clean(value,100).replace(/[!%_]/g,c=>'!'+c)}%`;
export const resultRow = (r: Row) => ({...r,validity:validity(r),renewalFrom:addDays(r.valid_until,-90),
 applicationRetentionDue:retentionDate(r.invalid_date&&r.invalid_date<r.valid_until?r.invalid_date:r.valid_until),issuerTitle:'대한불교밀교종 총무원장'});
export async function cardHandler(request: Request, env: MonkCardEnv, fn: (p:Row,user:SessionUser)=>Promise<Response>): Promise<Response> {
 if(!env.DB)return json({ok:false,message:'D1(DB) 연결이 필요합니다.'},503);
 await ensureTables(env.DB);
 const auth=await authenticateSession(env.DB,getSessionToken(request));
 if(!auth.ok)return json({ok:false,code:auth.code,message:auth.message},auth.status);
 if(auth.user.role!=='admin')return json({ok:false,message:'승려증 대장은 관리자만 사용할 수 있습니다.'},403);
 let p: Row;try{p=await request.json();if(!p||typeof p!=='object'||Array.isArray(p))throw new Error();}catch{return json({ok:false,message:'요청 형식을 확인해 주세요.'},400);}
 const ready=await env.DB.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('monk_cards','monk_card_numbers','monk_card_sequences','monk_card_changes','monk_card_attachments')").first<{n:number}>();
 if(Number(ready?.n)!==5)return json({ok:false,code:'MONK_CARD_SCHEMA_NOT_READY',message:'승려증 DB 준비가 필요합니다. DB에 0014_v106_monk_card_ledger.sql 마이그레이션을 적용해 주세요.'},409);
 try{return await fn(p,auth.user);}catch(error){if(error instanceof CardError)return json({ok:false,code:error.code,message:error.message},error.status);throw error;}
}
export const postOnly: PagesFunction = async()=>json({ok:false,message:'POST 요청만 지원합니다.'},405);
export async function reserveCardNumber(db:D1Database,issued:string,peek=false):Promise<string>{
 cardDate(issued,'발급일');const year=Number(issued.slice(0,4));
 let n:number;
 if(peek){const r=await db.prepare('SELECT last_seq FROM monk_card_sequences WHERE issue_year=?').bind(year).first<{last_seq:number}>();n=Number(r?.last_seq||0)+1;}
 else {const r=await db.prepare('INSERT INTO monk_card_sequences(issue_year,last_seq) VALUES(?,1) ON CONFLICT(issue_year) DO UPDATE SET last_seq=last_seq+1 RETURNING last_seq').bind(year).first<{last_seq:number}>();n=Number(r?.last_seq);}
 must(Number.isSafeInteger(n)&&n>0&&n<=9999,'연간 9,999건을 초과했습니다. 추가 채번 기준을 확인해 주세요.',409);
 const number=`${year}-${String(n).padStart(3,'0')}`;
 if(!peek)await db.prepare('INSERT INTO monk_card_numbers(card_no,issue_year,serial_no,reserved_at) VALUES(?,?,?,?)').bind(number,year,n,new Date().toISOString()).run();
 return number;
}
export async function linkedDocument(db:D1Database,id:unknown,manual:unknown,expectedMonasticNo?:string):Promise<{id:string;no:string}>{
 const key=clean(id,60);if(!key)return{id:'',no:clean(manual,120)};
 const doc=await db.prepare('SELECT id,status,template_id,form_data_json FROM documents WHERE id=?').bind(key).first<Row>();
 must(doc,'연계할 내부문서를 찾을 수 없습니다.',404);
 must(['승인','발송완료'].includes(doc!.status),'발급 근거 문서는 결재 완료 문서만 연계할 수 있습니다.',409);
 if(expectedMonasticNo && doc!.template_id===CARD_TEMPLATE_ID){
  let data:Row={};try{data=JSON.parse(doc!.form_data_json||'{}');}catch{}
  must(String(data.monasticNo||'')===expectedMonasticNo,'신청문서의 승적번호가 대장 대상자와 다릅니다.',409);
 }
 return{id:key,no:key};
}
export function changeStatement(db:D1Database,id:string,action:string,reason:string,before:Row,after:Row,user:SessionUser,now:string){
 return db.prepare('INSERT INTO monk_card_changes(id,card_id,action,reason,before_json,after_json,actor_user_id,actor_name,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
 .bind('MCCH-'+randomHex(24),id,action,reason,JSON.stringify(before),JSON.stringify(after),user.id,user.name,now);
}
export function auditStatement(db:D1Database,id:string,action:string,user:SessionUser,now:string){
 return db.prepare('INSERT INTO management_audit_logs(id,category,action,target_id,actor_user_id,actor_name,details_json,created_at) VALUES(?,?,?,?,?,?,?,?)')
 .bind('MAL-'+randomHex(24),'승려증',action,id,user.id,user.name,'{}',now);
}
export const cardLabels:Record<string,string>={card_no:'발급번호',monastic_no:'승적번호',issue_kind:'구분',issue_date:'발급일',valid_until:'만료일',dharma_name_ko:'법명(한글)',dharma_name_hanja:'법명(한자)',dharma_rank:'법계',temple:'소속사찰',birth_date:'생년월일',ordination_date:'수계일',application_date:'신청일',receipt_date:'접수일',supplement_days:'보완 소요일',internal_document_no:'내부문서번호',received_date:'수령일',receipt_confirmation:'수령 확인',registered_mail_no:'등기번호',invalid_date:'무효일',invalid_reason:'무효 사유',return_date:'반납일',return_reason:'반납 사유',destroyed_date:'폐기일',destruction_method:'폐기 방법',remarks:'비고',issue_reason:'발급 사유',previous_handling:'종전 승려증 처리',general_consent:'일반정보 동의',sensitive_consent:'민감정보 동의',abbot_confirmation:'주지 확인'};
