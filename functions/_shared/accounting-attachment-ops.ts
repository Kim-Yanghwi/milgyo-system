import { clean, randomHex, toHex, type SessionUser } from './helpers';
import { ACCOUNTING_R2_PREFIX, assertAccountingR2Key } from './r2-scope-guard';

export type AccountingAttachmentPolicy = {
  allowedExtensions: string[];
  maxFileBytes: number;
  maxFilesPerReference: number;
  maxTotalBytesPerReference: number;
  retentionDays: number;
  requireDeleteReason: boolean;
};

export const DEFAULT_ACCOUNTING_ATTACHMENT_POLICY: AccountingAttachmentPolicy = {
  allowedExtensions: ['pdf', 'jpg', 'jpeg', 'png', 'hwp', 'hwpx', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'txt'],
  maxFileBytes: 4 * 1024 * 1024,
  maxFilesPerReference: 10,
  maxTotalBytesPerReference: 20 * 1024 * 1024,
  retentionDays: 3650,
  requireDeleteReason: true,
};

const positiveInteger = (value: unknown, fallback: number, min: number, max: number) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
};

export const normalizeAllowedExtensions = (value: unknown) => {
  const entries = String(value ?? '')
    .toLowerCase()
    .split(/[\s,;]+/)
    .map((item) => item.replace(/^\./, '').replace(/[^a-z0-9]/g, ''))
    .filter(Boolean);
  return Array.from(new Set(entries)).slice(0, 40);
};

export const getAccountingAttachmentPolicy = async (db: D1Database): Promise<AccountingAttachmentPolicy> => {
  const row = await db.prepare(`
    SELECT allowed_extensions,max_file_bytes,max_files_per_reference,
           max_total_bytes_per_reference,retention_days,require_delete_reason
    FROM accounting_attachment_policy WHERE id=1
  `).first<any>();
  if (!row) return DEFAULT_ACCOUNTING_ATTACHMENT_POLICY;
  const allowedExtensions = normalizeAllowedExtensions(row.allowed_extensions);
  return {
    allowedExtensions: allowedExtensions.length ? allowedExtensions : DEFAULT_ACCOUNTING_ATTACHMENT_POLICY.allowedExtensions,
    maxFileBytes: positiveInteger(row.max_file_bytes, DEFAULT_ACCOUNTING_ATTACHMENT_POLICY.maxFileBytes, 1024, 25 * 1024 * 1024),
    maxFilesPerReference: positiveInteger(row.max_files_per_reference, DEFAULT_ACCOUNTING_ATTACHMENT_POLICY.maxFilesPerReference, 1, 50),
    maxTotalBytesPerReference: positiveInteger(row.max_total_bytes_per_reference, DEFAULT_ACCOUNTING_ATTACHMENT_POLICY.maxTotalBytesPerReference, 1024, 200 * 1024 * 1024),
    retentionDays: positiveInteger(row.retention_days, DEFAULT_ACCOUNTING_ATTACHMENT_POLICY.retentionDays, 1, 36500),
    requireDeleteReason: Number(row.require_delete_reason || 0) === 1,
  };
};

