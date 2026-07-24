import {
  checkAdminAuthRateLimit,
  clean,
  clearAdminAuthFailures,
  ensureTables,
  json,
  randomHex,
  recordAdminAuthFailure,
  verifyAdminToken,
} from '../../_shared/helpers';

interface Env {
  DB: D1Database;
  ADMIN_TOKEN: string;
}

type DecidePayload = {
  token?: string;
  id?: string;
  action?: string; // '승인' | '반려'
  approverName?: string;
  approverRole?: string;
  memo?: string;
};

const VALID_ACTIONS = ['승인', '반려'];
const VALID_ROLES = ['이사장', '사무총장', '재정국장', '총무원장', '교육·포교원장', '이사회지정자'];

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB) return json({ ok: false, message: 'DB가 연결되지 않았습니다.' }, 500);
  if (!env.ADMIN_TOKEN) return json({ ok: false, message: 'ADMIN_TOKEN이 설정되지 않았습니다.' }, 500);

  let payload: DecidePayload;
  try {
    payload = await request.json();
  } catch (error) {
    return json({ ok: false, message: '요청 형식이 올바르지 않습니다.' }, 400);
  }

  const authRateLimit = await checkAdminAuthRateLimit(env.DB, request);
  if (!authRateLimit.ok) return json({ ok: false, message: authRateLimit.message }, 429);

  const token = clean(payload.token, 300);
  if (!(await verifyAdminToken(token, env.ADMIN_TOKEN))) {
    await recordAdminAuthFailure(env.DB, authRateLimit.rateKey);
    return json({ ok: false, message: '관리자 인증값이 올바르지 않습니다.' }, 401);
  }
  await clearAdminAuthFailures(env.DB, authRateLimit.rateKey);

  const id = clean(payload.id, 60);
  const action = clean(payload.action, 10);
  const approverName = clean(payload.approverName, 40);
  const approverRole = clean(payload.approverRole, 20);
  const memo = clean(payload.memo, 2000);

  if (!id) return json({ ok: false, message: '문서번호가 필요합니다.' }, 400);
  if (!VALID_ACTIONS.includes(action)) {
    return json({ ok: false, message: '결재 처리는 승인 또는 반려만 가능합니다.' }, 400);
  }
  if (!approverName) return json({ ok: false, message: '결재자 성명을 입력해 주세요.' }, 400);
  if (!VALID_ROLES.includes(approverRole)) {
    return json({ ok: false, message: '결재자 직책을 규정에 맞게 선택해 주세요(제13조②).' }, 400);
  }

  try {
    await ensureTables(env.DB);
    const document = await env.DB.prepare(`SELECT id, status, approval_track FROM documents WHERE id = ?`)
      .bind(id)
      .first<{ id: string; status: string; approval_track: string }>();

    if (!document) return json({ ok: false, message: '해당 문서를 찾을 수 없습니다.' }, 404);
    if (document.approval_track === '전결') {
      return json({ ok: false, message: '전결대상 문서는 별도 결재 처리가 필요하지 않습니다.' }, 400);
    }
    if (document.status !== '결재대기') {
      return json({ ok: false, message: `이미 "${document.status}" 상태로 처리된 문서입니다.` }, 400);
    }

    const now = new Date().toISOString();
    const newStatus = action === '승인' ? '승인' : '반려';

    await env.DB.batch([
      env.DB.prepare(`UPDATE documents SET status = ?, updated_at = ? WHERE id = ?`)
        .bind(newStatus, now, id),
      env.DB.prepare(`
        INSERT INTO document_approvals (id, document_id, action, approver_name, approver_role, memo, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
        .bind(`AP-${randomHex(20)}`, id, newStatus, approverName, approverRole, memo || null, now),
    ]);

    return json({ ok: true, status: newStatus, message: `문서가 ${newStatus} 처리되었습니다.` });
  } catch (error) {
    return json({ ok: false, message: '결재 처리 중 오류가 발생했습니다.' }, 500);
  }
};

export const onRequestGet: PagesFunction = async () =>
  json({ ok: false, message: 'POST 방식으로 요청해 주세요.' }, 405);
