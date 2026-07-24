// 발송대기함(승인 완료된 발송문서)을 실제로 발송한 뒤 "발송완료"로 표시한다.
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

type MarkSentPayload = {
  token?: string;
  id?: string;
  sentMethod?: string;
  handledBy?: string;
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB) return json({ ok: false, message: 'DB가 연결되지 않았습니다.' }, 500);
  if (!env.ADMIN_TOKEN) return json({ ok: false, message: 'ADMIN_TOKEN이 설정되지 않았습니다.' }, 500);

  let payload: MarkSentPayload;
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
  const sentMethod = clean(payload.sentMethod, 40);
  const handledBy = clean(payload.handledBy, 40);

  if (!id) return json({ ok: false, message: '문서번호가 필요합니다.' }, 400);
  if (!sentMethod) return json({ ok: false, message: '발송방법을 입력해 주세요(제16조).' }, 400);
  if (!handledBy) return json({ ok: false, message: '발송 처리자를 입력해 주세요.' }, 400);

  try {
    await ensureTables(env.DB);
    const document = await env.DB.prepare(`SELECT id, doc_type, status FROM documents WHERE id = ?`)
      .bind(id)
      .first<{ id: string; doc_type: string; status: string }>();

    if (!document) return json({ ok: false, message: '해당 문서를 찾을 수 없습니다.' }, 404);
    if (document.doc_type !== '발송') {
      return json({ ok: false, message: '발송문서만 발송완료 처리할 수 있습니다.' }, 400);
    }
    if (document.status !== '승인') {
      return json({ ok: false, message: '결재가 승인된 문서만 발송 처리할 수 있습니다.' }, 400);
    }

    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(`UPDATE documents SET status = '발송완료', sent_method = ?, sent_at = ?, updated_at = ? WHERE id = ?`)
        .bind(sentMethod, now, now, id),
      env.DB.prepare(`
        INSERT INTO document_approvals (id, document_id, action, approver_name, approver_role, memo, created_at)
        VALUES (?, ?, '발송완료', ?, '담당자', ?, ?)
      `)
        .bind(`AP-${randomHex(20)}`, id, handledBy, `발송방법: ${sentMethod}`, now),
    ]);

    return json({ ok: true, message: '발송완료로 처리되었습니다.' });
  } catch (error) {
    return json({ ok: false, message: '발송 처리 중 오류가 발생했습니다.' }, 500);
  }
};

export const onRequestGet: PagesFunction = async () =>
  json({ ok: false, message: 'POST 방식으로 요청해 주세요.' }, 405);
