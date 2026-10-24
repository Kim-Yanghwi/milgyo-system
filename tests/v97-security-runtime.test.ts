import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SQLiteD1, TestR2 } from './support/d1-sqlite.mjs';
import { createSession, authenticateSessionRecord, getSessionToken, sessionCookie, destroySession, AuthSchemaError, SESSION_TTL_MS } from '../functions/_shared/security/sessions';
import { reserveAuthAttempt } from '../functions/_shared/security/rate-limit';
import { readLimitedBody, validateJsonBody, assertSameOriginApiRequest, isProtectedSealPath, canonicalRequestPath } from '../functions/_shared/security/request';
import { decodeUploadBase64, inspectMainAttachment } from '../functions/_shared/security/attachments';
import { hashPassword, verifyPassword, ensureTables } from '../functions/_shared/helpers';
import { onRequest as middleware } from '../functions/_middleware';
import { onRequestPost as login } from '../functions/api/auth/login';
import { onRequestPost as session } from '../functions/api/auth/session';
import { onRequestPost as logout } from '../functions/api/auth/logout';
import { onRequestPost as bootstrap } from '../functions/api/auth/bootstrap';
import { onRequestPost as updateUser } from '../functions/api/users/update';
import { onRequestPost as uploadDocument } from '../functions/api/documents/upload-attachment';
import { onRequestPost as deleteDraft } from '../functions/api/documents/delete-draft';
import { onRequestPost as detail } from '../functions/api/documents/detail';
import { onRequestPost as attachmentData } from '../functions/api/documents/attachment-data';

