import {
  checkAuthRateLimit,
  clean,
  clearAuthFailures,
  ensureTables,
  hashPassword,
  json,
  randomHex,
  recordAuthFailure,
  verifyAdminToken,
} from '../../_shared/helpers';

interface Env {
  DB: D1Database;
  ADMIN_TOKEN: string;
}

type BootstrapPayload = {
  adminToken?: string;
  name?: string;
  username?: string;
  password?: string;
  position?: string;
};

// 최초 관리자 계정을 만들거나(계정이 하나도 없을 때), Cloudflare Pages 환경변수의
// ADMIN_TOKEN(마스터 키)을 아는 사람만 추가 관리자 계정을 복구용으로 만들 수 있게 하는 엔드포인트입니다.
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB) return json({ ok: false, message: 'DB가 연결되지 않았습니다.' }, 500);
  if (!env.ADMIN_TOKEN) return json({ ok: false, message: 'ADMIN_TOKEN이 설정되지 않았습니다.' }, 500);

  let payload: BootstrapPayload;
  try {
    payload = await request.json();
  } catch (error) {
    return json({ ok: false, message: '요청 형식이 올바르지 않습니다.' }, 400);
  }

  const authRateLimit = await checkAuthRateLimit(env.DB, request, 'bootstrap');
  if (!authRateLimit.ok) return json({ ok: false, message: authRateLimit.message }, 429);

  const adminToken = clean(payload.adminToken, 300);
  if (!(await verifyAdminToken(adminToken, env.ADMIN_TOKEN))) {
    await recordAuthFailure(env.DB, authRateLimit.rateKey);
    return json({ ok: false, message: '마스터 인증값(ADMIN_TOKEN)이 올바르지 않습니다.' }, 401);
  }
  await clearAuthFailures(env.DB, authRateLimit.rateKey);

  const name = clean(payload.name, 40);
  const username = clean(payload.username, 60);
  const password = typeof payload.password === 'string' ? payload.password.slice(0, 200) : '';
  const position = clean(payload.position, 40);

  if (!name) return json({ ok: false, message: '성명을 입력해 주세요.' }, 400);
  if (!username || username.length < 3) return json({ ok: false, message: '아이디를 3자 이상 입력해 주세요.' }, 400);
  if (!password || password.length < 8) return json({ ok: false, message: '비밀번호를 8자 이상 입력해 주세요.' }, 400);

  try {
    await ensureTables(env.DB);
    const existing = await env.DB.prepare(`SELECT id FROM system_users WHERE username = ?`).bind(username).first();
    if (existing) return json({ ok: false, message: '이미 사용 중인 아이디입니다.' }, 400);

    const id = `USR-${randomHex(20)}`;
    const passwordHash = await hashPassword(password);
    const now = new Date().toISOString();
    await env.DB.prepare(`
      INSERT INTO system_users (id, name, username, password_hash, position, grade, role, can_approve, active, created_at)
      VALUES (?, ?, ?, ?, ?, NULL, 'admin', 1, 1, ?)
    `).bind(id, name, username, passwordHash, position || '관리자', now).run();

    return json({ ok: true, id, message: '관리자 계정이 생성되었습니다. 이제 이 아이디로 로그인해 주세요.' });
  } catch (error) {
    return json({ ok: false, message: '관리자 계정 생성 중 오류가 발생했습니다.' }, 500);
  }
};

export const onRequestGet: PagesFunction = async () =>
  json({ ok: false, message: 'POST 방식으로 요청해 주세요.' }, 405);
