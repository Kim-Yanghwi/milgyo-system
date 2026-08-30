import { ensureTables, json } from '../_shared/helpers';
import { ensureAccountingTables } from '../_shared/accounting';
interface Env { DB:D1Database; ACCOUNTING_DB?:D1Database; ACCOUNTING_FILES?:R2Bucket; }
export const onRequestGet:PagesFunction<Env>=async({env})=>{
  if(!env.DB)return json({ok:false,message:'서비스 준비 상태를 확인할 수 없습니다.'},503);
  try{await ensureTables(env.DB);if(!env.ACCOUNTING_DB||!env.ACCOUNTING_FILES)return json({ok:false,message:'서비스 준비가 완료되지 않았습니다.'},503);await ensureAccountingTables(env.ACCOUNTING_DB);return json({ok:true,message:'정상'});}
  catch(error){console.error('health check failed',error);return json({ok:false,message:'서비스 점검이 필요합니다.'},503);}
};
export const onRequestPost=onRequestGet;