export const saveAccountingAttachmentPolicy = async (
  db: D1Database,
  raw: Record<string, unknown>,
  user: SessionUser,
) => {
  const allowedExtensions = normalizeAllowedExtensions(raw.allowedExtensions);
  if (!allowedExtensions.length) throw new Error('허용 확장자를 한 개 이상 입력해 주세요.');
  const maxFileBytes = positiveInteger(raw.maxFileBytes, 0, 1024, 25 * 1024 * 1024);
  const maxFilesPerReference = positiveInteger(raw.maxFilesPerReference, 0, 1, 50);
  const maxTotalBytesPerReference = positiveInteger(raw.maxTotalBytesPerReference, 0, 1024, 200 * 1024 * 1024);
  const retentionDays = positiveInteger(raw.retentionDays, 0, 1, 36500);
  if (!maxFileBytes || !maxFilesPerReference || !maxTotalBytesPerReference || !retentionDays) {
    throw new Error('첨부파일 운영정책 값을 확인해 주세요.');
  }
  if (maxTotalBytesPerReference < maxFileBytes) {
    throw new Error('건당 총용량은 파일당 최대용량보다 작을 수 없습니다.');
  }
  const now = new Date().toISOString();
  await db.prepare(`
    INSERT INTO accounting_attachment_policy
      (id,allowed_extensions,max_file_bytes,max_files_per_reference,max_total_bytes_per_reference,
       retention_days,require_delete_reason,updated_by,updated_at)
    VALUES (1,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      allowed_extensions=excluded.allowed_extensions,
      max_file_bytes=excluded.max_file_bytes,
      max_files_per_reference=excluded.max_files_per_reference,
      max_total_bytes_per_reference=excluded.max_total_bytes_per_reference,
      retention_days=excluded.retention_days,
      require_delete_reason=excluded.require_delete_reason,
      updated_by=excluded.updated_by,
      updated_at=excluded.updated_at
  `).bind(
    allowedExtensions.join(','), maxFileBytes, maxFilesPerReference, maxTotalBytesPerReference,
    retentionDays, raw.requireDeleteReason === false ? 0 : 1, user.name, now,
  ).run();
  return getAccountingAttachmentPolicy(db);
};

const startsWith = (bytes: Uint8Array, signature: number[]) =>
  signature.every((value, index) => bytes[index] === value);

const isProbablyText = (bytes: Uint8Array) => {
  const sample = bytes.subarray(0, Math.min(bytes.length, 2048));
  if (!sample.length) return false;
  let printable = 0;
  for (const value of sample) {
    if (value === 0) return false;
    if (value === 9 || value === 10 || value === 13 || value >= 32) printable += 1;
  }
  return printable / sample.length > 0.92;
};

export const inspectAccountingAttachment = (
  fileName: string,
  bytes: Uint8Array,
  policy: AccountingAttachmentPolicy,
) => {
  const extension = (fileName.match(/\.([^.]+)$/)?.[1] || '').toLowerCase();
  if (!extension || !policy.allowedExtensions.includes(extension)) {
    return { ok: false, extension, message: `허용되지 않은 파일 형식입니다. 허용 확장자: ${policy.allowedExtensions.join(', ')}` };
  }
  if (!bytes.byteLength) return { ok: false, extension, message: '비어 있는 파일은 등록할 수 없습니다.' };
  if (bytes.byteLength > policy.maxFileBytes) {
    return { ok: false, extension, message: `파일당 최대 ${(policy.maxFileBytes / 1024 / 1024).toFixed(0)}MB까지 등록할 수 있습니다.` };
  }

  const zip = startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWith(bytes, [0x50, 0x4b, 0x05, 0x06]) || startsWith(bytes, [0x50, 0x4b, 0x07, 0x08]);
  const ole = startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  const validByExtension: Record<string, boolean> = {
    pdf: startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]),
    jpg: startsWith(bytes, [0xff, 0xd8, 0xff]),
    jpeg: startsWith(bytes, [0xff, 0xd8, 0xff]),
    png: startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    hwp: ole,
    doc: ole,
    xls: ole,
    hwpx: zip,
    docx: zip,
    xlsx: zip,
    csv: isProbablyText(bytes),
    txt: isProbablyText(bytes),
  };
  if (!validByExtension[extension]) {
    return { ok: false, extension, message: '파일 확장자와 실제 파일 형식이 일치하지 않거나 손상된 파일입니다.' };
  }
  return {
    ok: true,
    extension,
    scanStatus: 'basic_checked',
    scanMessage: '확장자, 파일 시그니처, 크기 기본검사를 통과했습니다. 별도 백신 엔진 검사는 적용되지 않았습니다.',
  };
};

export const retentionDate = (now: string, retentionDays: number) => {
  const date = new Date(now);
  date.setUTCDate(date.getUTCDate() + retentionDays);
  return date.toISOString();
};

