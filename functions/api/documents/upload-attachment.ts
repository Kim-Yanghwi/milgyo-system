import { decodeUploadBase64, inspectMainAttachment } from '../../_shared/security/attachments';
import { authenticateSession, getSessionToken, canReadDocument, clean, ensureTables, json, randomHex } from '../../_shared/helpers';

interface Env { DB: D1Database; FILES?: R2Bucket; }
type Payload = { token?: string; documentId?: string; fileName?: string; mimeType?: string; dataBase64?: string };

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_D1_FALLBACK_BYTES = 1250 * 1024;
const BLOCKED_EXTENSIONS = /\.(html?|js|mjs|svg|exe|dll|bat|cmd|com|ps1|sh|php|jsp|asp|aspx)$/i;

const safeKeyName = (name: string) => name.replace(/[^0-9A-Za-z._-]+/g, '_').slice(-120) || 'attachment.bin';

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB) return json({ ok: false, message: 'DB가 연결되지 않았습니다.' }, 500);
  let payload: Payload;
  try { payload = await request.json(); } catch { return json({ ok: false, message: '요청 형식이 올바르지 않습니다.' }, 400); }

  await ensureTables(env.DB);
  const auth = await authenticateSession(env.DB, getSessionToken(request));
  if (!auth.ok) return json({ ok: false, code: auth.code, message: auth.message }, auth.status);

  const documentId = clean(payload.documentId, 60);
  const fileName = clean(payload.fileName, 200);
  let mimeType = clean(payload.mimeType, 120) || 'application/octet-stream';
  const dataBase64 = typeof payload.dataBase64 === 'string' ? payload.dataBase64 : '';
  if (!documentId || !fileName || !dataBase64) return json({ ok: false, message: '첨부파일 정보가 부족합니다.' }, 400);
  if (BLOCKED_EXTENSIONS.test(fileName)) return json({ ok: false, message: '보안상 등록할 수 없는 파일 형식입니다.' }, 400);

  const bytes = decodeUploadBase64(dataBase64);
  if (!bytes) return json({ ok: false, message: '첨부파일 인코딩이 올바르지 않습니다.' }, 400);
  if (bytes.byteLength > MAX_FILE_BYTES) return json({ ok: false, message: '첨부파일은 4MB 이하만 등록할 수 있습니다.' }, 400);

  const inspection = inspectMainAttachment(fileName, bytes);
  if (!inspection.ok) return json({ ok: false, message: inspection.message }, 400);
  mimeType = inspection.mimeType;

  const doc = await env.DB.prepare('SELECT * FROM documents WHERE id=?').bind(documentId).first<Record<string, unknown>>();
  if (!doc) return json({ ok: false, message: '해당 문서를 찾을 수 없습니다.' }, 404);
  if (!canReadDocument(auth.user, doc)) return json({ ok: false, message: '첨부 권한이 없습니다.' }, 403);
  if (auth.user.role !== 'admin' && String(doc.drafter_user_id || '') !== auth.user.id) return json({ ok: false, message: '기안자 또는 관리자만 첨부파일을 추가할 수 있습니다.' }, 403);

  const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM document_attachments WHERE document_id=?').bind(documentId).first<{ count: number }>();
  if (Number(count?.count || 0) >= 10) return json({ ok: false, message: '문서당 첨부파일은 최대 10개까지 등록할 수 있습니다.' }, 400);

  const id = `ATT-${randomHex(20)}`;
  let storageType = 'd1';
  let r2Key: string | null = null;
  let storedBase64 = dataBase64;

  if (env.FILES) {
    storageType = 'r2';
    storedBase64 = '';
    r2Key = `documents/${documentId}/${id}-${safeKeyName(fileName)}`;
    await env.FILES.put(r2Key, bytes, { httpMetadata: { contentType: mimeType }, customMetadata: { originalName: fileName, documentId } });
  } else if (bytes.byteLength > MAX_D1_FALLBACK_BYTES) {
    return json({ ok: false, message: '1.2MB를 넘는 첨부파일은 R2 바인딩(FILES)이 필요합니다. Cloudflare Pages에 R2 버킷을 연결해 주세요.' }, 400);
  }

  try {
    const inserted = await env.DB.prepare(`
      INSERT INTO document_attachments
        (id,document_id,file_name,mime_type,size_bytes,data_base64,storage_type,r2_key,created_at)
      SELECT ?,?,?,?,?,?,?,?,?
      WHERE EXISTS(SELECT 1 FROM documents d WHERE d.id=?
        AND (?='admin' OR CAST(d.drafter_user_id AS TEXT)=?)
        AND (d.status='임시저장' OR (d.status IN ('검토대기','협조대기','결재대기','전결대기')
          AND NOT EXISTS(SELECT 1 FROM document_approval_lines l WHERE l.document_id=d.id AND (l.acted_at IS NOT NULL OR l.status='완료')))))
      AND NOT EXISTS(SELECT 1 FROM document_transition_locks WHERE document_id=? AND locked_at>?)
      AND (SELECT COUNT(*) FROM document_attachments WHERE document_id=?)<10
    `).bind(id, documentId, fileName, mimeType, bytes.byteLength, storedBase64, storageType, r2Key, new Date().toISOString(), documentId, auth.user.role, auth.user.id, documentId, new Date(Date.now()-300000).toISOString(), documentId).run();
    if (Number(inserted.meta?.changes) !== 1) {
      if (r2Key && env.FILES) await env.FILES.delete(r2Key).catch(() => undefined);
      return json({ ok: false, code: 'ATTACHMENT_STATE_CONFLICT', message: '\uacb0\uc7ac\uac00 \uc9c4\ud589\ub418\uc5c8\uac70\ub098 \ucca8\ubd80 \ud55c\ub3c4\uc5d0 \ub3c4\ub2ec\ud558\uc5ec \ud30c\uc77c\uc744 \ucd94\uac00\ud558\uc9c0 \uc54a\uc558\uc2b5\ub2c8\ub2e4.' }, 409);
    }
    return json({ ok: true, id, fileName, sizeBytes: bytes.byteLength, storageType, message: '첨부파일이 등록되었습니다.' });
  } catch {
    if (r2Key && env.FILES) await env.FILES.delete(r2Key).catch(() => undefined);
    return json({ ok: false, message: '첨부파일 저장 중 오류가 발생했습니다.' }, 500);
  }
};

export const onRequestGet: PagesFunction = async () => json({ ok: false, message: 'POST 방식으로 요청해 주세요.' }, 405);
