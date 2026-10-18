import { authenticateSession, getSessionToken, clean, ensureTables, json } from '../../_shared/helpers';
interface Env { DB: D1Database; FILES?: R2Bucket }
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB) return json({ ok: false, message: 'D1 연결이 필요합니다.' }, 503);
  let p: { attachmentId?: string }; try { p = await request.json(); } catch { return json({ ok: false, message: '요청이 잘못됐습니다.' }, 400); }
  await ensureTables(env.DB);
  const auth = await authenticateSession(env.DB, getSessionToken(request));
  if (!auth.ok) return json({ ok: false, code: auth.code, message: auth.message }, auth.status);
  if (auth.user.role !== 'admin') return json({ ok: false, message: '승적원부 첨부파일 열람 권한이 없습니다.' }, 403);
  const attachment = await env.DB.prepare('SELECT * FROM monastic_registry_attachments WHERE id=?')
    .bind(clean(p.attachmentId, 80)).first<any>();
  if (!attachment) return json({ ok: false, message: '증빙자료를 찾을 수 없습니다.' }, 404);
  let bytes: Uint8Array;
  if (attachment.storage_type === 'r2') {
    if (!env.FILES || !attachment.r2_key) return json({ ok: false, message: 'R2 바인딩을 확인해 주세요.' }, 503);
    const object = await env.FILES.get(attachment.r2_key);
    if (!object) return json({ ok: false, message: 'R2에 파일이 없습니다.' }, 404);
    bytes = new Uint8Array(await object.arrayBuffer());
  } else {
    try { bytes = Uint8Array.from(atob(attachment.data_base64 || ''), (ch) => ch.charCodeAt(0)); }
    catch { return json({ ok: false, message: '저장된 파일을 읽을 수 없습니다.' }, 500); }
  }
  return new Response(bytes.buffer as ArrayBuffer, {
    headers: {
      'Content-Type': attachment.mime_type || 'application/octet-stream',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(attachment.file_name || 'evidence')}`,
      'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
    },
  });
};
export const onRequestGet: PagesFunction = async () => json({ ok: false, message: 'POST 요청만 지원합니다.' }, 405);
