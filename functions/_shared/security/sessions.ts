/** V97: credentials are HttpOnly, host-only cookies; D1 holds a one-way digest only. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const SESSION_COOKIE = '__Host-milgyo_session';
const DEV_COOKIE = 'milgyo_session_dev';
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const ready = new WeakSet<object>();
const pending = new WeakMap<object, Promise<void>>();
const prunedAt = new WeakMap<object, number>();

export class AuthSchemaError extends Error {
  readonly code = 'AUTH_SCHEMA_NOT_READY';
  readonly status = 503;
  constructor() { super('V97 authentication migration is required on the main DB.'); }
}

export async function ensureAuthSchema(db: D1Database): Promise<void> {
  if (ready.has(db)) return;
  let job = pending.get(db);
  if (!job) {
    job = (async () => {
      const row = await db.prepare(`SELECT COUNT(*) AS count FROM sqlite_master WHERE
        (type='table' AND name='auth_rate_buckets') OR
        (type='trigger' AND name IN ('trg_security_revoke_user_sessions','trg_security_delete_user_sessions'))`)
        .first<{ count: number }>();
      if (Number(row?.count) !== 3) throw new AuthSchemaError();
      ready.add(db);
    })().catch((error) => { pending.delete(db); throw error; });
    pending.set(db, job);
  }
  await job;
}

export type SessionUser = {
  id: string; name: string; username: string; position: string | null; grade: string | null;
  department: string | null; role: string; can_approve: number; can_accounting: number;
};
export type SessionResult = { ok: true; user: SessionUser; expiresAt: string; issuedAt: string } |
  { ok: false; message: string; status: number; code: string };

export function isLocalHttp(request: Request): boolean {
  const url = new URL(request.url);
  return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

export function getSessionToken(request: Request): string {
  // Never accept JSON, URL, Authorization or a sibling-domain cookie as a login credential.
  const name = isLocalHttp(request) ? DEV_COOKIE : SESSION_COOKIE;
  const matches = (request.headers.get('cookie') || '').split(';')
    .map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`));
  if (matches.length !== 1) return '';
  const value = matches[0].slice(name.length + 1);
  return TOKEN_PATTERN.test(value) ? value : '';
}

export function sessionCookie(request: Request, token: string, expiresAt?: string): string {
  const local = isLocalHttp(request);
  if (!local && new URL(request.url).protocol !== 'https:') throw new Error('HTTPS is required');
  if (token && !TOKEN_PATTERN.test(token)) throw new Error('Invalid session credential');
  const maxAge = token ? Math.max(0, Math.floor((Date.parse(expiresAt || '') - Date.now()) / 1000)) : 0;
  if (token && !Number.isFinite(maxAge)) throw new Error('Invalid session expiry');
  return `${local ? DEV_COOKIE : SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${local ? '' : '; Secure'}`;
}

async function sessionDigest(token: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return 'v2:' + Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function createSession(db: D1Database, userId: string, expectedPasswordHash?: string): Promise<{ token: string; expiresAt: string; issuedAt: string }> {
  await ensureAuthSchema(db);
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  const now = new Date();
  const issuedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
  if (now.getTime() - (prunedAt.get(db) || 0) >= 60 * 60 * 1000) {
    await db.prepare(`DELETE FROM system_sessions WHERE token IN (
      SELECT token FROM system_sessions WHERE expires_at < ? ORDER BY expires_at LIMIT 500
    )`).bind(issuedAt).run();
    prunedAt.set(db, now.getTime());
  }
  // A password reset/deactivation during password verification must not create a new old-credential session.
  const inserted = await db.prepare(`INSERT INTO system_sessions (token,user_id,created_at,expires_at)
    SELECT ?,CAST(id AS TEXT),?,? FROM system_users
    WHERE CAST(id AS TEXT)=? AND active=1 AND (? IS NULL OR password_hash=?)`)
    .bind(await sessionDigest(token), issuedAt, expiresAt, userId, expectedPasswordHash ?? null, expectedPasswordHash ?? null).run();
  if (Number(inserted.meta?.changes) !== 1) throw Object.assign(new Error('Account changed during login'), { status: 409, code: 'LOGIN_STATE_CHANGED' });
  return { token, expiresAt, issuedAt };
}

export async function destroySession(db: D1Database, token: string): Promise<void> {
  if (!TOKEN_PATTERN.test(token)) return;
  await db.prepare(`DELETE FROM system_sessions WHERE token=?`).bind(await sessionDigest(token)).run();
}

export async function authenticateSessionRecord(db: D1Database, token: string): Promise<SessionResult> {
  const invalid = (): SessionResult => ({ ok: false, status: 401, code: 'SESSION_EXPIRED',
    message: '\ub85c\uadf8\uc778\uc774 \ub9cc\ub8cc\ub418\uc5c8\uc2b5\ub2c8\ub2e4. \ub2e4\uc2dc \ub85c\uadf8\uc778\ud574 \uc8fc\uc138\uc694.' });
  if (!TOKEN_PATTERN.test(token)) return { ok: false, status: 401, code: 'SESSION_REQUIRED', message: '\ub85c\uadf8\uc778\uc774 \ud544\uc694\ud569\ub2c8\ub2e4.' };
  await ensureAuthSchema(db);
  const row = await db.prepare(`SELECT CAST(u.id AS TEXT) AS id,u.name,u.username,u.position,u.grade,u.department,u.role,
    u.can_approve,u.can_accounting,u.active,s.expires_at,s.created_at AS issued_at
    FROM system_sessions s JOIN system_users u ON CAST(u.id AS TEXT)=CAST(s.user_id AS TEXT) WHERE s.token=?`)
    .bind(await sessionDigest(token)).first<SessionUser & { active: number; expires_at: string; issued_at: string }>();
  if (!row) return invalid();
  const expiry = Date.parse(row.expires_at);
  const issued = Date.parse(row.issued_at);
  if (!Number.isFinite(expiry) || !Number.isFinite(issued) || expiry <= Date.now() || expiry <= issued || expiry - issued > SESSION_TTL_MS) {
    await destroySession(db, token);
    return invalid();
  }
  if (Number(row.active) !== 1) {
    await destroySession(db, token);
    return { ok: false, status: 401, code: 'ACCOUNT_DISABLED', message: '\ube44\ud65c\uc131\ud654\ub41c \uacc4\uc815\uc785\ub2c8\ub2e4. \uad00\ub9ac\uc790\uc5d0\uac8c \ubb38\uc758\ud574 \uc8fc\uc138\uc694.' };
  }
  const { id, name, username, position, grade, department, role, can_approve, can_accounting } = row;
  return { ok: true, user: { id, name, username, position, grade, department, role, can_approve, can_accounting }, expiresAt: row.expires_at, issuedAt: row.issued_at };
}
