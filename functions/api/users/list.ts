import { authenticateSession, clean, ensureTables, json } from '../../_shared/helpers';

interface Env {
  DB: D1Database;
}

type ListPayload = { token?: string; includeInactive?: boolean };

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB) return json({ ok: false, message: 'DB가 연결되지 않았습니다.' }, 500);

  let payload: ListPayload;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, message: '요청 형식이 올바르지 않습니다.' }, 400);
  }

  try {
    await ensureTables(env.DB);
    const auth = await authenticateSession(env.DB, clean(payload.token, 200));
    if (!auth.ok) return json({ ok: false, message: auth.message }, auth.status);

    const includeInactive = !!payload.includeInactive && auth.user.role === 'admin';
    const rows = await env.DB.prepare(`
      SELECT CAST(id AS TEXT) AS id, name, username, position, grade, department, role, can_approve, can_accounting, active, created_at
      FROM system_users
      ${includeInactive ? '' : 'WHERE active = 1'}
      ORDER BY created_at ASC, name ASC
    `).all();
    return json({ ok: true, rows: rows.results ?? [] });
  } catch (error) {
    console.error('user list failed', error);
    return json({ ok: false, message: '계정 목록 조회 중 오류가 발생했습니다.' }, 500);
  }
};

export const onRequestGet: PagesFunction = async () =>
  json({ ok: false, message: 'POST 방식으로 요청해 주세요.' }, 405);
