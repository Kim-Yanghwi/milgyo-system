import {
  authenticateSession,
  clean,
  ensureTables,
  hashPassword,
  json,
} from '../../_shared/helpers';

interface Env {
  DB: D1Database;
}

type UpdatePayload = {
  token?: string;
  id?: string;
  name?: string;
  position?: string;
  grade?: string;
  department?: string;
  role?: string;
  canApprove?: boolean;
  active?: boolean;
  newPassword?: string;
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB) return json({ ok: false, message: 'DB가 연결되지 않았습니다.' }, 500);

  let payload: UpdatePayload;
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

    const id = clean(payload.id, 60);
    if (!id) return json({ ok: false, message: '계정 정보가 필요합니다.' }, 400);

    const target = await env.DB.prepare(`
      SELECT CAST(id AS TEXT) AS id, role, active
      FROM system_users WHERE CAST(id AS TEXT) = ?
    `).bind(id).first<{ id: string; role: string; active: number }>();
    if (!target) return json({ ok: false, message: '해당 계정을 찾을 수 없습니다.' }, 404);

    const name = clean(payload.name, 40);
    const position = clean(payload.position, 40);
    const grade = clean(payload.grade, 20);
    const department = clean(payload.department, 60);
    const role = payload.role === 'admin' ? 'admin' : 'user';
    const canApprove = !!payload.canApprove || role === 'admin';
    const active = payload.active === undefined ? true : !!payload.active;
    const newPassword = typeof payload.newPassword === 'string' ? payload.newPassword.slice(0, 200) : '';

    if (!name) return json({ ok: false, message: '성명을 입력해 주세요.' }, 400);
    if (newPassword && newPassword.length < 8) {
      return json({ ok: false, message: '새 비밀번호는 8자 이상 입력해 주세요.' }, 400);
    }
    if (id === auth.user.id && !active) {
      return json({ ok: false, message: '현재 로그인한 본인 계정은 비활성화할 수 없습니다.' }, 400);
    }

    const removesAdmin = target.role === 'admin' && (role !== 'admin' || !active);
    if (removesAdmin) {
      const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM system_users WHERE role = 'admin' AND active = 1`)
        .first<{ count: number }>();
      if (Number(row?.count || 0) <= 1) {
        return json({ ok: false, message: '마지막 활성 관리자 계정은 일반 계정으로 변경하거나 비활성화할 수 없습니다.' }, 400);
      }
    }

    await env.DB.prepare(`
      UPDATE system_users
      SET name = ?, position = ?, grade = ?, department = ?, role = ?, can_approve = ?, active = ?
      WHERE CAST(id AS TEXT) = ?
    `).bind(name, position || null, grade || null, department || null, role, canApprove ? 1 : 0, active ? 1 : 0, id).run();

    if (newPassword) {
      const passwordHash = await hashPassword(newPassword);
      await env.DB.prepare(`UPDATE system_users SET password_hash = ? WHERE CAST(id AS TEXT) = ?`)
        .bind(passwordHash, id).run();
    }

    return json({ ok: true, message: '계정 정보가 수정되었습니다.' });
  } catch (error) {
    console.error('user update failed', error);
    return json({ ok: false, message: '계정 수정 중 오류가 발생했습니다.' }, 500);
  }
};

export const onRequestGet: PagesFunction = async () =>
  json({ ok: false, message: 'POST 방식으로 요청해 주세요.' }, 405);
