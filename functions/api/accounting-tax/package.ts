import { authenticateSession, clean, ensureTables, json } from '../../_shared/helpers';
import { canViewAllAccounting, ensureAccountingTables, hasAccountingAccess } from '../../_shared/accounting';
import { ensureAccountingTaxTables, validTaxDate, validTaxYear } from '../../_shared/accounting-tax';
import {
  getTaxExportDownload,
  getTaxExportStatus,
  processNextTaxExport,
  queueTaxExport,
} from '../../_shared/accounting-tax-export';

interface Env { DB: D1Database; ACCOUNTING_DB: D1Database; ACCOUNTING_FILES?: R2Bucket; }
type Payload = Record<string, unknown> & { token?: string; action?: string };

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB || !env.ACCOUNTING_DB) return json({ ok: false, message: '전자문서 DB 또는 회계 전용 DB가 연결되지 않았습니다.' }, 500);
  if (!env.ACCOUNTING_FILES) return json({ ok: false, message: '제출 패키지 보관용 회계 R2 저장소가 연결되지 않았습니다.' }, 503);
  let payload: Payload;
  try { payload = await request.json(); } catch { return json({ ok: false, message: '요청 형식이 올바르지 않습니다.' }, 400); }
  await ensureTables(env.DB);
  const auth = await authenticateSession(env.DB, clean(payload.token, 200));
  if (!auth.ok) return json({ ok: false, message: auth.message }, auth.status);
  if (!hasAccountingAccess(auth.user) || !canViewAllAccounting(auth.user)) {
    return json({ ok: false, message: '세무사 제출 패키지를 처리할 권한이 없습니다.' }, 403);
  }
  try {
    const db=env.ACCOUNTING_DB,bucket=env.ACCOUNTING_FILES;
    await ensureAccountingTables(db);
    await ensureAccountingTaxTables(db);
    const action=clean(payload.action,30)||'queue';

    if (action==='queue') {
      const year=validTaxYear(payload.year),periodStart=clean(payload.periodStart,10)||`${year}-01-01`,periodEnd=clean(payload.periodEnd,10)||`${year}-12-31`;
      if (!year||!validTaxDate(periodStart)||!validTaxDate(periodEnd)||periodStart>periodEnd
        ||Number(periodStart.slice(0,4))!==year||Number(periodEnd.slice(0,4))!==year) {
        return json({ok:false,message:'회계연도와 제출기간을 같은 연도 안에서 정확히 선택해 주세요.'},400);
      }
      if (payload.allowValidationErrors===true) {
        return json({ok:false,message:'검증 오류가 있는 세무자료는 예외 없이 제출 패키지로 생성할 수 없습니다.'},400);
      }
      const requestId=clean(payload.requestId,100);
      if (!requestId) return json({ok:false,message:'중복 작업 방지용 요청번호가 없습니다. 화면을 새로고침한 뒤 다시 시도해 주세요.'},400);
      const result=await queueTaxExport(db,{year,periodStart,periodEnd,bookTypeCode:clean(payload.bookTypeCode,30),
        entityId:clean(payload.entityId,80),fundId:clean(payload.fundId,80),allowValidationErrors:false,requestId},auth.user);
      return json({ok:true,...result,message:result.duplicate?'같은 요청의 기존 패키지 작업을 확인했습니다.':'스냅샷 제출 패키지 작업을 등록했습니다.'},result.duplicate?200:202);
    }

    const batchId=clean(payload.id,100);
    if (!batchId) return json({ok:false,message:'제출 패키지 작업번호를 확인해 주세요.'},400);
    if (action==='status') return json({ok:true,...await getTaxExportStatus(db,batchId)});
    if (action==='process') {
      const result=await processNextTaxExport(db,bucket,batchId);
      if ((result as any).idle) return json({ok:true,...await getTaxExportStatus(db,batchId)});
      return json({ok:(result as any).status!=='failed',...result},(result as any).status==='failed'?409:200);
    }
    if (action==='download') return getTaxExportDownload(db,bucket,batchId);
    return json({ok:false,message:'지원하지 않는 제출 패키지 처리입니다.'},400);
  } catch (error) {
    console.error('tax package processing failed',error);
    const typed=error as Error & {validation?:unknown};
    const message=typed instanceof Error?typed.message:'세무사 제출 패키지 처리 중 오류가 발생했습니다.';
    if (typed.validation) return json({ok:false,message,validation:typed.validation},409);
    if (/찾을 수 없습니다|확인해 주세요|일치하지 않아|변경되어/.test(message)) return json({ok:false,message},409);
    return json({ok:false,message},500);
  }
};

export const onRequestGet: PagesFunction = async () => json({ok:false,message:'POST 방식으로 요청해 주세요.'},405);
