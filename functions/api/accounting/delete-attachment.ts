import { authenticateSession, clean, ensureTables, json } from '../../_shared/helpers';
import { ensureAccountingTables, isAccountingManager } from '../../_shared/accounting';
import {
  accountingAttachmentAuditStatement,
  authorizeAccountingReference,
  normalizeAccountingReferenceType,
} from '../../_shared/accounting-attachments';
import {
  getAccountingAttachmentPolicy,
  recordAccountingAttachmentOperation,
} from '../../_shared/accounting-attachment-ops';

interface Env {
  DB: D1Database;
  ACCOUNTING_DB: D1Database;
  ACCOUNTING_FILES?: R2Bucket;
}

type Payload = { token?: string; attachmentId?: number | string; reason?: string };

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB || !env.ACCOUNTING_DB) return json({ ok: false, message: '전자문서 DB 또는 회계 전용 DB가 연결되지 않았습니다.' }, 500);
  if (!env.ACCOUNTING_FILES) return json({ ok: false, message: '회계 첨부파일 저장소(ACCOUNTING_FILES)가 연결되지 않았습니다.' }, 503);

  let payload: Payload;
  try { payload = await request.json(); }
  catch { return json({ ok: false, message: '요청 형식이 올바르지 않습니다.' }, 400); }

  await ensureTables(env.DB);
  const auth = await authenticateSession(env.DB, clean(payload.token, 200));
  if ('message' in auth) return json({ ok: false, message: auth.message }, auth.status);
  await ensureAccountingTables(env.ACCOUNTING_DB);

  const attachmentId = Number(payload.attachmentId);
  if (!Number.isInteger(attachmentId) || attachmentId <= 0) return json({ ok: false, message: '첨부파일 식별번호를 확인해 주세요.' }, 400);

  const attachment = await env.ACCOUNTING_DB.prepare(`
    SELECT id,reference_type,reference_id,original_filename,object_key,uploaded_by,delete_status
    FROM accounting_attachments WHERE id=? AND deleted_at IS NULL
  `).bind(attachmentId).first<any>();
  if (!attachment) return json({ ok: false, message: '삭제할 회계 첨부파일을 찾을 수 없습니다.' }, 404);

  const referenceType = normalizeAccountingReferenceType(attachment.reference_type);
  if (!referenceType) return json({ ok: false, message: '첨부파일의 회계자료 구분이 올바르지 않습니다.' }, 500);
  const access = await authorizeAccountingReference(env.ACCOUNTING_DB, auth.user, referenceType, clean(attachment.reference_id, 100), 'write');
  if (!access.ok) return json({ ok: false, message: access.message || '첨부파일 삭제 권한이 없습니다.' }, access.exists ? 403 : 404);

  const manager = isAccountingManager(auth.user);
  if (!manager && String(attachment.uploaded_by || '') !== auth.user.id) return json({ ok: false, message: '본인이 등록한 첨부파일만 삭제할 수 있습니다.' }, 403);

  const policy = await getAccountingAttachmentPolicy(env.ACCOUNTING_DB);
  const reason = clean(payload.reason, 500);
  if (policy.requireDeleteReason && !reason) return json({ ok: false, message: '첨부파일 삭제 사유를 입력해 주세요.' }, 400);

  const now = new Date().toISOString();
  const marked = await env.ACCOUNTING_DB.prepare(`
    UPDATE accounting_attachments
    SET delete_status='deleting',delete_reason=?,deleted_by=?,delete_error=NULL
    WHERE id=? AND deleted_at IS NULL AND COALESCE(delete_status,'active') IN ('active','error')
    RETURNING id
  `).bind(reason || null, auth.user.id, attachmentId).first<{ id: number }>();
  if (!marked) return json({ ok: false, message: '첨부파일이 이미 삭제 중이거나 상태가 변경되었습니다.' }, 409);

  try {
    await env.ACCOUNTING_FILES.delete(String(attachment.object_key || ''));
    await env.ACCOUNTING_DB.prepare(`
      UPDATE accounting_attachments
      SET deleted_at=?,deleted_by=?,delete_status='deleted',delete_error=NULL,last_checked_at=?
      WHERE id=?
    `).bind(now, auth.user.id, now, attachmentId).run();
  } catch (error) {
    await env.ACCOUNTING_DB.prepare(`
      UPDATE accounting_attachments SET delete_status='error',delete_error=? WHERE id=?
    `).bind(clean(error instanceof Error ? error.message : String(error), 1000), attachmentId).run().catch(() => undefined);
    await recordAccountingAttachmentOperation(env.ACCOUNTING_DB, {
      operationType: 'attachment_delete', attachmentId, objectKey: String(attachment.object_key || ''),
      referenceType, referenceId: clean(attachment.reference_id, 100), error,
    }).catch(() => undefined);
    console.error('accounting attachment R2 delete failed', error);
    return json({ ok: false, message: 'R2 첨부파일 삭제에 실패했습니다. 관리자 재처리 목록에 등록했습니다.' }, 500);
  }

  await accountingAttachmentAuditStatement(
    env.ACCOUNTING_DB, 'attachment-delete', referenceType, clean(attachment.reference_id, 100), auth.user,
    { attachmentId, originalFilename: attachment.original_filename, reason }, now,
  ).run().catch((error) => console.warn('accounting attachment delete audit failed', error));

  return json({ ok: true, id: attachmentId, message: '회계 첨부파일을 삭제했습니다.' });
};

export const onRequestGet: PagesFunction = async () =>
  json({ ok: false, message: 'POST 방식으로 요청해 주세요.' }, 405);
