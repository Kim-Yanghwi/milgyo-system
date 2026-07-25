import {
  authenticateSession,
  clean,
  ensureTables,
  json,
} from '../../_shared/helpers';

interface Env {
  DB: D1Database;
}

type AttachmentDataPayload = {
  token?: string;
  attachmentId?: string;
};

// 다운로드는 GET 링크 대신 POST + Blob(URL.createObjectURL) 방식으로 처리합니다.
// (세션 토큰이 URL 쿼리스트링에 노출되는 것을 피하기 위함입니다.)
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB) return json({ ok: false, message: 'DB가 연결되지 않았습니다.' }, 500);

  let payload: AttachmentDataPayload;
  try {
    payload = await request.json();
  } catch (error) {
    return json({ ok: false, message: '요청 형식이 올바르지 않습니다.' }, 400);
  }

  await ensureTables(env.DB);
  const auth = await authenticateSession(env.DB, clean(payload.token, 200));
  if (!auth.ok) return json({ ok: false, message: auth.message }, auth.status);

  const attachmentId = clean(payload.attachmentId, 60);
  if (!attachmentId) return json({ ok: false, message: '첨부파일 정보가 필요합니다.' }, 400);

  try {
    await ensureTables(env.DB);
    const attachment = await env.DB.prepare(
      `SELECT id, document_id, file_name, mime_type, size_bytes, data_base64 FROM document_attachments WHERE id = ?`,
    ).bind(attachmentId).first<{
      id: string; document_id: string; file_name: string; mime_type: string; size_bytes: number; data_base64: string;
    }>();

    if (!attachment) return json({ ok: false, message: '첨부파일을 찾을 수 없습니다.' }, 404);

    return json({
      ok: true,
      fileName: attachment.file_name,
      mimeType: attachment.mime_type,
      sizeBytes: attachment.size_bytes,
      dataBase64: attachment.data_base64,
    });
  } catch (error) {
    return json({ ok: false, message: '첨부파일을 불러오는 중 오류가 발생했습니다.' }, 500);
  }
};

export const onRequestGet: PagesFunction = async () =>
  json({ ok: false, message: 'POST 방식으로 요청해 주세요.' }, 405);
