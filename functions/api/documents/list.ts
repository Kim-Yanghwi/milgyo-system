import {
  authenticateSession,
  clean,
  ensureTables,
  json,
} from '../../_shared/helpers';

interface Env {
  DB: D1Database;
}

type ListPayload = {
  token?: string;
  view?: string; // '결재대기' | '발송대기' | '완료' | '전체' | '반려'
  query?: string;
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB) return json({ ok: false, message: 'DB가 연결되지 않았습니다.' }, 500);

  let payload: ListPayload;
  try {
    payload = await request.json();
  } catch (error) {
    return json({ ok: false, message: '요청 형식이 올바르지 않습니다.' }, 400);
  }

  await ensureTables(env.DB);
  const auth = await authenticateSession(env.DB, clean(payload.token, 200));
  if (!auth.ok) return json({ ok: false, message: auth.message }, auth.status);

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
    const statement = env.DB.prepare(`
      SELECT id, doc_type, category, title, summary, drafter, drafter_position, department, recipient, via,
             approval_track, status, sent_method, sent_at, created_at, updated_at,
             reviewer_name, reviewer_position, approver_name, approver_position, approver_user_id
      FROM documents
      ${where}
      ORDER BY created_at DESC
      LIMIT 300
    `);
    const result = bindings.length ? await statement.bind(...bindings).all() : await statement.all();
    return json({ ok: true, rows: result.results ?? [], me: auth.user });
  } catch (error) {
    return json({ ok: false, message: '문서 목록 조회 중 오류가 발생했습니다.' }, 500);
  }
};

export const onRequestGet: PagesFunction = async () =>
  json({ ok: false, message: 'POST 방식으로 요청해 주세요.' }, 405);