export const assertAccountingAttachmentRetentionElapsed = (
  retentionUntil: unknown,
  now = new Date().toISOString(),
) => {
  const retentionText = String(retentionUntil || '').trim();
  const retentionTime = Date.parse(retentionText);
  const nowTime = Date.parse(now);
  if (!retentionText || !Number.isFinite(retentionTime) || !Number.isFinite(nowTime)) {
    throw new Error('첨부파일 보존기한을 확인할 수 없어 삭제를 차단했습니다. 운영관리자에게 무결성 점검을 요청해 주세요.');
  }
  if (nowTime < retentionTime) {
    throw new Error(`첨부파일 보존기한(${retentionText}) 전에는 원본을 삭제할 수 없습니다.`);
  }
  return retentionText;
};

export const recordAccountingAttachmentOperation = async (
  db: D1Database,
  input: {
    operationType: 'attachment_delete' | 'compensation_delete';
    attachmentId?: number | null;
    objectKey: string;
    referenceType?: string | null;
    referenceId?: string | null;
    error: unknown;
  },
) => {
  const now = new Date().toISOString();
  const id = `AOP-${randomHex(22)}`;
  await db.prepare(`
    INSERT INTO accounting_attachment_operations
      (id,operation_type,attachment_id,object_key,reference_type,reference_id,status,attempts,last_error,created_at,updated_at,last_attempt_at)
    VALUES (?,?,?,?,?,?,'failed',1,?,?,?,?)
  `).bind(
    id, input.operationType, input.attachmentId || null, input.objectKey,
    input.referenceType || null, input.referenceId || null,
    clean(input.error instanceof Error ? input.error.message : String(input.error || '알 수 없는 오류'), 1000),
    now, now, now,
  ).run();
  return id;
};

type IntegrityScanMode = 'd1' | 'full';
type R2ListedObject = { key: string; size?: number };
type R2ListResult = { objects?: R2ListedObject[]; truncated?: boolean; cursor?: string };

const upsertIssue = async (
  db: D1Database,
  issue: {
    issueType: 'D1_ONLY' | 'R2_ONLY' | 'SIZE_MISMATCH' | 'CHECKSUM_MISMATCH';
    attachmentId?: number | null;
    objectKey: string;
    referenceType?: string | null;
    referenceId?: string | null;
    details?: Record<string, unknown>;
  },
  now: string,
) => {
  const issueKey = `${issue.issueType}:${issue.objectKey}`;
  await db.prepare(`
    INSERT INTO accounting_attachment_integrity_issues
      (id,issue_key,issue_type,attachment_id,object_key,reference_type,reference_id,status,details_json,detected_at,last_seen_at)
    VALUES (?,?,?,?,?,?,?,'open',?,?,?)
    ON CONFLICT(issue_key) DO UPDATE SET
      attachment_id=excluded.attachment_id,
      reference_type=excluded.reference_type,
      reference_id=excluded.reference_id,
      status=CASE WHEN accounting_attachment_integrity_issues.status='ignored' THEN 'ignored' ELSE 'open' END,
      details_json=excluded.details_json,
      last_seen_at=excluded.last_seen_at,
      resolved_at=NULL,
      resolved_by=NULL,
      resolution_action=NULL
  `).bind(
    `AII-${randomHex(22)}`, issueKey, issue.issueType, issue.attachmentId || null,
    issue.objectKey, issue.referenceType || null, issue.referenceId || null,
    JSON.stringify(issue.details || {}), now, now,
  ).run();
  return issueKey;
};

