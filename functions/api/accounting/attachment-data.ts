import { authenticateSession, clean, ensureTables, json, randomHex, toHex } from '../../_shared/helpers';
import { ensureAccountingTables } from '../../_shared/accounting';
import {
  arrayBufferToBase64,
  authorizeAccountingReference,
  normalizeAccountingReferenceType,
} from '../../_shared/accounting-attachments';

interface Env {
  DB: D1Database;
  ACCOUNTING_DB: D1Database;
  ACCOUNTING_FILES?: R2Bucket;
}

type Payload = {
  token?: string;
  attachmentId?: number | string;
  binary?: boolean;
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB || !env.ACCOUNTING_DB) {
    return json({ ok: false, message: '전자문서 DB 또는 회계 전용 DB가 연결되지 않았습니다.' }, 500);
  }
  if (!env.ACCOUNTING_FILES) {
    return json({ ok: false, message: '회계 첨부파일 저장소(ACCOUNTING_FILES)가 연결되지 않았습니다.' }, 503);
  }

  let payload: Payload;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, message: '요청 형식이 올바르지 않습니다.' }, 400);
  }

  await ensureTables(env.DB);
  const auth = await authenticateSession(env.DB, clean(payload.token, 200));
  if ('message' in auth) return json({ ok: false, message: auth.message }, auth.status);
  await ensureAccountingTables(env.ACCOUNTING_DB);

  const attachmentId = Number(payload.attachmentId);
  if (!Number.isInteger(attachmentId) || attachmentId <= 0) {
    return json({ ok: false, message: '첨부파일 식별번호를 확인해 주세요.' }, 400);
  }

  const attachment = await env.ACCOUNTING_DB.prepare(`
    SELECT id,reference_type,reference_id,file_category,original_filename,object_key,
           content_type,size_bytes,checksum_sha256,uploaded_by,uploaded_at
    FROM accounting_attachments
    WHERE id=? AND deleted_at IS NULL
  `).bind(attachmentId).first<any>();
  if (!attachment) return json({ ok: false, message: '회계 첨부파일을 찾을 수 없습니다.' }, 404);

  const referenceType = normalizeAccountingReferenceType(attachment.reference_type);
  if (!referenceType) return json({ ok: false, message: '첨부파일의 회계자료 구분이 올바르지 않습니다.' }, 500);

  const access = await authorizeAccountingReference(
    env.ACCOUNTING_DB,
    auth.user,
    referenceType,
    clean(attachment.reference_id, 100),
    'read',
  );
  if (!access.ok) return json({ ok: false, message: access.message || '첨부파일 열람 권한이 없습니다.' }, access.exists ? 403 : 404);

  const object = await env.ACCOUNTING_FILES.get(String(attachment.object_key || ''));
  if (!object) return json({ ok: false, message: 'R2에서 회계 첨부파일을 찾을 수 없습니다.' }, 404);

  const buffer = await object.arrayBuffer();
  const actualChecksum = toHex(await crypto.subtle.digest('SHA-256', buffer));
  const expectedSize = Number(attachment.size_bytes || 0);
  const expectedChecksum = String(attachment.checksum_sha256 || '').toLowerCase();
  const issueType = expectedSize !== buffer.byteLength ? 'SIZE_MISMATCH'
    : expectedChecksum && expectedChecksum !== actualChecksum ? 'CHECKSUM_MISMATCH' : '';
  if (issueType) {
    const now = new Date().toISOString(), issueKey = `${issueType}:${attachment.object_key}`;
    await env.ACCOUNTING_DB.prepare(`INSERT INTO accounting_attachment_integrity_issues
      (id,issue_key,issue_type,attachment_id,object_key,reference_type,reference_id,status,details_json,detected_at,last_seen_at)
      VALUES (?,?,?,?,?,?,?,'open',?,?,?)
      ON CONFLICT(issue_key) DO UPDATE SET status='open',details_json=excluded.details_json,last_seen_at=excluded.last_seen_at,
        resolved_at=NULL,resolved_by=NULL,resolution_action=NULL`)
      .bind(`AII-${randomHex(22)}`, issueKey, issueType, attachment.id, attachment.object_key, attachment.reference_type,
        attachment.reference_id, JSON.stringify({ expectedSize, actualSize: buffer.byteLength, expectedChecksum, actualChecksum }), now, now).run();
    return json({ ok: false, message: '첨부파일의 크기 또는 SHA-256이 등록 당시 정보와 달라 다운로드를 차단했습니다. 무결성 점검이 필요합니다.' }, 409);
  }
  const mimeType = attachment.content_type || object.httpMetadata?.contentType || 'application/octet-stream';
  const fileName = String(attachment.original_filename || 'attachment');
  if (payload.binary === true) {
    const encodedFileName = encodeURIComponent(fileName);
    return new Response(buffer, {
      status: 200,
      headers: {
        'Content-Type': mimeType,
        'Content-Length': String(buffer.byteLength),
        'Content-Disposition': `attachment; filename*=UTF-8''${encodedFileName}`,
        'X-File-Name': encodedFileName,
        'Cache-Control': 'private, no-store',
      },
    });
  }
  return json({
    ok: true,
    id: attachment.id,
    referenceType,
    referenceId: attachment.reference_id,
    fileCategory: attachment.file_category,
    fileName,
    mimeType,
    sizeBytes: Number(attachment.size_bytes || buffer.byteLength),
    checksumSha256: actualChecksum,
    dataBase64: arrayBufferToBase64(buffer),
  });
};

export const onRequestGet: PagesFunction = async () =>
  json({ ok: false, message: 'POST 방식으로 요청해 주세요.' }, 405);
