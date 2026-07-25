import {
  checkAuthRateLimit,
  clean,
  clearAuthFailures,
  createSession,
  ensureTables,
  json,
  recordAuthFailure,
  verifyPassword,
} from '../../_shared/helpers';

interface Env {
  DB: D1Database;
}

type LoginPayload = { username?: string; password?: string };

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB) return json({ ok: false, message: 'DB가 연결되지 않았습니다.' }, 500);

  let payload: LoginPayload;
  try {
    payload = await request.json();
  } catch (error) {
    return json({ ok: false, message: '요청 형식이 올바르지 않습니다.' }, 400);
  }

  const authRateLimit = await checkAuthRateLimit(env.DB, request, 'login');
  if (!authRateLimit.ok) return json({ ok: false, message: authRateLimit.message }, 429);

  const username = clean(payload.username, 60);
  const password = typeof payload.password === 'string' ? payload.password.slice(0, 200) : '';

  if (!username || !password) {
    return json({ ok: false, message: '아이디와 비밀번호를 입력해 주세요.' }, 400);
  }

  try {
    await ensureTables(env.DB);
    const user = await env.DB.prepare(`
      SELECT id, name, username, password_hash, position, grade, role, can_approve, active
      FROM system_users WHERE username = ?
    `).bind(username).first<{
      id: string; name: string; username: string; password_hash: string;
      position: string | null; grade: string | null; role: string; can_approve: number; active: number;
    }>();

    if (!user || !user.active || !(await verifyPassword(password, user.password_hash))) {
      await recordAuthFailure(env.DB, authRateLimit.rateKey);
      return json({ ok: false, message: '아이디 또는 비밀번호가 올바르지 않습니다.' }, 401);
    }
    await clearAuthFailures(env.DB, authRateLimit.rateKey);

    const token = await createSession(env.DB, user.id);

    return json({
      ok: true,
      token,
      user: {
        id: user.id, name: user.name, username: user.username,
        position: user.position, grade: user.grade, role: user.role, canApprove: !!user.can_approve,
      },
    });
  } catch (error) {
    return json({ ok: false, message: '로그인 처리 중 오류가 발생했습니다.' }, 500);
  }
};

export const onRequestGet: PagesFunction = async () =>
  json({ ok: false, message: 'POST 방식으로 요청해 주세요.' }, 405);