export const runAccountingAttachmentIntegrityScan = async (
  db: D1Database,
  bucket: R2Bucket,
  mode: IntegrityScanMode = 'full',
) => {
  const now = new Date().toISOString();
  const attachments = await db.prepare(`
    SELECT id,reference_type,reference_id,object_key,original_filename,size_bytes,checksum_sha256,deleted_at
    FROM accounting_attachments
    ORDER BY id
  `).all<any>();
  const rows = attachments.results || [];
  const seen = new Set<string>();
  let d1Only = 0;
  let r2Only = 0;
  let sizeMismatch = 0;
  let checksumMismatch = 0;

  for (const row of rows) {
    if (row.deleted_at) continue;
    // 'full' mode downloads the object body so the checksum check below can re-hash the actual
    // bytes; 'd1' (quick) mode only HEADs the object to stay cheap for a routine scan.
    const object: any = mode === 'full'
      ? await bucket.get(String(row.object_key || ''))
      : await bucket.head(String(row.object_key || ''));
    await db.prepare(`UPDATE accounting_attachments SET last_checked_at=? WHERE id=?`).bind(now, row.id).run();
    if (!object) {
      d1Only += 1;
      seen.add(await upsertIssue(db, {
        issueType: 'D1_ONLY', attachmentId: Number(row.id), objectKey: String(row.object_key || ''),
        referenceType: row.reference_type, referenceId: row.reference_id,
        details: { originalFilename: row.original_filename, sizeBytes: row.size_bytes },
      }, now));
      continue;
    }
    if (Number(object.size || 0) !== Number(row.size_bytes || 0)) {
      sizeMismatch += 1;
      seen.add(await upsertIssue(db, {
        issueType: 'SIZE_MISMATCH', attachmentId: Number(row.id), objectKey: String(row.object_key || ''),
        referenceType: row.reference_type, referenceId: row.reference_id,
        details: { originalFilename: row.original_filename, expectedSize: Number(row.size_bytes || 0), actualSize: Number(object.size || 0) },
      }, now));
    }
    const storedChecksum = String(row.checksum_sha256 || '').toLowerCase();
    // In 'full' mode, re-hash the actual downloaded object bytes rather than trusting the
    // customMetadata checksum captured at upload time: that metadata travels alongside the
    // object and would not change if the underlying bytes were tampered with or replaced
    // out-of-band, so comparing D1's stored checksum against R2 metadata only ever proved
    // metadata-vs-metadata consistency — never that the bytes actually on disk still match
    // what was originally uploaded. 'd1' (quick) mode keeps the cheap metadata-only comparison
    // so a routine scan doesn't have to download every attachment's full body.
    const actualChecksum = mode === 'full'
      ? toHex(await crypto.subtle.digest('SHA-256', await object.arrayBuffer()))
      : String(object.customMetadata?.checksumSha256 || '').toLowerCase();
    if (storedChecksum && actualChecksum && actualChecksum !== storedChecksum) {
      checksumMismatch += 1;
      seen.add(await upsertIssue(db, {
        issueType: 'CHECKSUM_MISMATCH', attachmentId: Number(row.id), objectKey: String(row.object_key || ''),
        referenceType: row.reference_type, referenceId: row.reference_id,
        details: { originalFilename: row.original_filename, expectedChecksum: storedChecksum, actualChecksum, verifiedBytes: mode === 'full' },
      }, now));
    }
  }

  let truncated = false;
  if (mode === 'full') {
    const byObjectKey = new Map(rows.map((row) => [String(row.object_key || ''), row]));
    let cursor: string | undefined;
    let listed = 0;
    do {
      const result = await bucket.list({ prefix: ACCOUNTING_R2_PREFIX, cursor, limit: 1000 }) as R2ListResult;
      const objects = result.objects || [];
      for (const object of objects) {
        listed += 1;
        if (listed > 10000) { truncated = true; break; }
        const row = byObjectKey.get(object.key);
        if (!row || row.deleted_at) {
          r2Only += 1;
          seen.add(await upsertIssue(db, {
            issueType: 'R2_ONLY', attachmentId: row?.id ? Number(row.id) : null,
            objectKey: object.key, referenceType: row?.reference_type || null, referenceId: row?.reference_id || null,
            details: { sizeBytes: object.size || 0, metadataDeleted: !!row?.deleted_at },
          }, now));
        }
      }
      if (truncated) break;
      cursor = result.truncated ? result.cursor : undefined;
    } while (cursor);
  }

  const types = mode === 'full' ? ['D1_ONLY', 'R2_ONLY', 'SIZE_MISMATCH', 'CHECKSUM_MISMATCH'] : ['D1_ONLY', 'SIZE_MISMATCH', 'CHECKSUM_MISMATCH'];
  const openIssues = await db.prepare(`
    SELECT id,issue_key FROM accounting_attachment_integrity_issues
    WHERE status='open' AND issue_type IN (${types.map(() => '?').join(',')})
  `).bind(...types).all<any>();
  for (const issue of openIssues.results || []) {
    if (!seen.has(String(issue.issue_key || ''))) {
      await db.prepare(`
        UPDATE accounting_attachment_integrity_issues
        SET status='resolved',resolved_at=?,resolved_by='system',resolution_action='auto-cleared'
        WHERE id=? AND status='open'
      `).bind(now, issue.id).run();
    }
  }

  return { mode, scannedAttachments: rows.filter((row) => !row.deleted_at).length, d1Only, r2Only, sizeMismatch, checksumMismatch, truncated, checkedAt: now };
};

