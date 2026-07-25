import { authenticateSession, canReadDocument, clean, ensureTables, json } from '../../_shared/helpers';
interface Env { DB: D1Database; }
type DetailPayload = { token?: string; id?: string };
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB) return json({ ok: false, message: 'DB가 연결되지 않았습니다.' }, 500);
  let payload: DetailPayload;
  try { payload = await request.json(); } catch { return json({ ok: false, message: '요청 형식이 올바르지 않습니다.' }, 400); }
  await ensureTables(env.DB);
  const auth = await authenticateSession(env.DB, clean(payload.token, 200));
  if (!auth.ok) return json({ ok: false, message: auth.message }, auth.status);
  const id = clean(payload.id, 60);
  if (!id) return json({ ok: false, message: '문서번호가 필요합니다.' }, 400);
  try {
    const document = await env.DB.prepare(`SELECT * FROM documents WHERE id = ?`).bind(id).first<Record<string, unknown>>();
    if (!document) return json({ ok: false, message: '해당 문서를 찾을 수 없습니다.' }, 404);
    let readable = canReadDocument(auth.user, document);
    if (!readable && document.access_scope === '관련자') {
      const related = await env.DB.prepare(`SELECT 1 AS allowed FROM document_approval_lines WHERE document_id = ? AND user_id = ? LIMIT 1`)
        .bind(id, auth.user.id).first<{ allowed: number }>();
      readable = !!related;
    }
    if (!readable) return json({ ok: false, message: '이 문서를 열람할 권한이 없습니다.' }, 403);
    const [approvals, approvalLines, attachments] = await Promise.all([
      env.DB.prepare(`SELECT * FROM document_approvals WHERE document_id = ? ORDER BY created_at ASC, rowid ASC`).bind(id).all(),
      env.DB.prepare(`SELECT * FROM document_approval_lines WHERE document_id = ? ORDER BY line_order ASC`).bind(id).all(),
      env.DB.prepare(`SELECT id, file_name, mime_type, size_bytes, created_at FROM document_attachments WHERE document_id = ? ORDER BY created_at ASC`).bind(id).all(),
    ]);
    let formData = {};
    try { formData = JSON.parse(String(document.form_data_json || '{}')); } catch { formData = {}; }
    return json({
      ok: true,
      document: { ...document, form_data: formData },
      approvals: approvals.results ?? [],
      approvalLines: approvalLines.results ?? [],
      attachments: attachments.results ?? [],
      me: auth.user,
    });
  } catch (error) {
    console.error('document detail failed', error);
    return json({ ok: false, message: '문서 조회 중 오류가 발생했습니다.' }, 500);
  }
};
export const onRequestGet: PagesFunction = async () => json({ ok: false, message: 'POST 방식으로 요청해 주세요.' }, 405);
