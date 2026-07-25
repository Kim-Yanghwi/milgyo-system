import {
  authenticateSession,
  clean,
  ensureTables,
  json,
} from '../../_shared/helpers';

interface Env {
  DB: D1Database;
}

type DetailPayload = { token?: string; id?: string };

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB) return json({ ok: false, message: 'DB가 연결되지 않았습니다.' }, 500);

  let payload: DetailPayload;
  try {
    payload = await request.json();
  } catch (error) {
    return json({ ok: false, message: '요청 형식이 올바르지 않습니다.' }, 400);
  }

  await ensureTables(env.DB);
  const auth = await authenticateSession(env.DB, clean(payload.token, 200));
  if (!auth.ok) return json({ ok: false, message: auth.message }, auth.status);

  const id = clean(payload.id, 60);
  if (!id) return json({ ok: false, message: '문서번호가 필요합니다.' }, 400);

  try {
    const document = await env.DB.prepare(`SELECT * FROM documents WHERE id = ?`).bind(id).first();
    if (!document) return json({ ok: false, message: '해당 문서를 찾을 수 없습니다.' }, 404);

    const approvals = await env.DB.prepare(
      `SELECT * FROM document_approvals WHERE document_id = ? ORDER BY created_at ASC`,
    ).bind(id).all();

    const attachments = await env.DB.prepare(
      `SELECT id, file_name, mime_type, size_bytes, created_at FROM document_attachments WHERE document_id = ? ORDER BY created_at ASC`,
    ).bind(id).all();

    return json({
      ok: true,
      document,
      approvals: approvals.results ?? [],
      attachments: attachments.results ?? [],
      me: auth.user,
    });
  } catch (error) {
    return json({ ok: false, message: '문서 조회 중 오류가 발생했습니다.' }, 500);
  }
};

export const onRequestGet: PagesFunction = async () =>
  json({ ok: false, message: 'POST 방식으로 요청해 주세요.' }, 405);
