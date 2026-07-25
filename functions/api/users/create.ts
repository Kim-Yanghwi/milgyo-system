import {
  authenticateSession,
  clean,
  ensureTables,
  hashPassword,
  insertSystemUser,
  isSchemaError,
  json,
  repairTables,
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

const createAccount = async (
  db: D1Database,
  input: {
    name: string;
    username: string;
    passwordHash: string;
    position: string;
    grade: string;
    department: string;
    role: 'admin' | 'user';
    canApprove: boolean;
  },
) => insertSystemUser(db, {
  name: input.name,
  username: input.username,
  passwordHash: input.passwordHash,
  position: input.position || null,
  grade: input.grade || null,
  department: input.department || null,
  role: input.role,
  canApprove: input.canApprove,
  active: true,
});

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB) return json({ ok: false, message: 'DB가 연결되지 않았습니다.' }, 500);

  let payload: CreatePayload;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, message: '요청 형식이 올바르지 않습니다.' }, 400);
  }

  try {
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
    const role: 'admin' | 'user' = payload.role === 'admin' ? 'admin' : 'user';
    const canApprove = !!payload.canApprove || role === 'admin';

    if (!name) return json({ ok: false, message: '성명을 입력해 주세요.' }, 400);
    if (!username || username.length < 3) return json({ ok: false, message: '아이디를 3자 이상 입력해 주세요.' }, 400);
    if (/\s/.test(username)) return json({ ok: false, message: '아이디에는 공백을 사용할 수 없습니다.' }, 400);
    if (!password || password.length < 8) return json({ ok: false, message: '비밀번호를 8자 이상 입력해 주세요.' }, 400);

    const existing = await env.DB.prepare(`SELECT id FROM system_users WHERE username = ? COLLATE NOCASE`)
      .bind(username).first();
    if (existing) return json({ ok: false, message: '이미 사용 중인 아이디입니다.' }, 400);

    const passwordHash = await hashPassword(password);
    const input = { name, username, passwordHash, position, grade, department, role, canApprove };

    const findCreatedAccount = async () => env.DB.prepare(`
      SELECT CAST(id AS TEXT) AS id, name FROM system_users WHERE username = ? COLLATE NOCASE LIMIT 1
    `).bind(username).first<{ id: string; name: string }>();

    let id = '';
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 2 && !id; attempt += 1) {
      try {
        id = await createAccount(env.DB, input);
      } catch (error) {
        lastError = error;
        // 쓰기는 성공했지만 응답만 실패한 경우나 중복 클릭은 기존 행을 확인해 성공으로 복구합니다.
        const created = await findCreatedAccount().catch(() => null);
        if (created?.id && created.name === name) {
          id = String(created.id);
          break;
        }
        if (attempt === 0 && isSchemaError(error)) {
          console.warn('system_users schema mismatch detected; retrying after repair', error);
          await repairTables(env.DB);
          continue;
        }
        const message = error instanceof Error ? error.message : String(error);
        if (attempt === 0 && /database is locked|database is busy|temporar|D1_ERROR|internal error|storage/i.test(message)) {
          await new Promise((resolve) => setTimeout(resolve, 120));
          continue;
        }
        throw error;
      }
    }
    if (!id) throw lastError || new Error('계정 생성 결과를 확인하지 못했습니다.');

    return json({ ok: true, id, message: '계정이 생성되었습니다.' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('user create failed', error);
    if (/unique constraint failed: system_users\.username|idx_system_users_username/i.test(message)) {
      return json({ ok: false, message: '이미 사용 중인 아이디입니다.' }, 400);
    }
    if (/cpu time|resource limits|operationerror|derivebits/i.test(message)) {
      return json({ ok: false, message: '비밀번호 암호화 처리에 실패했습니다. 잠시 후 다시 시도해 주세요.' }, 500);
    }
    return json({ ok: false, message: '계정 생성 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요. 오류가 계속되면 시스템 관리자에게 문의해 주세요.' }, 500);
  }
};

export const onRequestGet: PagesFunction = async () =>
  json({ ok: false, message: 'POST 방식으로 요청해 주세요.' }, 405);
