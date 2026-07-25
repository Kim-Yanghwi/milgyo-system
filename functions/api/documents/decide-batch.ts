import { authenticateSession, clean, ensureTables, json, randomHex } from '../../_shared/helpers';
interface Env { DB: D1Database; }
type DecideBatchPayload = { token?: string; ids?: unknown; action?: string; memo?: string };
const MAX_BATCH = 50;

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB) return json({ ok: false, message: 'DB가 연결되지 않았습니다.' }, 500);
  let payload: DecideBatchPayload;
  try { payload = await request.json(); } catch { return json({ ok: false, message: '요청 형식이 올바르지 않습니다.' }, 400); }
  await ensureTables(env.DB);
  const auth = await authenticateSession(env.DB, clean(payload.token, 200));
  if (!auth.ok) return json({ ok: false, message: auth.message }, auth.status);
  const me = auth.user;
  const ids = (Array.isArray(payload.ids) ? payload.ids : []).map((v) => clean(v, 60)).filter((v, i, a) => v && a.indexOf(v) === i).slice(0, MAX_BATCH);
  const action = clean(payload.action, 10);
  const memo = clean(payload.memo, 2000);
  if (!ids.length) return json({ ok: false, message: '처리할 문서를 선택해 주세요.' }, 400);
  if (!['승인', '반려'].includes(action)) return json({ ok: false, message: '일괄 처리는 승인 또는 반려만 가능합니다.' }, 400);

  try {
    const placeholders = ids.map(() => '?').join(',');
    const rows = await env.DB.prepare(`SELECT id, status, reviewer_user_id, approver_user_id, approval_track FROM documents WHERE id IN (${placeholders})`)
      .bind(...ids).all<{ id: string; status: string; reviewer_user_id: string | null; approver_user_id: string | null; approval_track: string }>();
    const now = new Date().toISOString();
    const statements: D1PreparedStatement[] = [];
    const processed: string[] = [];
    const skipped: string[] = [];
    for (const row of rows.results ?? []) {
      if (row.approval_track === '전결') { skipped.push(row.id); continue; }
      let nextStatus = '';
      let recordedAction = action;
      if (row.status === '검토대기' && (me.role === 'admin' || row.reviewer_user_id === me.id)) {
        recordedAction = action === '승인' ? '검토완료' : '반려';
        nextStatus = recordedAction === '검토완료' ? '결재대기' : '반려';
      } else if (row.status === '결재대기' && (me.role === 'admin' || row.approver_user_id === me.id)) {
        nextStatus = action;
      } else { skipped.push(row.id); continue; }
      processed.push(row.id);
      statements.push(env.DB.prepare(`UPDATE documents SET status=?, completed_at=CASE WHEN ? IN ('승인','반려') THEN ? ELSE completed_at END, updated_at=? WHERE id=?`)
        .bind(nextStatus, nextStatus, now, now, row.id));
      statements.push(env.DB.prepare(`INSERT INTO document_approvals (id, document_id, action, approver_name, approver_role, memo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind(`AP-${randomHex(20)}`, row.id, recordedAction, me.name, me.position || '처리자', memo || null, now));
    }
    if (!processed.length) return json({ ok: false, message: '현재 계정이 처리할 수 있는 문서가 없습니다.' }, 400);
    await env.DB.batch(statements);
    return json({ ok: true, processed: processed.length, skipped, message: `${processed.length}건을 처리했습니다.${skipped.length ? ` 제외 ${skipped.length}건` : ''}` });
  } catch {
    return json({ ok: false, message: '일괄 처리 중 오류가 발생했습니다.' }, 500);
  }
};
export const onRequestGet: PagesFunction = async () => json({ ok: false, message: 'POST 방식으로 요청해 주세요.' }, 405);
