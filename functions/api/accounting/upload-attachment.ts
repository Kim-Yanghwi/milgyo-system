import {
  authenticateSession,
  clean,
  ensureTables,
  json,
  randomHex,
  toHex,
} from '../../_shared/helpers';
import { ensureAccountingTables } from '../../_shared/accounting';
import {
  accountingAttachmentAuditStatement,
  authorizeAccountingReference,
  decodeAccountingAttachmentBase64,
  normalizeAccountingFileCategory,
  normalizeAccountingReferenceType,
  safeAccountingObjectName,
} from '../../_shared/accounting-attachments';
import {
  getAccountingAttachmentPolicy,
  inspectAccountingAttachment,
  recordAccountingAttachmentOperation,
  retentionDate,
} from '../../_shared/accounting-attachment-ops';

interface Env {
  DB: D1Database;
  ACCOUNTING_DB: D1Database;
  ACCOUNTING_FILES?: R2Bucket;
}

type Payload = {
  token?: string;
  referenceType?: string;
  referenceId?: string;
  fileCategory?: string;
  fileName?: string;
  mimeType?: string;
  dataBase64?: string;
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB || !env.ACCOUNTING_DB) {
    return json({ ok: false, message: '전자문서 DB 또는 회계 전용 DB가 연결되지 않았습니다.' }, 500);
  }
  if (!env.ACCOUNTING_FILES) {
    return json({ ok: false, message: '회계 첨부파일 저장소(ACCOUNTING_FILES)가 연결되지 않았습니다.' }, 503);
  }

  let payload: Payload;
  let uploadedFile: File | null = null;
  const requestContentType = request.headers.get('content-type') || '';
  try {
    if (requestContentType.includes('multipart/form-data')) {
      const form = await request.formData();
      const filePart = form.get('file');
      uploadedFile = filePart && typeof filePart !== 'string' && typeof filePart.arrayBuffer === 'function'
        ? filePart as File
        : null;
      payload = {
        token: String(form.get('token') || ''),
        referenceType: String(form.get('referenceType') || ''),
        referenceId: String(form.get('referenceId') || ''),
        fileCategory: String(form.get('fileCategory') || ''),
        fileName: uploadedFile?.name || String(form.get('fileName') || ''),
        mimeType: uploadedFile?.type || String(form.get('mimeType') || ''),
      };
    } else {
      payload = await request.json();
    }
  } catch {
    return json({ ok: false, message: '요청 형식이 올바르지 않습니다.' }, 400);
  }

  await ensureTables(env.DB);
  const auth = await authenticateSession(env.DB, clean(payload.token, 200));
  if ('message' in auth) return json({ ok: false, message: auth.message }, auth.status);
  await ensureAccountingTables(env.ACCOUNTING_DB);

  const referenceType = normalizeAccountingReferenceType(payload.referenceType);
  const referenceId = clean(payload.referenceId, 100);
  const fileCategory = normalizeAccountingFileCategory(payload.fileCategory);
  const originalFilename = clean(payload.fileName, 220);
  const contentType = clean(payload.mimeType, 140) || 'application/octet-stream';
  const dataBase64 = typeof payload.dataBase64 === 'string' ? payload.dataBase64 : '';

  if (!referenceType || !referenceId || !originalFilename || (!uploadedFile && !dataBase64)) {
    return json({ ok: false, message: '회계자료 및 첨부파일 정보가 부족합니다.' }, 400);
  }

  const access = await authorizeAccountingReference(env.ACCOUNTING_DB, auth.user, referenceType, referenceId, 'write');
  if (!access.ok) return json({ ok: false, message: access.message || '첨부 권한이 없습니다.' }, access.exists ? 403 : 404);

  const bytes = uploadedFile
    ? new Uint8Array(await uploadedFile.arrayBuffer())
    : decodeAccountingAttachmentBase64(dataBase64);
  if (!bytes) return json({ ok: false, message: '첨부파일 인코딩이 올바르지 않습니다.' }, 400);

  const policy = await getAccountingAttachmentPolicy(env.ACCOUNTING_DB);
  const inspection = inspectAccountingAttachment(originalFilename, bytes, policy);
  if (!inspection.ok) return json({ ok: false, message: inspection.message }, 400);

  const usage = await env.ACCOUNTING_DB.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(size_bytes),0) AS total_bytes
    FROM accounting_attachments
    WHERE reference_type=? AND reference_id=? AND deleted_at IS NULL
  `).bind(referenceType, referenceId).first<{ count: number; total_bytes: number }>();
  if (Number(usage?.count || 0) >= policy.maxFilesPerReference) {
    return json({ ok: false, message: `회계자료별 첨부파일은 최대 ${policy.maxFilesPerReference}개까지 등록할 수 있습니다.` }, 400);
  }
  if (Number(usage?.total_bytes || 0) + bytes.byteLength > policy.maxTotalBytesPerReference) {
    return json({ ok: false, message: `회계자료별 첨부파일 총용량은 최대 ${(policy.maxTotalBytesPerReference / 1024 / 1024).toFixed(0)}MB입니다.` }, 400);
  }

  const now = new Date().toISOString();
  const storedFilename = `AATT-${randomHex(24)}-${safeAccountingObjectName(originalFilename)}`;
  const objectKey = `accounting/${referenceType}/${referenceId}/${storedFilename}`;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const checksumSha256 = toHex(digest);

  try {
    await env.ACCOUNTING_FILES.put(objectKey, bytes, {
      httpMetadata: { contentType },
      customMetadata: {
        originalFilename,
        referenceType,
        referenceId,
        uploadedBy: auth.user.id,
        checksumSha256,
        scanStatus: inspection.scanStatus,
      },
    });
  } catch (error) {
    console.error('accounting attachment R2 put failed', error);
    return json({ ok: false, message: '회계 첨부파일을 R2에 저장하지 못했습니다.' }, 500);
  }

  try {
    const result = await env.ACCOUNTING_DB.prepare(`
      INSERT INTO accounting_attachments
        (reference_type,reference_id,file_category,original_filename,stored_filename,object_key,
         content_type,size_bytes,checksum_sha256,uploaded_by,uploaded_at,retention_until,
         scan_status,scan_message,delete_status,last_checked_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'active',?)
      RETURNING id
    `).bind(
      referenceType, referenceId, fileCategory, originalFilename, storedFilename, objectKey,
      contentType, bytes.byteLength, checksumSha256, auth.user.id, now,
      retentionDate(now, policy.retentionDays), inspection.scanStatus, inspection.scanMessage, now,
    ).first<{ id: number }>();

    await accountingAttachmentAuditStatement(
      env.ACCOUNTING_DB,
      'attachment-upload',
      referenceType,
      referenceId,
      auth.user,
      {
        attachmentId: result?.id, originalFilename, fileCategory, sizeBytes: bytes.byteLength,
        checksumSha256, scanStatus: inspection.scanStatus, retentionDays: policy.retentionDays,
      },
      now,
    ).run().catch((error) => console.warn('accounting attachment audit write failed', error));

    return json({
      ok: true,
      id: Number(result?.id || 0),
      referenceType,
      referenceId,
      fileCategory,
      fileName: originalFilename,
      contentType,
      sizeBytes: bytes.byteLength,
      checksumSha256,
      scanStatus: inspection.scanStatus,
      storageType: 'r2',
      message: '회계 첨부파일이 등록되었습니다.',
    });
  } catch (error) {
    try { await env.ACCOUNTING_FILES.delete(objectKey); }
    catch (cleanupError) {
      await recordAccountingAttachmentOperation(env.ACCOUNTING_DB, {
        operationType: 'compensation_delete', objectKey, referenceType, referenceId, error: cleanupError,
      }).catch(() => undefined);
    }
    console.error('accounting attachment metadata insert failed', error);
    return json({ ok: false, message: '회계 첨부파일 메타데이터 저장 중 오류가 발생했습니다.' }, 500);
  }
};

export const onRequestGet: PagesFunction = async () =>
  json({ ok: false, message: 'POST 방식으로 요청해 주세요.' }, 405);
