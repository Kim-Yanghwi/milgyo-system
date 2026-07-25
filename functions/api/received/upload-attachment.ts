import { authenticateSession, clean, ensureTables, json, randomHex } from '../../_shared/helpers';

interface Env { DB: D1Database; FILES?: R2Bucket; }
type Payload = { token?: string; receivedDocumentId?: string; fileName?: string; mimeType?: string; dataBase64?: string };

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_D1_FALLBACK_BYTES = 1250 * 1024;
const BLOCKED_EXTENSIONS = /\.(html?|js|mjs|svg|exe|dll|bat|cmd|com|ps1|sh|php|jsp|asp|aspx)$/i;
const decodeBase64 = (value: string) => {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) return null;
  try { const binary = atob(value); return Uint8Array.from(binary, (char) => char.charCodeAt(0)); } catch { return null; }
};
const safeKeyName = (name: string) => name.replace(/[^0-9A-Za-z._-]+/g, '_').slice(-120) || 'attachment.bin';

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB) return json({ ok: false, message: 'DB가 연결되지 않았습니다.' }, 500);
  let payload: Payload;
  try { payload = await request.json(); } catch { return json({ ok: false, message: '요청 형식이 올바르지 않습니다.' }, 400); }
  await ensureTables(env.DB);
  const auth = await authenticateSession(env.DB, clean(payload.token, 200));
  if (!auth.ok) return json({ ok: false, message: auth.message }, auth.status);

  const receivedDocumentId = clean(payload.receivedDocumentId, 60);
  const fileName = clean(payload.fileName, 200);
  const mimeType = clean(payload.mimeType, 120) || 'application/octet-stream';
  const dataBase64 = typeof payload.dataBase64 === 'string' ? payload.dataBase64 : '';
  const bytes = decodeBase64(dataBase64);
  if (!receivedDocumentId || !fileName || !bytes) return json({ ok: false, message: '첨부파일 정보가 부족하거나 인코딩이 올바르지 않습니다.' }, 400);
  if (BLOCKED_EXTENSIONS.test(fileName)) return json({ ok: false, message: '보안상 등록할 수 없는 파일 형식입니다.' }, 400);
  if (bytes.byteLength > MAX_FILE_BYTES) return json({ ok: false, message: '첨부파일은 4MB 이하만 등록할 수 있습니다.' }, 400);

  const record = await env.DB.prepare('SELECT id,handled_by_user_id FROM received_documents WHERE id=?').bind(receivedDocumentId)
    .first<{ id: string; handled_by_user_id: string | null }>();
  if (!record) return json({ ok: false, message: '대장 문서를 찾을 수 없습니다.' }, 404);
  if (auth.user.role !== 'admin' && String(record.handled_by_user_id || '') !== auth.user.id) return json({ ok: false, message: '등록자 또는 관리자만 첨부파일을 추가할 수 있습니다.' }, 403);

  const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM received_attachments WHERE received_document_id=?').bind(receivedDocumentId).first<{ count: number }>();
  if (Number(count?.count || 0) >= 10) return json({ ok: false, message: '문서당 첨부파일은 최대 10개까지 등록할 수 있습니다.' }, 400);

  const id = `RATT-${randomHex(20)}`;
  let storageType = 'd1';
  let r2Key: string | null = null;
  let storedBase64 = dataBase64;
  if (env.FILES) {
    storageType = 'r2'; storedBase64 = '';
    r2Key = `registry/${receivedDocumentId}/${id}-${safeKeyName(fileName)}`;
    await env.FILES.put(r2Key, bytes, { httpMetadata: { contentType: mimeType }, customMetadata: { originalName: fileName, receivedDocumentId } });
  } else if (bytes.byteLength > MAX_D1_FALLBACK_BYTES) {
    return json({ ok: false, message: '1.2MB를 넘는 첨부파일은 R2 바인딩(FILES)이 필요합니다.' }, 400);
  }

  try {
    await env.DB.prepare(`
      INSERT INTO received_attachments
        (id,received_document_id,file_name,mime_type,size_bytes,data_base64,storage_type,r2_key,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)
    `).bind(id, receivedDocumentId, fileName, mimeType, bytes.byteLength, storedBase64, storageType, r2Key, new Date().toISOString()).run();
    return json({ ok: true, id, storageType, message: '첨부파일이 등록되었습니다.' });
  } catch {
    if (r2Key && env.FILES) await env.FILES.delete(r2Key).catch(() => undefined);
    return json({ ok: false, message: '첨부파일 저장 중 오류가 발생했습니다.' }, 500);
  }
};

export const onRequestGet: PagesFunction = async () => json({ ok: false, message: 'POST 방식으로 요청해 주세요.' }, 405);
