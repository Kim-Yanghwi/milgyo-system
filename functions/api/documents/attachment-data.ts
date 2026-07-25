import { authenticateSession, canReadDocument, clean, ensureTables, json } from '../../_shared/helpers';
interface Env { DB: D1Database; FILES?: R2Bucket; }
type Payload = { token?: string; attachmentId?: string };
const arrayBufferToBase64 = (buffer: ArrayBuffer) => {
  const bytes = new Uint8Array(buffer); let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
};
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB) return json({ ok: false, message: 'DB가 연결되지 않았습니다.' }, 500);
  let payload: Payload; try { payload = await request.json(); } catch { return json({ ok: false, message: '요청 형식이 올바르지 않습니다.' }, 400); }
  await ensureTables(env.DB);
  const auth = await authenticateSession(env.DB, clean(payload.token, 200));
  if (!auth.ok) return json({ ok: false, message: auth.message }, auth.status);
  const attachment = await env.DB.prepare(`
    SELECT id,document_id,file_name,mime_type,size_bytes,data_base64,storage_type,r2_key
    FROM document_attachments WHERE id=?
  `).bind(clean(payload.attachmentId, 60)).first<any>();
  if (!attachment) return json({ ok: false, message: '첨부파일을 찾을 수 없습니다.' }, 404);
  const doc = await env.DB.prepare('SELECT * FROM documents WHERE id=?').bind(attachment.document_id).first<Record<string, unknown>>();
  if (!doc) return json({ ok: false, message: '첨부파일 열람 권한이 없습니다.' }, 403);
  let readable = canReadDocument(auth.user, doc);
  if (!readable && doc.access_scope === '관련자') {
    const related = await env.DB.prepare('SELECT 1 AS allowed FROM document_approval_lines WHERE document_id=? AND user_id=? LIMIT 1')
      .bind(attachment.document_id, auth.user.id).first<{ allowed: number }>();
    readable = !!related;
  }
  if (!readable) return json({ ok: false, message: '첨부파일 열람 권한이 없습니다.' }, 403);
  let dataBase64 = attachment.data_base64 || '';
  if (attachment.storage_type === 'r2') {
    if (!env.FILES || !attachment.r2_key) return json({ ok: false, message: 'R2 첨부파일 저장소가 연결되지 않았습니다.' }, 500);
    const object = await env.FILES.get(attachment.r2_key);
    if (!object) return json({ ok: false, message: 'R2에서 첨부파일을 찾을 수 없습니다.' }, 404);
    dataBase64 = arrayBufferToBase64(await object.arrayBuffer());
  }
  return json({ ok: true, fileName: attachment.file_name, mimeType: attachment.mime_type, sizeBytes: attachment.size_bytes, dataBase64 });
};
export const onRequestGet: PagesFunction = async () => json({ ok: false, message: 'POST 방식으로 요청해 주세요.' }, 405);
