import { AuthSchemaError } from '../../_shared/security/sessions';
import {
  checkAuthRateLimit,
  clean,
  ensureTables,
  hashPassword,
  insertSystemUser,
  isSchemaError,
  json,
  repairTables,
  verifyAdminToken,
} from '../../_shared/helpers';

interface Env {
  DB: D1Database;
  ADMIN_TOKEN: string;
  ENABLE_ADMIN_BOOTSTRAP?: string;
}

type BootstrapPayload = {
  adminToken?: string;
  name?: string;
  username?: string;
  password?: string;
  position?: string;
};

// 최초 관리자 계정을 만들거나, ADMIN_TOKEN을 아는 관리자가 복구용 관리자 계정을 추가합니다.
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (env.ENABLE_ADMIN_BOOTSTRAP !== 'true') return json({ ok: false, code: 'BOOTSTRAP_DISABLED', message: '\ucd08\uae30 \uad00\ub9ac\uc790 \uc0dd\uc131\uc774 \ube44\ud65c\uc131\ud654\ub418\uc5b4 \uc788\uc2b5\ub2c8\ub2e4.' }, 403);
  if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 32 || env.ADMIN_TOKEN.length > 256 || env.ADMIN_TOKEN.trim() !== env.ADMIN_TOKEN) return json({ ok: false, code: 'BOOTSTRAP_CONFIGURATION_ERROR', message: '\ubcf5\uad6c \ud0a4 \uc124\uc815\uc744 \ud655\uc778\ud574 \uc8fc\uc138\uc694.' }, 503);
  if (!env.DB) return json({ ok: false, message: 'DB가 연결되지 않았습니다.' }, 500);
  if (!env.ADMIN_TOKEN) return json({ ok: false, message: 'ADMIN_TOKEN이 설정되지 않았습니다.' }, 500);

  let payload: BootstrapPayload;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, message: '요청 형식이 올바르지 않습니다.' }, 400);
  }

  let stage = 'rate-limit';
  try {
    const authRateLimit = await checkAuthRateLimit(env.DB, request, 'bootstrap');
    if (!authRateLimit.ok) return json({ ok: false, code: 'AUTH_RATE_LIMITED', message: authRateLimit.message }, 429, { 'Retry-After': String(authRateLimit.retryAfter) });

    stage = 'admin-token';
    const adminToken = clean(payload.adminToken, 300);
    if (!(await verifyAdminToken(adminToken, env.ADMIN_TOKEN))) {
      return json({ ok: false, message: '마스터 인증값(ADMIN_TOKEN)이 올바르지 않습니다.' }, 401);
    }

    const name = clean(payload.name, 40);
    const username = clean(payload.username, 60);
    const password = typeof payload.password === 'string' ? payload.password : '';
    if (password.length > 200) return json({ ok: false, code: 'PASSWORD_TOO_LONG', message: '\ube44\ubc00\ubc88\ud638\ub294 200\uc790 \uc774\ud558\ub85c \uc785\ub825\ud574 \uc8fc\uc138\uc694.' }, 400);
    const position = clean(payload.position, 40);

    if (!name) return json({ ok: false, message: '성명을 입력해 주세요.' }, 400);
    if (!username || username.length < 3) return json({ ok: false, message: '아이디를 3자 이상 입력해 주세요.' }, 400);
    if (/\s/.test(username)) return json({ ok: false, message: '아이디에는 공백을 사용할 수 없습니다.' }, 400);
    if (!password || password.length < 8) return json({ ok: false, message: '비밀번호를 8자 이상 입력해 주세요.' }, 400);

    stage = 'schema';
    await ensureTables(env.DB);
    stage = 'duplicate-check';
    const existing = await env.DB.prepare(`SELECT id FROM system_users WHERE username = ? COLLATE NOCASE`).bind(username).first();
    if (existing) return json({ ok: false, message: '이미 사용 중인 아이디입니다.' }, 400);

    stage = 'password-hash';
    const passwordHash = await hashPassword(password);
    const normalizedPosition = position || '관리자';
    const topLevelDepartments = new Set(['이사장','이사회','감사','종정','사무처','총무원','교육·포교원']);
    const input = {
      name,
      username,
      passwordHash,
      position: normalizedPosition,
      grade: null,
      department: normalizedPosition === '사무국장' ? '사무처 - 사무국' : (topLevelDepartments.has(normalizedPosition) ? normalizedPosition : null),
      role: 'admin' as const,
      canApprove: true,
      canAccounting: true,
      active: true,
    };

    let id: string;
    try {
      stage = 'insert-user';
      id = await insertSystemUser(env.DB, input);
    } catch (error) {
      if (!isSchemaError(error)) throw error;
      console.warn('bootstrap schema mismatch detected; retrying after repair', error);
      stage = 'schema-repair';
      await repairTables(env.DB);
      stage = 'insert-user-retry';
      id = await insertSystemUser(env.DB, input);
    }

    return json({ ok: true, id, message: '관리자 계정이 생성되었습니다. 이제 이 아이디로 로그인해 주세요.' });
  } catch (error) {
    // Let middleware return AUTH_SCHEMA_NOT_READY, not a misleading generic creation error.
    if (error instanceof AuthSchemaError) throw error;
    console.error('bootstrap failed', { stage, error });
    return json({ ok: false, message: '관리자 계정 생성 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' }, 500);
  }
};

export const onRequestGet: PagesFunction = async () =>
  json({ ok: false, message: 'POST 방식으로 요청해 주세요.' }, 405);
