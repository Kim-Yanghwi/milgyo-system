import {
  authenticateSession,
  clean,
  ensureTables,
  json,
} from '../../_shared/helpers';

interface Env {
  DB: D1Database;
}

type ListPayload = { token?: string; direction?: string; query?: string };

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
