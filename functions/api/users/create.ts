import {
  authenticateSession,
  clean,
  ensureTables,
  hashPassword,
  json,
  randomHex,
} from '../../_shared/helpers';

interface Env {
  DB: D1Database;
}

type CreatePayload = {
  token?: string;
  name?: string;
  username?: string;
  password?: string;
  position?: string;
  grade?: string;
  department?: string;
  role?: string;
  canApprove?: boolean;
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB) return json({ ok: false, message: 'DB가 연결되지 않았습니다.' }, 500);

  let payload: CreatePayload;
  try {
    payload = await request.json();
  } catch (error) {
    return json({ ok: false, message: '요청 형식이 올바르지 않습니다.' }, 400);
  }

  await ensureTables(env.DB);
  const auth = await authenticateSession(env.DB, clean(payload.token, 200));
  if (!auth.ok) return json({ ok: false, message: auth.message }, auth.status);
  if (auth.user.role !== 'admin') return json({ ok: false, message: '계정 관리는 관리자만 할 수 있습니다.' }, 403);

  const name = clean(payload.name, 40);
  const username = clean(payload.username, 60);
  const password = typeof payload.password === 'string' ? payload.password.slice(0, 200) : '';
  const position = clean(payload.position, 40);
  const grade = clean(payload.grade, 20);
  const department = clean(payload.department, 60);
  const role = payload.role === 'admin' ? 'admin' : 'user';
  const canApprove = !!payload.canApprove || role === 'admin';

  if (!name) return json({ ok: false, message: '성명을 입력해 주세요.' }, 400);
  if (!username || username.length < 3) return json({ ok: false, message: '아이디를 3자 이상 입력해 주세요.' }, 400);
  if (!password || password.length < 8) return json({ ok: false, message: '비밀번호를 8자 이상 입력해 주세요.' }, 400);

  try {
    const existing = await env.DB.prepare(`SELECT id FROM system_users WHERE username = ?`).bind(username).first();
    if (existing) return json({ ok: false, message: '이미 사용 중인 아이디입니다.' }, 400);

    const id = `USR-${randomHex(20)}`;
    const passwordHash = await hashPassword(password);
    const now = new Date().toISOString();
    await env.DB.prepare(`
      INSERT INTO system_users (id, name, username, password_hash, position, grade, department, role, can_approve, active, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    `).bind(id, name, username, passwordHash, position || null, grade || null, department || null, role, canApprove ? 1 : 0, now).run();

    return json({ ok: true, id, message: '계정이 생성되었습니다.' });
  } catch (error) {
    return json({ ok: false, message: '계정 생성 중 오류가 발생했습니다.' }, 500);
  }
};

export const onRequestGet: PagesFunction = async () =>
  json({ ok: false, message: 'POST 방식으로 요청해 주세요.' }, 405);
