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

type ListPayload = { token?: string; direction?: string; query?: string };

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

  const direction = clean(payload.direction, 10);
  const query = clean(payload.query, 80);

  const filters: string[] = [];
  const bindings: string[] = [];
  if (direction && direction !== '전체') {
    filters.push('direction = ?');
    bindings.push(direction);
  }
  if (query) {
    filters.push(`(id LIKE ? OR title LIKE ? OR counterparty LIKE ? OR source_system LIKE ?)`);
    const keyword = `%${query}%`;
    bindings.push(keyword, keyword, keyword, keyword);
  }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

  try {
    await ensureTables(env.DB);
    const statement = env.DB.prepare(`
      SELECT * FROM received_documents ${where} ORDER BY received_at DESC LIMIT 300
    `);
    const result = bindings.length ? await statement.bind(...bindings).all() : await statement.all();
    return json({ ok: true, rows: result.results ?? [] });
  } catch (error) {
    return json({ ok: false, message: '접수·발송대장 조회 중 오류가 발생했습니다.' }, 500);
  }
};

export const onRequestGet: PagesFunction = async () =>
  json({ ok: false, message: 'POST 방식으로 요청해 주세요.' }, 405);
