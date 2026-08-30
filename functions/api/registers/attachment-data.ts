import { authenticateSession, clean, ensureTables, json } from '../../_shared/helpers';
interface Env { DB: D1Database; FILES?: R2Bucket; }
type Payload = { token?: string; attachmentId?: string; binary?: boolean };

const arrayBufferToBase64 = (buffer: ArrayBuffer) => {
  const bytes = new Uint8Array(buffer); let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};
const base64ToBytes = (value: string) => {
  try { const binary = atob(value || ''); return Uint8Array.from(binary, (char) => char.charCodeAt(0)); }
  catch { return null; }
};
const downloadHeaders = (fileName: string, mimeType: string, sizeBytes: number) => {
  const encoded = encodeURIComponent(fileName || 'attachment');
  return {
    'Content-Type': mimeType || 'application/octet-stream',
    'Content-Length': String(Math.max(0, Number(sizeBytes || 0))),
    'Content-Disposition': `attachment; filename*=UTF-8''${encoded}`,
    'X-File-Name': encoded,
    'Cache-Control': 'private, no-store',
  };
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB) return json({ ok: false, message: 'DB가 연결되지 않았습니다.' }, 500);
  let payload: Payload; try { payload = await request.json(); } catch { return json({ ok: false, message: '요청 형식이 올바르지 않습니다.' }, 400); }
  await ensureTables(env.DB);
  const auth = await authenticateSession(env.DB, clean(payload.token, 200));
  if (!auth.ok) return json({ ok: false, message: auth.message }, auth.status);
  const attachment = await env.DB.prepare(`SELECT a.*,r.applicant_user_id
    FROM management_register_attachments a JOIN management_registers r ON r.id=a.register_id WHERE a.id=?`)
    .bind(clean(payload.attachmentId, 80)).first<any>();
  if (!attachment) return json({ ok: false, message: '첨부파일을 찾을 수 없습니다.' }, 404);

  const binary = payload.binary === true;
  if (attachment.storage_type === 'r2') {
    if (!env.FILES || !attachment.r2_key) return json({ ok: false, message: 'R2 저장소가 연결되지 않았습니다.' }, 500);
    const object = await env.FILES.get(attachment.r2_key);
    if (!object) return json({ ok: false, message: 'R2에서 첨부파일을 찾을 수 없습니다.' }, 404);
    if (binary) {
      return new Response(object.body, {
        status: 200,
        headers: downloadHeaders(attachment.file_name, attachment.mime_type || object.httpMetadata?.contentType, Number(object.size || attachment.size_bytes || 0)),
      });
    }
    const buffer = await object.arrayBuffer();
    return json({ ok: true, fileName: attachment.file_name, mimeType: attachment.mime_type, sizeBytes: attachment.size_bytes, dataBase64: arrayBufferToBase64(buffer) });
  }

  const dataBase64 = attachment.data_base64 || '';
  if (binary) {
    const bytes = base64ToBytes(dataBase64);
    if (!bytes) return json({ ok: false, message: '첨부파일 인코딩을 읽을 수 없습니다.' }, 500);
    return new Response(bytes, { status: 200, headers: downloadHeaders(attachment.file_name, attachment.mime_type, bytes.byteLength) });
  }
  return json({ ok: true, fileName: attachment.file_name, mimeType: attachment.mime_type, sizeBytes: attachment.size_bytes, dataBase64 });
};
export const onRequestGet: PagesFunction = async () => json({ ok: false, message: 'POST 방식으로 요청해 주세요.' }, 405);
