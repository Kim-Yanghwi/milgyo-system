import { authenticateSession, clean, ensureTables, json } from '../../_shared/helpers';
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
  const row = await env.DB.prepare(`
    SELECT file_name,mime_type,size_bytes,data_base64,storage_type,r2_key
    FROM received_attachments WHERE id=?
  `).bind(clean(payload.attachmentId, 60)).first<any>();
  if (!row) return json({ ok: false, message: '첨부파일을 찾을 수 없습니다.' }, 404);
  let dataBase64 = row.data_base64 || '';
  if (row.storage_type === 'r2') {
    if (!env.FILES || !row.r2_key) return json({ ok: false, message: 'R2 첨부파일 저장소가 연결되지 않았습니다.' }, 500);
    const object = await env.FILES.get(row.r2_key);
    if (!object) return json({ ok: false, message: 'R2에서 첨부파일을 찾을 수 없습니다.' }, 404);
    dataBase64 = arrayBufferToBase64(await object.arrayBuffer());
  }
  return json({ ok: true, fileName: row.file_name, mimeType: row.mime_type, sizeBytes: row.size_bytes, dataBase64 });
};
export const onRequestGet: PagesFunction = async () => json({ ok: false, message: 'POST 방식으로 요청해 주세요.' }, 405);