export const retryAccountingAttachmentOperation = async (
  db: D1Database,
  bucket: R2Bucket,
  operationId: string,
) => {
  const operation = await db.prepare(`SELECT * FROM accounting_attachment_operations WHERE id=?`).bind(operationId).first<any>();
  if (!operation) throw new Error('재처리할 첨부파일 작업을 찾을 수 없습니다.');
  if (operation.status === 'succeeded') return { ok: true, duplicate: true };
  const now = new Date().toISOString();
  if (operation.operation_type === 'attachment_delete' && operation.attachment_id) {
    const attachment = await db.prepare(`SELECT retention_until FROM accounting_attachments WHERE id=?`)
      .bind(operation.attachment_id).first<{ retention_until: string | null }>();
    assertAccountingAttachmentRetentionElapsed(attachment?.retention_until,now);
  }
  try {
    await bucket.delete(assertAccountingR2Key(operation.object_key, '회계 첨부 오류 재처리'));
    if (operation.operation_type === 'attachment_delete' && operation.attachment_id) {
      await db.prepare(`
        UPDATE accounting_attachments
        SET deleted_at=COALESCE(deleted_at,?),delete_status='deleted',delete_error=NULL,last_checked_at=?
        WHERE id=?
      `).bind(now, now, operation.attachment_id).run();
    }
    await db.prepare(`
      UPDATE accounting_attachment_operations
      SET status='succeeded',attempts=attempts+1,last_error=NULL,updated_at=?,last_attempt_at=?,completed_at=?
      WHERE id=?
    `).bind(now, now, now, operationId).run();
    return { ok: true, duplicate: false };
  } catch (error) {
    await db.prepare(`
      UPDATE accounting_attachment_operations
      SET status='failed',attempts=attempts+1,last_error=?,updated_at=?,last_attempt_at=?
      WHERE id=?
    `).bind(clean(error instanceof Error ? error.message : String(error), 1000), now, now, operationId).run();
    throw error;
  }
};

export const retryPendingAccountingAttachmentOperations = async (
  db: D1Database,
  bucket: R2Bucket,
  limit = 30,
) => {
  const rows = await db.prepare(`
    SELECT id FROM accounting_attachment_operations
    WHERE status='failed' AND attempts < 10
    ORDER BY updated_at ASC LIMIT ${Math.max(1, Math.min(100, Math.round(limit)))}
  `).all<{ id: string }>();
  let succeeded = 0;
  let failed = 0;
  for (const row of rows.results || []) {
    try { await retryAccountingAttachmentOperation(db, bucket, row.id); succeeded += 1; }
    catch { failed += 1; }
  }
  return { processed: (rows.results || []).length, succeeded, failed };
};
