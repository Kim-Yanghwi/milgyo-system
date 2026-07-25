import {
  authenticateSession,
  clean,
  ensureTables,
  json,
  randomHex,
} from '../../_shared/helpers';

interface Env {
  DB: D1Database;
}

type UploadPayload = {
  token?: string;
  documentId?: string;
  fileName?: string;
  mimeType?: string;
  dataBase64?: string;
};

// D1 한 행에 무리 없이 들어가도록 첨부파일은 4MB(base64 인코딩 전 기준)로 제한합니다.
const MAX_FILE_BYTES = 4 * 1024 * 1024;

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB) return json({ ok: false, message: 'DB가 연결되지 않았습니다.' }, 500);

  let payload: UploadPayload;
  try {
    payload = await request.json();
  } catch (error) {
    return json({ ok: false, message: '요청 형식이 올바르지 않습니다.' }, 400);
  }

  await ensureTables(env.DB);
  const auth = await authenticateSession(env.DB, clean(payload.token, 200));
  if (!auth.ok) return json({ ok: false, message: auth.message }, auth.status);

  const documentId = clean(payload.documentId, 60);
  const fileName = clean(payload.fileName, 200);
  const mimeType = clean(payload.mimeType, 120) || 'application/octet-stream';
  const dataBase64 = typeof payload.dataBase64 === 'string' ? payload.dataBase64 : '';

  if (!documentId) return json({ ok: false, message: '문서번호가 필요합니다.' }, 400);
  if (!fileName) return json({ ok: false, message: '파일명이 필요합니다.' }, 400);
  if (!dataBase64) return json({ ok: false, message: '파일 내용이 비어 있습니다.' }, 400);

  // base64 문자열 길이로 원본 바이트 크기를 대략 추정해 상한을 넘는 파일을 미리 걸러냅니다.
  const approxBytes = Math.floor((dataBase64.length * 3) / 4);
  if (approxBytes > MAX_FILE_BYTES) {
    return json({ ok: false, message: '첨부파일은 4MB 이하만 등록할 수 있습니다.' }, 400);
  }

  try {
    await ensureTables(env.DB);
    const document = await env.DB.prepare(`SELECT id FROM documents WHERE id = ?`)
      .bind(documentId)
      .first<{ id: string }>();
    if (!document) return json({ ok: false, message: '해당 문서를 찾을 수 없습니다.' }, 404);

    const id = `ATT-${randomHex(20)}`;
    const now = new Date().toISOString();
    await env.DB.prepare(`
      INSERT INTO document_attachments (id, document_id, file_name, mime_type, size_bytes, data_base64, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
      .bind(id, documentId, fileName, mimeType, approxBytes, dataBase64, now)
      .run();

    return json({ ok: true, id, fileName, sizeBytes: approxBytes, message: '첨부파일이 등록되었습니다.' });
  } catch (error) {
    return json({ ok: false, message: '첨부파일 등록 중 오류가 발생했습니다.' }, 500);
  }
};

export const onRequestGet: PagesFunction = async () =>
  json({ ok: false, message: 'POST 방식으로 요청해 주세요.' }, 405);