const now = () => new Date().toISOString();
const office = '\uc0ac\ubb34\ucc98';
const draft = '\uc784\uc2dc\uc800\uc7a5';
const pending = '\uacb0\uc7ac\ub300\uae30';
const approved = '\uc2b9\uc778';
const password = 'test-Password-97!';
const base = 'https://system.example.test';
const credential = (token: string) => `__Host-milgyo_session=${token}`;
const request = (path: string, data: any = {}, token = '', headers = {}) => new Request(base + path, { method: 'POST', headers: {
  'Content-Type': 'application/json', 'X-Milgyo-Request': '1', Origin: base,
  ...(token ? { Cookie: credential(token) } : {}), ...headers,
}, body: JSON.stringify(data) });
const ctx = (db: any, req: Request, extra = {}) => ({ request: req, env: { DB: db, ...extra }, params: {}, data: {}, next: async () => new Response('next'), waitUntil() {}, passThroughOnException() {} });
const through = (db: any, handler: any, req: Request, extra = {}) => middleware({ ...ctx(db, req, extra), next: (nextReq = req) => handler(ctx(db, nextReq, extra)) } as any);
let hashPromise: Promise<string> | null = null;
async function user(db: any, id = 'u1', role = 'user') {
  const hash = await (hashPromise ||= hashPassword(password));
  await db.prepare(`INSERT INTO system_users(id,name,username,password_hash,department,role,active,can_approve,can_accounting,created_at) VALUES(?,?,?,?,?,?,1,?,?,?)`)
    .bind(id, 'Test User', id, hash, office, role, role === 'admin' ? 1 : 0, role === 'admin' ? 1 : 0, now()).run();
  return hash;
}
async function doc(db: any, id = 'doc1', owner = 'u1', status = draft) {
  await db.prepare(`INSERT INTO documents(id,doc_type,category,title,drafter,drafter_user_id,department,approval_track,status,access_scope,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(id, '\uae30\uc548', 'test', 'Test document', 'Test User', owner, office, '\uacb0\uc7ac', status, '\uc804\uccb4', now(), now()).run();
}
const uploadBody = (id = 'doc1') => ({ documentId: id, fileName: 'test.txt', mimeType: 'text/html', dataBase64: btoa('test file') });

test('new session: strong cookie, hashed D1 credential, absolute 12h lifetime, no legacy fallback', async () => {
  const db = new SQLiteD1();
  try {
    const hash = await user(db); const s = await createSession(db, 'u1', hash);
    assert.match(s.token, /^[0-9a-f]{64}$/);
    assert.equal(Date.parse(s.expiresAt) - Date.parse(s.issuedAt), SESSION_TTL_MS);
    const rows = (await db.prepare('SELECT * FROM system_sessions').all()).results;
    assert.equal(rows.length, 1); assert.match(rows[0].token, /^v2:[0-9a-f]{64}$/); assert.notEqual(rows[0].token, s.token);
    const cookie = sessionCookie(new Request(base), s.token, s.expiresAt);
    for (const flag of ['__Host-milgyo_session=', 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Secure', 'Max-Age=']) assert.ok(cookie.includes(flag));
    assert.ok(!cookie.includes('Domain='));
    assert.equal(getSessionToken(request('/api/test', { token: s.token })), '');
    assert.equal(getSessionToken(request('/api/test', {}, s.token)), s.token);
    assert.equal(getSessionToken(request('/api/test', {}, '', { Cookie: `${credential(s.token)}; ${credential(s.token)}` })), '');
    assert.equal(getSessionToken(request('/api/test', {}, '', { Authorization: `Bearer ${s.token}` })), '');
    assert.equal((await authenticateSessionRecord(db, s.token)).ok, true);
    assert.equal((await authenticateSessionRecord(db, 'a'.repeat(48))).ok, false);
  } finally { db.close(); }
});

test('localhost-only development cookie and explicit cookie clearing', () => {
  const token = 'a'.repeat(64), expiry = new Date(Date.now() + 10000).toISOString();
  const local = new Request('http://localhost:4321');
  assert.ok(sessionCookie(local, token, expiry).startsWith('milgyo_session_dev='));
  assert.ok(!sessionCookie(local, token, expiry).includes('; Secure'));
  assert.throws(() => sessionCookie(new Request('http://system.example.test'), token, expiry));
  assert.match(sessionCookie(new Request(base), ''), /Max-Age=0/);
  assert.throws(() => sessionCookie(new Request(base), token, 'not-a-date'));
});

for (const bad of ['bad-expiry', 'expired', 'too-long', 'reversed', 'bad-issued']) test(`session fails closed for ${bad}`, async () => {
  const db = new SQLiteD1(); try {
    await user(db); const s = await createSession(db, 'u1');
    let issued = Date.parse(s.issuedAt), expires = Date.parse(s.expiresAt);
    if (bad === 'expired') { issued -= SESSION_TTL_MS + 1000; expires = Date.now() - 1000; }
    if (bad === 'too-long') expires += 1;
    if (bad === 'reversed') expires = issued - 1;
    await db.prepare('UPDATE system_sessions SET created_at=?,expires_at=?').bind(bad === 'bad-issued' ? 'NaN' : new Date(issued).toISOString(), bad === 'bad-expiry' ? 'NaN' : new Date(expires).toISOString()).run();
    const result = await authenticateSessionRecord(db, s.token); assert.equal(result.ok, false); assert.equal((result as any).code, 'SESSION_EXPIRED');
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM system_sessions').first()).n, 0);
  } finally { db.close(); }
});

for (const mutation of ["password_hash='changed'", 'active=0', "role='admin'", 'can_approve=1', 'can_accounting=1']) test(`credential/privilege update atomically revokes sessions: ${mutation}`, async () => {
  const db = new SQLiteD1(); try {
    await user(db); const s1 = await createSession(db, 'u1'), s2 = await createSession(db, 'u1');
    await db.prepare(`UPDATE system_users SET ${mutation} WHERE id='u1'`).run();
    assert.equal((await authenticateSessionRecord(db, s1.token)).ok, false);
    assert.equal((await authenticateSessionRecord(db, s2.token)).ok, false);
  } finally { db.close(); }
});

test('profile refresh does not extend expiry; deletion revokes; password-reset race denies insertion', async () => {
  const db = new SQLiteD1(); try {
    const hash = await user(db); const s = await createSession(db, 'u1', hash);
    await db.prepare("UPDATE system_users SET name='Changed',department='Other' WHERE id='u1'").run();
    const r = await authenticateSessionRecord(db, s.token); assert.equal(r.ok, true); assert.equal((r as any).expiresAt, s.expiresAt); assert.equal((r as any).user.name, 'Changed');
    await db.prepare("UPDATE system_users SET password_hash='new' WHERE id='u1'").run();
    await assert.rejects(createSession(db, 'u1', hash), e => (e as any).code === 'LOGIN_STATE_CHANGED');
    const fresh = await createSession(db, 'u1'); await db.prepare("DELETE FROM system_users WHERE id='u1'").run();
    assert.equal((await authenticateSessionRecord(db, fresh.token)).ok, false);
  } finally { db.close(); }
});

test('auth schema is checked per binding and the new migration is idempotent/data preserving', async () => {
  const one = new SQLiteD1(), two = new SQLiteD1({ auth: false }); try {
    await user(one); await user(two); await createSession(one, 'u1');
    await assert.rejects(createSession(two, 'u1'), AuthSchemaError);
    const sql = readFileSync('migrations/main/0012_v97_security_sessions.sql', 'utf8');
    const before = two.sqlite.prepare('SELECT * FROM system_users').all(); two.sqlite.exec(sql); two.sqlite.exec(sql);
    assert.deepEqual(two.sqlite.prepare('SELECT * FROM system_users').all(), before);
    assert.ok((await createSession(two, 'u1')).token);
    await ensureTables(one); await ensureTables(two);
    assert.ok(two.sqlite.prepare('SELECT COUNT(*) AS n FROM document_templates').get().n > 0);
  } finally { one.close(); two.close(); }
});

test('password input/hash format bounds and legacy SHA256 verification', async () => {
  const hash = await (hashPromise ||= hashPassword(password));
  assert.equal(await verifyPassword(password, hash), true);
  assert.equal(await verifyPassword(password + 'wrong', hash), false);
  for (const bad of ['pbkdf2$100000$%%%$bad', 'pbkdf2$100001$AAAA$AAAA', 'sha256$x$bad', hash + '$extra']) assert.equal(await verifyPassword(password, bad), false);
});

test('atomic rate reservation: concurrent bootstrap attempts limited, untrusted XFF ignored', async () => {
  const db = new SQLiteD1(); try {
    const results = await Promise.all(Array.from({ length: 25 }, (_, i) => reserveAuthAttempt(db, request('/api/auth/bootstrap', {}, '', { 'CF-Connecting-IP': '192.0.2.1', 'X-Forwarded-For': `10.0.0.${i}` }), 'bootstrap')));
    assert.equal(results.filter(r => r.ok).length, 5);
    assert.ok(results.filter(r => !r.ok).every(r => (r as any).retryAfter > 0));
    assert.ok((await db.prepare('SELECT bucket_key FROM auth_rate_buckets').all()).results.every(r => /^[0-9a-f]{64}$/.test(r.bucket_key)));
  } finally { db.close(); }
});

test('account-specific limits work across IPs; success does not erase attempts', async () => {
  const db = new SQLiteD1(); try {
    const results = await Promise.all(Array.from({ length: 35 }, (_, i) => reserveAuthAttempt(db, request('/api/auth/login', {}, '', { 'CF-Connecting-IP': `192.0.2.${i}` }), 'login', i % 2 ? 'USER' : 'user')));
    assert.equal(results.filter(r => r.ok).length, 20);
  } finally { db.close(); }
});

for (const headers of [{ Origin: 'https://evil.test' }, { Origin: 'https://www.example.test' }, { Origin: 'null' }, { 'Sec-Fetch-Site': 'same-site' }, { 'X-Milgyo-Request': '0' }]) test(`CSRF/header guard rejects ${JSON.stringify(headers)}`, () => {
  assert.throws(() => assertSameOriginApiRequest(request('/api/test', {}, '', headers)));
});
test('CSRF header permits same-origin and script client but not insecure production HTTP', () => {
  assert.doesNotThrow(() => assertSameOriginApiRequest(request('/api/test')));
  assert.doesNotThrow(() => assertSameOriginApiRequest(new Request(base, { headers: { 'X-Milgyo-Request': '1' } })));
  assert.throws(() => assertSameOriginApiRequest(new Request('http://system.example.test', { headers: { 'X-Milgyo-Request': '1' } })));
});

test('actual byte limit works for missing/false Content-Length and compressed requests', async () => {
  for (const headers of [{}, { 'Content-Length': '1' }]) {
    const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(6)); c.enqueue(new Uint8Array(5)); c.close(); } });
    const req = new Request(base, { method: 'POST', headers, body: stream, duplex: 'half' } as any);
    await assert.rejects(readLimitedBody(req, 10), e => (e as any).status === 413);
  }
  for (const headers of [{ 'Content-Length': 'no' }, { 'Content-Length': '100' }, { 'Content-Encoding': 'gzip' }]) {
    await assert.rejects(readLimitedBody(new Request(base, { method: 'POST', headers, body: '{}' }), 10));
  }
  assert.equal((await readLimitedBody(new Request(base, { method: 'POST', body: '{}' }), 10)).length, 2);
});

test('invalid top-level JSON and invalid UTF8 fail before business handlers', () => {
  for (const value of ['null', '[]', '5', '"text"', '', '{']) assert.throws(() => validateJsonBody(new TextEncoder().encode(value)));
  assert.throws(() => validateJsonBody(new Uint8Array([0xff, 0xfe])));
  assert.doesNotThrow(() => validateJsonBody(new TextEncoder().encode('{"nested":[]}')));
});

test('encoded API aliases cannot bypass middleware, protected seal aliases identified', async () => {
  assert.equal(canonicalRequestPath('/%61pi/auth/login'), '/api/auth/login');
  for (const path of ['/secretary_general.png', '/%73ecretary_general.png', '/chongmuwonjang_seal.png', '/%63hongmuwonjang_seal.png', '/signature-seals/test.png', '/certificates/ordination/top-seal.png']) assert.equal(isProtectedSealPath(path), true);
  for (const path of ['/logo.png', '/', '/system-session.js']) assert.equal(isProtectedSealPath(path), false);
  const r = await middleware({ ...ctx(null, request('/%61pi/auth/login')), next: () => { throw new Error('must not reach handler'); } } as any);
  assert.equal(r.status, 400); assert.equal((await r.json()).code, 'INVALID_API_PATH');
});

test('middleware enforces JSON shape, credentials, method and returns no-store security headers', async () => {
  const cases = [
    [request('/api/documents/list', { token: 'a'.repeat(64) }), 401],
    [request('/api/auth/login', null), 400],
    [new Request(base + '/api/auth/login', { method: 'OPTIONS' }), 405],
    [new Request(base + '/api/auth/login', { method: 'POST', headers: { 'X-Milgyo-Request': '1', 'Content-Type': 'text/plain' }, body: '{}' }), 415],
  ] as const;
  for (const [req, status] of cases) {
    const response = await middleware({ ...ctx(null, req), next: () => { throw new Error('not reached'); } } as any);
    assert.equal(response.status, status); assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff'); assert.ok(response.headers.get('X-Request-ID'));
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
  }
});

test('middleware forwards a bounded body and sanitizes server errors', async () => {
  const req = request('/api/auth/login', { username: 'x' });
  const response = await middleware({ ...ctx(null, req), next: async (forwarded: Request) => {
    assert.deepEqual(await forwarded.json(), { username: 'x' });
    return Response.json({ ok: false, message: 'SQLITE_SECRET_TABLE' }, { status: 500, headers: { 'Access-Control-Allow-Origin': '*' } });
  } } as any);
  assert.equal(response.status, 500); assert.ok(!(await response.text()).includes('SQLITE_SECRET_TABLE'));
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
});

test('protected seal requires valid login; valid image response is private and original bytes unchanged', async () => {
  const db = new SQLiteD1(); try {
    await user(db); const s = await createSession(db, 'u1');
    const bytes = new Uint8Array([137, 80, 78, 71]);
    for (const asset of ['/secretary_general.png', '/chongmuwonjang_seal.png']) {
      const req = new Request(base + asset);
      const denied = await middleware({ ...ctx(db, req), next: () => { throw new Error('not reached'); } } as any);
      assert.equal(denied.status, 401, `${asset} must require login`);
      const response = await middleware({ ...ctx(db, new Request(req.url, { headers: { Cookie: credential(s.token) } })), next: async () => new Response(bytes, { headers: { 'Content-Type': 'image/png' } }) } as any);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
      assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
    }
  } finally { db.close(); }
});

test('login -> session -> logout end-to-end through middleware uses cookies, never JSON tokens', async () => {
  const db = new SQLiteD1(); try {
    await user(db);
    const response = await through(db, login, request('/api/auth/login', { username: 'u1', password }));
    assert.equal(response.status, 200);
    const body: any = await response.json(); assert.equal(body.ok, true); assert.equal(body.token, undefined);
    const raw = response.headers.get('Set-Cookie')!.match(/^[^=]+=([^;]+)/)![1];
    assert.ok(raw && !JSON.stringify(body).includes(raw));
    const check = await through(db, session, request('/api/auth/session', {}, raw));
    const checked: any = await check.json(); assert.equal(checked.expiresAt, body.expiresAt); assert.equal(checked.issuedAt, body.issuedAt);
    const out = await through(db, logout, request('/api/auth/logout', {}, raw)); assert.equal(out.status, 200); assert.match(out.headers.get('Set-Cookie') || '', /Max-Age=0/);
    const ended = await through(db, session, request('/api/auth/session', {}, raw)); assert.equal(ended.status, 401); assert.equal((await ended.json()).code, 'SESSION_EXPIRED');
  } finally { db.close(); }
});

test('invalid password is distinct from session expiry; oversized password is not truncated', async () => {
  const db = new SQLiteD1(); try {
    await user(db); const s = await createSession(db, 'u1');
    const bad = await through(db, login, request('/api/auth/login', { username: 'u1', password: 'incorrect' }, s.token));
    assert.equal(bad.status, 401); assert.equal((await bad.json()).code, 'INVALID_CREDENTIALS');
    assert.equal((await authenticateSessionRecord(db, s.token)).ok, true);
    const long = await through(db, login, request('/api/auth/login', { username: 'u1', password: 'x'.repeat(201) })); assert.equal(long.status, 400);
  } finally { db.close(); }
});

test('login fails closed with clear migration error; bootstrap recovery is disabled by default', async () => {
  const db = new SQLiteD1({ auth: false }); try {
    await user(db); const response = await through(db, login, request('/api/auth/login', { username: 'u1', password }));
    assert.equal(response.status, 503); assert.equal((await response.json()).code, 'AUTH_SCHEMA_NOT_READY');
    const recovery = await through(db, bootstrap, request('/api/auth/bootstrap', { token: 'anything' }), { ADMIN_TOKEN: 'x'.repeat(64) });
    assert.equal(recovery.status, 403);
  } finally { db.close(); }
});

test('admin password/profile update commits atomically and revokes target sessions only', async () => {
  const db = new SQLiteD1(); try {
    await user(db, 'admin', 'admin'); await user(db, 'u1');
    const admin = await createSession(db, 'admin'), s = await createSession(db, 'u1');
    const response = await through(db, updateUser, request('/api/users/update', { id: 'u1', name: 'Changed', department: office, role: 'user', newPassword: 'Replacement-password', active: true }, admin.token));
    assert.equal(response.status, 200); assert.equal((await response.json()).ok, true);
    assert.equal((await authenticateSessionRecord(db, s.token)).ok, false); assert.equal((await authenticateSessionRecord(db, admin.token)).ok, true);
    const row = await db.prepare("SELECT * FROM system_users WHERE id='u1'").first(); assert.equal(row.name, 'Changed'); assert.equal(await verifyPassword('Replacement-password', row.password_hash), true);
    const last = await through(db, updateUser, request('/api/users/update', { id: 'admin', name: 'Admin', role: 'user' }, admin.token)); assert.equal(last.status, 400);
  } finally { db.close(); }
});

test('main attachment allowlist checks signature/name/base64 and uses canonical MIME', () => {
  const text = new TextEncoder().encode('safe text');
  assert.deepEqual(inspectMainAttachment('a.txt', text), { ok: true, mimeType: 'text/plain' });
  assert.equal(inspectMainAttachment('a.pdf', text).ok, false);
  assert.equal(inspectMainAttachment('a.html', text).ok, false);
  assert.equal(inspectMainAttachment('a.exe', text).ok, false);
  assert.equal(inspectMainAttachment('a\u202e.txt', text).ok, false);
  assert.equal(inspectMainAttachment('../a.txt', text).ok, false);
  assert.equal(inspectMainAttachment('a.txt', new Uint8Array([0])).ok, false);
  assert.equal(inspectMainAttachment('a.png', new Uint8Array([137,80,78,71,13,10,26,10])).ok, true);
  assert.equal(inspectMainAttachment('a.hwpx', new Uint8Array([80,75,3,4])).ok, true);
  for (const bad of ['', 'bad====', 'data:;base64,YQ==', 'a'.repeat(1024)]) assert.equal(decodeUploadBase64(bad, 10), null);
  assert.deepEqual(decodeUploadBase64('YQ=='), new Uint8Array([97]));
});

test('concurrent pending-document attachment inserts stop at 10 and canonicalize MIME', async () => {
  const db = new SQLiteD1(); try {
    await user(db); await ensureTables(db); await doc(db, 'doc1', 'u1', pending);
    const s = await createSession(db, 'u1');
    const results = await Promise.all(Array.from({ length: 17 }, () => through(db, uploadDocument, request('/api/documents/upload-attachment', uploadBody(), s.token))));
    assert.equal(results.filter(r => r.status === 200).length, 10);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM document_attachments').first()).n, 10);
    assert.equal((await db.prepare('SELECT DISTINCT mime_type FROM document_attachments').first()).mime_type, 'text/plain');
  } finally { db.close(); }
});

for (const state of ['approved', 'reviewed', 'locked']) test(`post-review/state-conflict attachment denied and R2 object cleaned: ${state}`, async () => {
  const db = new SQLiteD1(), files = new TestR2(); try {
    await user(db); await ensureTables(db); await doc(db, 'doc1', 'u1', state === 'approved' ? approved : pending);
    if (state === 'reviewed') await db.prepare(`INSERT INTO document_approval_lines(id,document_id,line_order,line_type,user_id,user_name,status,acted_at,created_at) VALUES('l','doc1',1,'review','u2','Reviewer',?,?,?)`).bind('\uc644\ub8cc', now(), now()).run();
    if (state === 'locked') await db.prepare("INSERT INTO document_transition_locks VALUES('doc1','lock',?)").bind(now()).run();
    const s = await createSession(db, 'u1'); const response = await through(db, uploadDocument, request('/api/documents/upload-attachment', uploadBody(), s.token), { FILES: files });
    assert.equal(response.status, 409); assert.equal(files.objects.size, 0); assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM document_attachments').first()).n, 0);
  } finally { db.close(); }
});

test('recalled draft is not disclosed to a former reviewer via detail or attachment fallback', async () => {
  const db = new SQLiteD1(); try {
    await user(db); await user(db, 'u2'); await ensureTables(db); await doc(db);
    await db.prepare("INSERT INTO document_approval_lines(id,document_id,line_order,line_type,user_id,user_name,status,created_at) VALUES('l','doc1',1,'review','u2','Reviewer','old',?)").bind(now()).run();
    await db.prepare("INSERT INTO document_attachments(id,document_id,file_name,mime_type,data_base64,created_at) VALUES('a','doc1','a.txt','text/plain','YQ==',?)").bind(now()).run();
    const s = await createSession(db, 'u2');
    const r1 = await through(db, detail, request('/api/documents/detail', { id: 'doc1' }, s.token)); assert.equal(r1.status, 403);
    const r2 = await through(db, attachmentData, request('/api/documents/attachment-data', { attachmentId: 'a' }, s.token)); assert.equal(r2.status, 403);
  } finally { db.close(); }
});

test('draft deletion loses a submit race without deleting children or R2 data', async () => {
  const db = new SQLiteD1(), files = new TestR2(); try {
    await user(db); await ensureTables(db); await doc(db);
    await db.prepare("INSERT INTO document_attachments(id,document_id,file_name,storage_type,r2_key,created_at) VALUES('a','doc1','a.txt','r2','documents/doc1/a',?)").bind(now()).run();
    const s = await createSession(db, 'u1');
    db.beforeBatch = (statements: any[]) => { if (statements.some(x => /DELETE FROM documents/.test(x.sql))) { db.beforeBatch = null; db.sqlite.prepare('UPDATE documents SET status=? WHERE id=?').run(pending, 'doc1'); } };
    const response = await through(db, deleteDraft, request('/api/documents/delete-draft', { id: 'doc1' }, s.token), { FILES: files });
    assert.equal(response.status, 409); assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM document_attachments').first()).n, 1); assert.equal(files.deleted.length, 0);
    assert.equal((await db.prepare("SELECT status FROM documents WHERE id='doc1'").first()).status, pending);
  } finally { db.close(); }
});

test('normal draft deletion removes only the draft and its attachment objects', async () => {
  const db = new SQLiteD1(), files = new TestR2(); try {
    await user(db); await ensureTables(db); await doc(db); await doc(db, 'other');
    await db.prepare("INSERT INTO document_attachments(id,document_id,file_name,storage_type,r2_key,created_at) VALUES('a','doc1','a.txt','r2','documents/doc1/a',?)").bind(now()).run();
    const s = await createSession(db, 'u1'); const response = await through(db, deleteDraft, request('/api/documents/delete-draft', { id: 'doc1' }, s.token), { FILES: files });
    assert.equal(response.status, 200); assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM documents').first()).n, 1); assert.deepEqual(files.deleted, ['documents/doc1/a']);
  } finally { db.close(); }
});

test('received attachments enforce owner and maximum count atomically', async () => {
  const { onRequestPost: uploadReceived } = await import('../functions/api/received/upload-attachment');
  const db = new SQLiteD1(); try {
    await user(db); await user(db,'u2'); await ensureTables(db);
    await db.prepare(`INSERT INTO received_documents(id,direction,title,counterparty,handled_by,handled_by_user_id,received_at,created_at,updated_at) VALUES('r','in','Test','Sender','Test','u1',?,?,?)`).bind(now(),now(),now()).run();
    const s = await createSession(db,'u1'), other=await createSession(db,'u2');
    const data={receivedDocumentId:'r',fileName:'a.txt',dataBase64:'YQ=='};
    const denied=await through(db,uploadReceived,request('/api/received/upload-attachment',data,other.token));assert.equal(denied.status,403);
    const results=await Promise.all(Array.from({length:14},()=>through(db,uploadReceived,request('/api/received/upload-attachment',data,s.token))));
    assert.equal(results.filter(r=>r.status===200).length,10);assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM received_attachments').first()).n,10);
  } finally {db.close();}
});

test('register metadata and audit commit atomically; rollback removes the newly uploaded R2 object', async()=>{
  const {onRequestPost:uploadRegister}=await import('../functions/api/registers/upload-attachment');
  const db=new SQLiteD1(),files=new TestR2();try{
    await user(db);await ensureTables(db);
    await db.prepare(`INSERT INTO management_registers(id,request_no,record_type,title,applicant_user_id,applicant_name,request_date,created_at,updated_at) VALUES('r','n','test','Test','u1','Test',?,?,?)`).bind(now(),now(),now()).run();
    const s=await createSession(db,'u1');const data={registerId:'r',fileName:'a.txt',dataBase64:'YQ=='};
    const ok=await through(db,uploadRegister,request('/api/registers/upload-attachment',data,s.token),{FILES:files});assert.equal(ok.status,200);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM management_audit_logs').first()).n,1);
    db.sqlite.exec(`CREATE TRIGGER test_fail_audit BEFORE INSERT ON management_audit_logs BEGIN SELECT RAISE(ABORT,'test rollback'); END;`);
    const failed=await through(db,uploadRegister,request('/api/registers/upload-attachment',data,s.token),{FILES:files});assert.equal(failed.status,500);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM management_register_attachments').first()).n,1);
    assert.equal(files.objects.size,1);assert.equal(files.deleted.length,1);
  }finally{db.close();}
});

test('register status changes during upload are rejected and cleaned',async()=>{
  const {onRequestPost:uploadRegister}=await import('../functions/api/registers/upload-attachment');
  const db=new SQLiteD1(),files=new TestR2();try{
    await user(db);await ensureTables(db);
    await db.prepare(`INSERT INTO management_registers(id,request_no,record_type,title,applicant_user_id,applicant_name,request_date,created_at,updated_at) VALUES('r','n','test','Test','u1','Test',?,?,?)`).bind(now(),now(),now()).run();
    const s=await createSession(db,'u1');
    db.beforeBatch=(statements:any[])=>{if(statements.some(s=>/INSERT INTO management_register_attachments/.test(s.sql))){db.beforeBatch=null;db.sqlite.prepare('UPDATE management_registers SET status=? WHERE id=?').run('\uc644\ub8cc','r');}};
    const r=await through(db,uploadRegister,request('/api/registers/upload-attachment',{registerId:'r',fileName:'a.txt',dataBase64:'YQ=='},s.token),{FILES:files});
    assert.equal(r.status,409);assert.equal(files.objects.size,0);assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM management_audit_logs').first()).n,0);
  }finally{db.close();}
});

test('accounting multipart duplicate fields fail before authentication/business writes',async()=>{
  const {onRequestPost:upload}=await import('../functions/api/accounting/upload-attachment');
  const form=new FormData();form.append('file',new Blob(['a']),'a.txt');form.append('file',new Blob(['b']),'b.txt');
  const req=new Request(base+'/api/accounting/upload-attachment',{method:'POST',body:form});
  const result=await upload({request:req,env:{DB:{},ACCOUNTING_DB:{},ACCOUNTING_FILES:{}}} as any);
  assert.equal(result.status,400);assert.equal((await result.json()).code,'DUPLICATE_FORM_FIELD');
});

test('accounting attachment count/bytes quota is atomic with R2 compensation and canonical MIME',async()=>{
  const {onRequestPost:upload}=await import('../functions/api/accounting/upload-attachment');
  const {readdirSync}=await import('node:fs');
  const db=new SQLiteD1(),accounting=new SQLiteD1({migrate:false}),files=new TestR2();
  try{
    for(const file of readdirSync('migrations/accounting').filter(f=>f.endsWith('.sql')).sort())accounting.sqlite.exec(readFileSync('migrations/accounting/'+file,'utf8'));
    const {ensureAccountingTables}=await import('../functions/_shared/accounting');await ensureAccountingTables(accounting as any);
    await user(db,'admin','admin');await ensureTables(db);const s=await createSession(db,'admin');
    // A bank account is an existing accounting reference with manager-only write access.
    const fields=accounting.sqlite.prepare('PRAGMA table_info(accounting_bank_accounts)').all();
    const required:any={id:'bank1',account_code:'TEST-BANK',account_alias:'Test account',bank_name:'Test bank',account_name:'Test account',account_number:'test-only',account_type:'ordinary',currency:'KRW',created_at:now(),updated_at:now(),active:1,is_active:1};
    const cols=fields.filter((f:any)=>f.name==='id'||required[f.name]!==undefined).map((f:any)=>f.name);
    accounting.sqlite.prepare(`INSERT INTO accounting_bank_accounts(${cols.join(',')}) VALUES(${cols.map(()=>'?').join(',')})`).run(...cols.map((c:any)=>required[c]));
    const body={referenceType:'bank_account',referenceId:'bank1',fileName:'a.txt',mimeType:'text/html',dataBase64:'YQ=='};
    const results=await Promise.all(Array.from({length:14},()=>through(db,upload,request('/api/accounting/upload-attachment',body,s.token),{ACCOUNTING_DB:accounting,ACCOUNTING_FILES:files})));
    assert.equal(results.filter(r=>r.status===200).length,10);assert.equal(files.objects.size,10);
    const saved=await accounting.prepare('SELECT COUNT(*) AS n,MIN(content_type) AS mime FROM accounting_attachments').first();assert.equal(saved.n,10);assert.equal(saved.mime,'text/plain');
  }finally{db.close();accounting.close();}
});
