import {
  checkAuthRateLimit, clean, createSession, destroySession, getSessionToken, sessionCookie, ensureTables, json,
  normalizeDepartmentValue, normalizePositionValue, hashPassword, needsPasswordRehash, verifyPassword,
} from '../../_shared/helpers';
import { AuthSchemaError } from '../../_shared/security/sessions';
interface Env { DB: D1Database; }
type LoginPayload = { username?: string; password?: string };
// A process-local dummy hash equalizes password KDF work for unknown/inactive accounts.
let dummyHash: Promise<string> | undefined;
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB) return json({ ok: false, code: 'SERVICE_UNAVAILABLE' }, 503);
  let payload: LoginPayload;
  try { payload = await request.json(); }
  catch { return json({ ok: false, code: 'INVALID_JSON', message: '\uc694\uccad \ud615\uc2dd\uc744 \ud655\uc778\ud574 \uc8fc\uc138\uc694.' }, 400); }
  const username = clean(payload.username, 60);
  const password = typeof payload.password === 'string' ? payload.password : '';
  if (!username || !password || password.length > 200 || typeof payload.username !== 'string' || payload.username.trim().length > 60) {
    return json({ ok: false, code: 'INVALID_CREDENTIAL_INPUT', message: '\uc544\uc774\ub514\uc640 \ube44\ubc00\ubc88\ud638 \uc785\ub825\uc744 \ud655\uc778\ud574 \uc8fc\uc138\uc694.' }, 400);
  }
  try {
    await ensureTables(env.DB);
    const rate = await checkAuthRateLimit(env.DB, request, 'login', username);
    if (!rate.ok) return json({ ok: false, code: 'AUTH_RATE_LIMITED', message: rate.message }, 429, { 'Retry-After': String(rate.retryAfter) });
    const user = await env.DB.prepare(`SELECT CAST(id AS TEXT) AS id,name,username,password_hash,position,grade,department,role,can_approve,can_accounting,active
      FROM system_users WHERE username=? COLLATE NOCASE`).bind(username).first<{
        id: string; name: string; username: string; password_hash: string; position: string | null; grade: string | null;
        department: string | null; role: string; can_approve: number; can_accounting: number; active: number;
      }>();
    const candidateHash = user?.active === 1 ? user.password_hash : await (dummyHash ||= hashPassword(crypto.randomUUID()));
    const matches = await verifyPassword(password, candidateHash);
    if (!user || Number(user.active) !== 1 || !matches) return json({ ok: false, code: 'INVALID_CREDENTIALS',
      message: '\uc544\uc774\ub514 \ub610\ub294 \ube44\ubc00\ubc88\ud638\uac00 \uc62c\ubc14\ub974\uc9c0 \uc54a\uc2b5\ub2c8\ub2e4.' }, 401);
    let expectedHash = user.password_hash;
    if (needsPasswordRehash(expectedHash)) {
      try {
        const upgraded = await hashPassword(password);
        const update = await env.DB.prepare(`UPDATE system_users SET password_hash=? WHERE CAST(id AS TEXT)=? AND password_hash=? AND active=1`)
          .bind(upgraded, user.id, expectedHash).run();
        if (Number(update.meta?.changes) !== 1) return json({ ok: false, code: 'LOGIN_STATE_CHANGED', message: '\uacc4\uc815\uc774 \ubcc0\uacbd\ub418\uc5c8\uc2b5\ub2c8\ub2e4. \ub2e4\uc2dc \ub85c\uadf8\uc778\ud574 \uc8fc\uc138\uc694.' }, 409);
        expectedHash = upgraded;
      } catch (error) {
        console.error('password hash upgrade failed');
        throw error; // Never silently continue with a failed credential upgrade.
      }
    }
    const session = await createSession(env.DB, user.id, expectedHash);
    await destroySession(env.DB, getSessionToken(request)); // Replace only this browser's former login.
    const position = normalizePositionValue(user.position);
    return json({ ok: true, expiresAt: session.expiresAt, issuedAt: session.issuedAt,
      user: { id: user.id, name: user.name, username: user.username, position, grade: user.grade,
        department: normalizeDepartmentValue(user.department, position), role: user.role,
        canApprove: !!user.can_approve, canAccounting: user.role === 'admin' || !!user.can_accounting },
    }, 200, { 'Set-Cookie': sessionCookie(request, session.token, session.expiresAt) });
  } catch (error) {
    if (error instanceof AuthSchemaError) throw error;
    if (error && typeof error === 'object' && 'code' in error && error.code === 'LOGIN_STATE_CHANGED') return json({ ok: false, code: 'LOGIN_STATE_CHANGED', message: '\uacc4\uc815 \uc0c1\ud0dc\uac00 \ubcc0\uacbd\ub418\uc5c8\uc2b5\ub2c8\ub2e4. \ub2e4\uc2dc \uc2dc\ub3c4\ud574 \uc8fc\uc138\uc694.' }, 409);
    console.error('login failed', error instanceof Error ? error.message : 'unknown');
    return json({ ok: false, code: 'LOGIN_ERROR', message: '\ub85c\uadf8\uc778 \ucc98\ub9ac \uc911 \uc624\ub958\uac00 \ubc1c\uc0dd\ud588\uc2b5\ub2c8\ub2e4.' }, 500);
  }
};
export const onRequestGet: PagesFunction = async () => json({ ok: false, code: 'METHOD_NOT_ALLOWED' }, 405);
