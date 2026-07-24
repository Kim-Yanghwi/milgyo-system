import {
  checkAdminAuthRateLimit,
  clean,
  clearAdminAuthFailures,
  ensureTables,
  json,
  recordAdminAuthFailure,
  verifyAdminToken,
} from '../../_shared/helpers';

interface Env {
  DB: D1Database;
  ADMIN_TOKEN: string;
}

type ListPayload = {
  token?: string;
  view?: string; // '결재대기' | '발송대기' | '완료' | '전체'
  query?: string;
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB) return json({ ok: false, message: 'DB가 연결되지 않았습니다.' }, 500);
  if (!env.ADMIN_TOKEN) return json({ ok: false, message: 'ADMIN_TOKEN이 설정되지 않았습니다.' }, 500);

  let payload: ListPayload;
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

  const view = clean(payload.view, 20) || '전체';
  const query = clean(payload.query, 80);

  const filters: string[] = [];
  const bindings: string[] = [];

  if (view === '결재대기') {
    filters.push(`status = '결재대기'`);
  } else if (view === '발송대기') {
    filters.push(`status = '승인' AND doc_type = '발송'`);
  } else if (view === '완료') {
    filters.push(`status IN ('승인', '발송완료') AND NOT (status = '승인' AND doc_type = '발송')`);
  } else if (view === '반려') {
    filters.push(`status = '반려'`);
  }

  if (query) {
    filters.push(`(id LIKE ? OR title LIKE ? OR drafter LIKE ? OR category LIKE ? OR recipient LIKE ?)`);
    const keyword = `%${query}%`;
    bindings.push(keyword, keyword, keyword, keyword, keyword);
  }

  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

  try {
    await ensureTables(env.DB);
    const statement = env.DB.prepare(`
      SELECT d.id, d.doc_type, d.category, d.title, d.drafter, d.department, d.recipient, d.approval_track,
             d.status, d.sent_method, d.sent_at, d.created_at, d.updated_at,
             (SELECT approver_name FROM document_approvals a
               WHERE a.document_id = d.id ORDER BY a.created_at DESC LIMIT 1) AS reviewer_name,
             (SELECT approver_role FROM document_approvals a
               WHERE a.document_id = d.id ORDER BY a.created_at DESC LIMIT 1) AS reviewer_role
      FROM documents d
      ${where}
      ORDER BY d.created_at DESC
      LIMIT 300
    `);
    const result = bindings.length ? await statement.bind(...bindings).all() : await statement.all();
    return json({ ok: true, rows: result.results ?? [] });
  } catch (error) {
    return json({ ok: false, message: '문서 목록 조회 중 오류가 발생했습니다.' }, 500);
  }
};

export const onRequestGet: PagesFunction = async () =>
  json({ ok: false, message: 'POST 방식으로 요청해 주세요.' }, 405);
