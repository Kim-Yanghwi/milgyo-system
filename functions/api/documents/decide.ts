import { authenticateSession, clean, ensureTables, json, randomHex } from '../../_shared/helpers';
interface Env { DB: D1Database; }
type DecidePayload = { token?: string; id?: string; action?: string; memo?: string };
const VALID_ACTIONS = ['승인', '반려', '검토완료'];

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB) return json({ ok: false, message: 'DB가 연결되지 않았습니다.' }, 500);
  let payload: DecidePayload;
  try { payload = await request.json(); } catch { return json({ ok: false, message: '요청 형식이 올바르지 않습니다.' }, 400); }
  await ensureTables(env.DB);
  const auth = await authenticateSession(env.DB, clean(payload.token, 200));
  if (!auth.ok) return json({ ok: false, message: auth.message }, auth.status);
  const me = auth.user;
  const id = clean(payload.id, 60);
  const action = clean(payload.action, 20);
  const memo = clean(payload.memo, 2000);
  if (!id) return json({ ok: false, message: '문서번호가 필요합니다.' }, 400);
  if (!VALID_ACTIONS.includes(action)) return json({ ok: false, message: '처리 구분이 올바르지 않습니다.' }, 400);

  try {
    const document = await env.DB.prepare(`
      SELECT id, status, approval_track, reviewer_user_id, approver_user_id FROM documents WHERE id = ?
    `).bind(id).first<{ id: string; status: string; approval_track: string; reviewer_user_id: string | null; approver_user_id: string | null }>();
    if (!document) return json({ ok: false, message: '해당 문서를 찾을 수 없습니다.' }, 404);
    if (document.approval_track === '전결') return json({ ok: false, message: '전결대상 문서는 별도 결재가 필요하지 않습니다.' }, 400);

    let newStatus = '';
    let recordedAction = action;
    if (document.status === '검토대기') {
      if (me.role !== 'admin' && document.reviewer_user_id !== me.id) return json({ ok: false, message: '지정된 검토자만 처리할 수 있습니다.' }, 403);
      if (action === '승인') recordedAction = '검토완료';
      if (!['검토완료', '반려'].includes(recordedAction)) return json({ ok: false, message: '검토 단계에서는 검토완료 또는 반려만 가능합니다.' }, 400);
      newStatus = recordedAction === '반려' ? '반려' : '결재대기';
    } else if (document.status === '결재대기') {
      if (me.role !== 'admin' && document.approver_user_id !== me.id) return json({ ok: false, message: '지정된 최종 결재자만 처리할 수 있습니다.' }, 403);
      if (!['승인', '반려'].includes(action)) return json({ ok: false, message: '최종 결재 단계에서는 승인 또는 반려만 가능합니다.' }, 400);
      newStatus = action;
    } else {
      return json({ ok: false, message: `이미 "${document.status}" 상태로 처리된 문서입니다.` }, 400);
    }

    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(`UPDATE documents SET status = ?, completed_at = CASE WHEN ? IN ('승인','반려') THEN ? ELSE completed_at END, updated_at = ? WHERE id = ?`)
        .bind(newStatus, newStatus, now, now, id),
      env.DB.prepare(`
        INSERT INTO document_approvals (id, document_id, action, approver_name, approver_role, memo, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(`AP-${randomHex(20)}`, id, recordedAction, me.name, me.position || '처리자', memo || null, now),
    ]);
    return json({ ok: true, status: newStatus, action: recordedAction, message: recordedAction === '검토완료' ? '검토가 완료되어 최종 결재자에게 전달되었습니다.' : `문서가 ${recordedAction} 처리되었습니다.` });
  } catch {
    return json({ ok: false, message: '결재 처리 중 오류가 발생했습니다.' }, 500);
  }
};
export const onRequestGet: PagesFunction = async () => json({ ok: false, message: 'POST 방식으로 요청해 주세요.' }, 405);
