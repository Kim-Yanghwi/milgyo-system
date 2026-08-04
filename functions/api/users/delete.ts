import { authenticateSession, clean, ensureTables, json, randomHex } from '../../_shared/helpers';

interface Env {
  DB: D1Database;
}

type DeletePayload = {
  token?: string;
  id?: string;
  confirmation?: string;
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB) return json({ ok: false, message: 'DB가 연결되지 않았습니다.' }, 500);

  let payload: DeletePayload;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, message: '요청 형식이 올바르지 않습니다.' }, 400);
  }

  try {
    await ensureTables(env.DB);
    const auth = await authenticateSession(env.DB, clean(payload.token, 200));
    if (!auth.ok) return json({ ok: false, message: auth.message }, auth.status);
    if (auth.user.role !== 'admin') return json({ ok: false, message: '계정 삭제는 관리자만 할 수 있습니다.' }, 403);

    const id = clean(payload.id, 60);
    if (!id) return json({ ok: false, message: '삭제할 계정 정보가 필요합니다.' }, 400);
    if (id === auth.user.id) return json({ ok: false, message: '현재 로그인한 본인 계정은 삭제할 수 없습니다.' }, 400);

    const target = await env.DB.prepare(`
      SELECT CAST(id AS TEXT) AS id,name,username,role,active
      FROM system_users WHERE CAST(id AS TEXT)=?
    `).bind(id).first<{ id: string; name: string; username: string; role: string; active: number }>();
    if (!target) return json({ ok: false, message: '해당 계정을 찾을 수 없습니다.' }, 404);
    if (clean(payload.confirmation, 60) !== target.username) {
      return json({ ok: false, message: `삭제 확인을 위해 아이디 ${target.username}을(를) 정확히 입력해 주세요.` }, 400);
    }

    if (target.role === 'admin' && Number(target.active || 0) === 1) {
      const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM system_users WHERE role='admin' AND active=1`)
        .first<{ count: number }>();
      if (Number(row?.count || 0) <= 1) {
        return json({ ok: false, message: '마지막 활성 관리자 계정은 삭제할 수 없습니다.' }, 400);
      }
    }

    const pending = await env.DB.prepare(`
      SELECT COUNT(*) AS count FROM document_approval_lines
      WHERE user_id=? AND status IN ('대기','예정')
    `).bind(id).first<{ count: number }>();
    if (Number(pending?.count || 0) > 0) {
      return json({ ok: false, message: `미처리 결재선 ${Number(pending?.count || 0)}건에 지정된 계정입니다. 결재선을 변경하거나 문서를 처리한 후 삭제해 주세요.` }, 409);
    }

    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM system_sessions WHERE user_id=?`).bind(id),
      env.DB.prepare(`DELETE FROM employee_profiles WHERE user_id=?`).bind(id),
      env.DB.prepare(`DELETE FROM system_users WHERE CAST(id AS TEXT)=?`).bind(id),
      env.DB.prepare(`
        INSERT INTO management_audit_logs
          (id,category,action,target_id,actor_user_id,actor_name,details_json,created_at)
        VALUES(?,?,?,?,?,?,?,?)
      `).bind(
        `MAL-${randomHex(24)}`, '계정관리', '계정삭제', id, auth.user.id, auth.user.name,
        JSON.stringify({ name: target.name, username: target.username, role: target.role }), now,
      ),
    ]);

    return json({ ok: true, message: `${target.name}(${target.username}) 계정을 삭제했습니다.` });
  } catch (error) {
    console.error('user delete failed', error);
    return json({ ok: false, message: '계정 삭제 중 오류가 발생했습니다.' }, 500);
  }
};

export const onRequestGet: PagesFunction = async () =>
  json({ ok: false, message: 'POST 방식으로 요청해 주세요.' }, 405);

