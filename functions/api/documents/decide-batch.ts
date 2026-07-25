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

type DecideBatchPayload = {
  token?: string;
  ids?: unknown;
  action?: string; // '승인' | '반려'
  memo?: string;
};

const VALID_ACTIONS = ['승인', '반려'];
const MAX_BATCH = 50;

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB) return json({ ok: false, message: 'DB가 연결되지 않았습니다.' }, 500);

  let payload: DecideBatchPayload;
  try {
    payload = await request.json();
  } catch (error) {
    return json({ ok: false, message: '요청 형식이 올바르지 않습니다.' }, 400);
  }

  await ensureTables(env.DB);
  const auth = await authenticateSession(env.DB, clean(payload.token, 200));
  if (!auth.ok) return json({ ok: false, message: auth.message }, auth.status);
  const me = auth.user;

  const rawIds = Array.isArray(payload.ids) ? payload.ids : [];
  const ids = rawIds
    .map((value) => clean(value, 60))
    .filter((value, index, arr) => value && arr.indexOf(value) === index)
    .slice(0, MAX_BATCH);
  const action = clean(payload.action, 10);
  const memo = clean(payload.memo, 2000);

  if (!ids.length) return json({ ok: false, message: '일괄결재할 문서를 먼저 선택해 주세요.' }, 400);
  if (!VALID_ACTIONS.includes(action)) {
    return json({ ok: false, message: '결재 처리는 승인 또는 반려만 가능합니다.' }, 400);
  }

  try {
    const now = new Date().toISOString();
    const newStatus = action === '승인' ? '승인' : '반려';

    const placeholders = ids.map(() => '?').join(', ');
    const rows = await env.DB.prepare(
      `SELECT id, status, approval_track, approver_user_id FROM documents WHERE id IN (${placeholders})`,
    ).bind(...ids).all<{ id: string; status: string; approval_track: string; approver_user_id: string | null }>();

    const eligible = (rows.results ?? []).filter(
      (row) => row.status === '결재대기' && row.approval_track !== '전결'
        && (me.role === 'admin' || row.approver_user_id === me.id),
    );
    const eligibleIds = new Set(eligible.map((row) => row.id));
    const skipped = ids.filter((id) => !eligibleIds.has(id));

    if (!eligible.length) {
      return json({
        ok: false,
        message: '선택한 문서 중 본인이 결재자로 지정된 결재대기 문서가 없습니다(전결·이미 처리된 문서·타인 지정 문서는 제외됩니다).',
      }, 400);
    }

    const statements = eligible.flatMap((row) => [
      env.DB.prepare(`UPDATE documents SET status = ?, updated_at = ? WHERE id = ?`)
        .bind(newStatus, now, row.id),
      env.DB.prepare(`
        INSERT INTO document_approvals (id, document_id, action, approver_name, approver_role, memo, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
        .bind(`AP-${randomHex(20)}`, row.id, newStatus, me.name, me.position || '결재자', memo || null, now),
    ]);
    await env.DB.batch(statements);

    return json({
      ok: true,
      processed: eligible.length,
      skipped,
      message: `${eligible.length}건이 일괄 ${newStatus} 처리되었습니다.${skipped.length ? ` (제외 ${skipped.length}건: 결재대기 상태가 아니거나, 전결대상, 또는 본인 결재 지정 문서가 아님)` : ''}`,
    });
  } catch (error) {
    return json({ ok: false, message: '일괄 결재 처리 중 오류가 발생했습니다.' }, 500);
  }
};

export const onRequestGet: PagesFunction = async () =>
  json({ ok: false, message: 'POST 방식으로 요청해 주세요.' }, 405);
