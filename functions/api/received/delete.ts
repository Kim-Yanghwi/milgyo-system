import { authenticateSession, clean, ensureTables, json, randomHex } from '../../_shared/helpers';

interface Env { DB: D1Database; FILES?: R2Bucket; }
type Payload = { token?: string; id?: string };

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB) return json({ ok: false, message: 'DB가 연결되지 않았습니다.' }, 500);
  let payload: Payload;
  try { payload = await request.json(); } catch {
    return json({ ok: false, message: '요청 형식이 올바르지 않습니다.' }, 400);
  }

  try {
    await ensureTables(env.DB);
    const auth = await authenticateSession(env.DB, clean(payload.token, 200));
    if (!auth.ok) return json({ ok: false, message: auth.message }, auth.status);

    const id = clean(payload.id, 60);
    const existing = await env.DB.prepare(`
      SELECT id, direction, related_document_id, CAST(handled_by_user_id AS TEXT) AS handled_by_user_id
      FROM received_documents WHERE id = ?
    `).bind(id).first<{
      id: string;
      direction: string;
      related_document_id: string | null;
      handled_by_user_id: string | null;
    }>();
    if (!existing) return json({ ok: false, message: '삭제할 대장 문서를 찾을 수 없습니다.' }, 404);
    if (auth.user.role !== 'admin' && existing.handled_by_user_id !== auth.user.id) {
      return json({ ok: false, message: '등록자 또는 관리자만 삭제할 수 있습니다.' }, 403);
    }

    const keys = await env.DB.prepare(`
      SELECT r2_key FROM received_attachments
      WHERE received_document_id = ? AND storage_type = 'r2' AND r2_key IS NOT NULL
    `).bind(id).all<{ r2_key: string }>();

    const now = new Date().toISOString();
    const statements: D1PreparedStatement[] = [
      env.DB.prepare(`DELETE FROM received_attachments WHERE received_document_id = ?`).bind(id),
      env.DB.prepare(`DELETE FROM document_dispatch_links WHERE registry_id = ?`).bind(id),
      env.DB.prepare(`DELETE FROM received_documents WHERE id = ?`).bind(id),
    ];

    if (existing.direction === '외부발송' && existing.related_document_id) {
      statements.push(
        env.DB.prepare(`
          UPDATE documents
          SET status = CASE WHEN status = '발송완료' THEN '승인' ELSE status END,
              sent_method = NULL,
              sent_at = NULL,
              updated_at = ?
          WHERE id = ?
        `).bind(now, existing.related_document_id),
        env.DB.prepare(`
          INSERT INTO document_approvals
            (id, document_id, action, approver_name, approver_role, memo, created_at)
          VALUES (?, ?, '발송기록취소', ?, ?, ?, ?)
        `).bind(
          `AP-${randomHex(20)}`,
          existing.related_document_id,
          auth.user.name,
          auth.user.position || '담당자',
          `접수·발송대장 ${id} 삭제로 발송대기 상태 복원`,
          now,
        ),
      );
    }

    await env.DB.batch(statements);
    const r2Keys = (keys.results ?? []).map((row) => row.r2_key).filter(Boolean);
    if (env.FILES && r2Keys.length) await env.FILES.delete(r2Keys).catch(() => undefined);

    return json({
      ok: true,
      message: existing.direction === '외부발송' && existing.related_document_id
        ? '외부발송 기록을 삭제하고 연결 문서를 발송대기 상태로 되돌렸습니다.'
        : '접수·발송대장 문서가 삭제되었습니다.',
    });
  } catch (error) {
    console.error('received delete failed', error);
    return json({ ok: false, message: '대장 문서 삭제 중 오류가 발생했습니다.' }, 500);
  }
};

export const onRequestGet: PagesFunction = async () =>
  json({ ok: false, message: 'POST 방식으로 요청해 주세요.' }, 405);
