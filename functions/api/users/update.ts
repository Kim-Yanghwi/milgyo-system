import {
  authenticateSession, getSessionToken,
  clean,
  ensureTables,
  hashPassword,
  json,
  normalizeDepartmentValue,
  normalizePositionValue,
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
  personnelNo?: string;
  department?: string;
  role?: string;
  canApprove?: boolean;
  canAccounting?: boolean;
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
    const auth = await authenticateSession(env.DB, getSessionToken(request));
    if (!auth.ok) return json({ ok: false, code: auth.code, message: auth.message }, auth.status);
    if (auth.user.role !== 'admin') return json({ ok: false, message: '계정 관리는 관리자만 할 수 있습니다.' }, 403);

    const id = clean(payload.id, 60);
    if (!id) return json({ ok: false, message: '계정 정보가 필요합니다.' }, 400);

    const target = await env.DB.prepare(`
      SELECT CAST(id AS TEXT) AS id, role, active
      FROM system_users WHERE CAST(id AS TEXT) = ?
    `).bind(id).first<{ id: string; role: string; active: number }>();
    if (!target) return json({ ok: false, message: '해당 계정을 찾을 수 없습니다.' }, 404);

    const name = clean(payload.name, 40);
    const position = normalizePositionValue(payload.position);
    const grade = payload.grade === undefined ? null : clean(payload.grade, 20);
    const personnelNo = typeof payload.personnelNo === 'string' ? payload.personnelNo.trim() : '';
    if (personnelNo && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(personnelNo))
      return json({ ok: false, message: '사번(승적번호)은 영문·숫자·하이픈·밑줄을 포함한 40자 이하로 입력해 주세요.' }, 400);
    const department = normalizeDepartmentValue(payload.department, position) || (position === '사무국장' ? '사무처 - 사무국' : '');
    const role = payload.role === 'admin' ? 'admin' : payload.role === 'audit' ? 'audit' : 'user';
    const canApprove = !!payload.canApprove || role === 'admin';
    const canAccounting = !!payload.canAccounting || role === 'admin';
    const active = payload.active === undefined ? true : !!payload.active;
    const newPassword = typeof payload.newPassword === 'string' ? payload.newPassword : '';
    if (newPassword.length > 200) return json({ ok: false, code: 'PASSWORD_TOO_LONG', message: '\ube44\ubc00\ubc88\ud638\ub294 200\uc790 \uc774\ud558\ub85c \uc785\ub825\ud574 \uc8fc\uc138\uc694.' }, 400);

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

    try { await env.DB.prepare('SELECT personnel_no FROM system_users LIMIT 1').all(); }
    catch { return json({ ok: false, message: '계정 DB 0015 마이그레이션 적용 후 이용해 주세요.' }, 409); }
    if (personnelNo) {
      const exists=await env.DB.prepare('SELECT id FROM system_users WHERE personnel_no=? COLLATE NOCASE AND CAST(id AS TEXT)<>? LIMIT 1').bind(personnelNo,id).first();
      if (exists) return json({ ok: false, message: '이미 등록된 사번(승적번호)입니다.' }, 409);
    }
    const passwordHash = newPassword ? await hashPassword(newPassword) : null;
    const updateResult=await env.DB.prepare(`
      UPDATE system_users SET name=?,position=?,grade=CASE WHEN ?=1 THEN ? ELSE grade END,personnel_no=?,department=?,role=?,can_approve=?,can_accounting=?,active=?,password_hash=COALESCE(?,password_hash)
      WHERE CAST(id AS TEXT)=? AND NOT (role='admin' AND active=1 AND (?<>'admin' OR ?=0)
        AND NOT EXISTS(SELECT 1 FROM system_users other WHERE other.role='admin' AND other.active=1 AND CAST(other.id AS TEXT)<>CAST(system_users.id AS TEXT)))
    `).bind(name,position||null,payload.grade===undefined?0:1,grade,personnelNo,department||null,role,canApprove?1:0,canAccounting?1:0,active?1:0,passwordHash,id,role,active?1:0).run();
    if(Number(updateResult.meta?.changes||0)!==1)return json({ok:false,message:'동시 변경으로 인해 마지막 활성 관리자 계정을 보호했습니다. 계정 목록을 새로고침해 주세요.'},409);


    return json({ ok: true, message: '계정 정보가 수정되었습니다.' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/unique constraint failed: system_users\.personnel_no|idx_system_users_personnel_no/i.test(message))
      return json({ ok: false, message: '이미 등록된 사번(승적번호)입니다.' }, 409);
    console.error('user update failed', error);
    return json({ ok: false, message: '계정 수정 중 오류가 발생했습니다.' }, 500);
  }
};

export const onRequestGet: PagesFunction = async () =>
  json({ ok: false, message: 'POST 방식으로 요청해 주세요.' }, 405);
