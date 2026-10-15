import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SQLiteD1 } from './support/d1-sqlite.mjs';
import { hashPassword, ensureTables } from '../functions/_shared/helpers';
import { createSession, authenticateSessionRecord, ensureAuthSchema, AuthSchemaError } from '../functions/_shared/security/sessions';
import { onRequest as middleware } from '../functions/_middleware';
import { onRequestPost as login } from '../functions/api/auth/login';
import { onRequestPost as session } from '../functions/api/auth/session';
import { onRequestPost as bootstrap } from '../functions/api/auth/bootstrap';

const repair = readFileSync('database/AUTH_REPAIR_MAIN_20261015.sql', 'utf8');
const diagnose = readFileSync('database/AUTH_DIAGNOSE_MAIN_20261015.sql', 'utf8');
const migration = readFileSync('migrations/main/0012_v97_security_sessions.sql', 'utf8');
const origin = 'https://system.example.test';
const password = 'Existing-Test-Password-99!';
let passwordHash: Promise<string>;
const req = (path: string, data: object, cookie = '') => new Request(origin + path, {
  method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Milgyo-Request': '1',
    ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(data),
});
const through = (db: any, handler: any, request: Request, extra = {}) => {
  const context = (r: Request) => ({ request: r, env: { DB: db, ...extra }, params: {}, data: {},
    next: async () => new Response('unused'), waitUntil() {}, passThroughOnException() {} });
  return middleware({ ...context(request), next: (forwarded = request) => handler(context(forwarded)) } as any);
};
async function seed(db: any) {
  await ensureTables(db);
  const hash = await (passwordHash ||= hashPassword(password));
  await db.prepare(`INSERT INTO system_users(id,name,username,password_hash,role,active,can_approve,can_accounting,created_at)
    VALUES('existing-user','Existing User','existing-user',?,'admin',1,1,1,?)`).bind(hash, new Date().toISOString()).run();
  await db.prepare(`INSERT INTO documents(id,doc_type,category,title,drafter,drafter_user_id,department,approval_track,status,access_scope,created_at,updated_at)
    VALUES('keep-document','test','test','Preserve this document','Existing User','existing-user','office','test','draft','all',?,?)`)
    .bind(new Date().toISOString(), new Date().toISOString()).run();
  await db.prepare(`INSERT INTO system_sessions(token,user_id,created_at,expires_at) VALUES('legacy-session','existing-user',?,?)`)
    .bind(new Date().toISOString(), new Date(Date.now() + 60_000).toISOString()).run();
}
function snapshot(db: any) {
  return Object.fromEntries(db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map((row: any) => [row.name, db.sqlite.prepare(`SELECT * FROM "${row.name.replaceAll('"', '""')}"`).all()]));
}
const objects = (db: any) => db.sqlite.prepare(diagnose.slice(0, diagnose.indexOf('-- These PRAGMAs'))).all();

test('V99: supplied repair contains the unchanged original V97 migration', () => {
  assert.ok(repair.endsWith(migration));
  assert.ok(!/DROP\s+(?:TABLE|TRIGGER)|ALTER\s+TABLE|UPDATE\s+system_users|INSERT\s+INTO\s+system_users/i.test(repair));
});

test('V99: bound pre-V97 main database reproduces AUTH_SCHEMA_NOT_READY on login', async () => {
  const db = new SQLiteD1({ auth: false });
  try {
    await seed(db);
    const result = await through(db, login, req('/api/auth/login', { username: 'existing-user', password }));
    assert.equal(result.status, 503);
    const body = await result.json();
    assert.equal(body.code, 'AUTH_SCHEMA_NOT_READY');
    assert.ok(body.requestId);
    assert.ok(!JSON.stringify(body).includes(password));
    assert.equal(objects(db).filter((r: any) => r.status === 'MISSING').length, 4);
  } finally { db.close(); }
});

test('V99: diagnostic is read-only on both pre-migration and ready databases', async () => {
  for (const auth of [false, true]) {
    const db = new SQLiteD1({ auth });
    try {
      await seed(db); const before = snapshot(db);
      const beforeSchema = db.sqlite.prepare('SELECT * FROM sqlite_master ORDER BY name').all();
      db.sqlite.exec(diagnose);
      assert.deepEqual(snapshot(db), before);
      assert.deepEqual(db.sqlite.prepare('SELECT * FROM sqlite_master ORDER BY name').all(), beforeSchema);
    } finally { db.close(); }
  }
});

test('V99: applying repair twice preserves every pre-existing table row', async () => {
  const db = new SQLiteD1({ auth: false });
  try {
    await seed(db); const before = snapshot(db);
    db.sqlite.exec(repair); db.sqlite.exec(repair);
    const after = snapshot(db);
    for (const [name, rows] of Object.entries(before)) assert.deepEqual(after[name], rows, `changed existing rows: ${name}`);
    assert.deepEqual(after.auth_rate_buckets, []);
    assert.equal(objects(db).length, 6);
    assert.ok(objects(db).every((r: any) => r.status === 'OK'));
    await ensureAuthSchema(db);
  } finally { db.close(); }
});

test('V99: repair restores existing-account login and cookie session without a new admin', async () => {
  const db = new SQLiteD1({ auth: false });
  try {
    await seed(db);
    const failed = await through(db, login, req('/api/auth/login', { username: 'existing-user', password }));
    assert.equal(failed.status, 503);
    db.sqlite.exec(repair);
    // Same D1 object: a failed readiness check must not be cached forever.
    const result = await through(db, login, req('/api/auth/login', { username: 'existing-user', password }));
    assert.equal(result.status, 200);
    const data = await result.json(); assert.equal(data.ok, true); assert.equal(data.user.id, 'existing-user');
    assert.equal(data.token, undefined);
    const cookie = result.headers.get('set-cookie')!;
    assert.match(cookie, /__Host-milgyo_session=/);
    assert.match(cookie, /HttpOnly/);
    const checked = await through(db, session, req('/api/auth/session', {}, cookie.split(';')[0]));
    assert.equal(checked.status, 200); assert.equal((await checked.json()).user.id, 'existing-user');
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM system_users').get().n, 1);
  } finally { db.close(); }
});

test('V99: incomplete V97 installation repairs only missing security objects', async () => {
  const db = new SQLiteD1({ auth: false });
  try {
    await seed(db);
    db.sqlite.exec(`CREATE TABLE auth_rate_buckets(bucket_key TEXT PRIMARY KEY, attempts INTEGER NOT NULL, expires_at INTEGER NOT NULL);
      INSERT INTO auth_rate_buckets VALUES('preserve-rate-counter',9,9999999999999);`);
    await assert.rejects(ensureAuthSchema(db), AuthSchemaError);
    const before = snapshot(db);
    db.sqlite.exec(repair); db.sqlite.exec(repair);
    for (const [name, rows] of Object.entries(before)) assert.deepEqual(snapshot(db)[name], rows);
    await ensureAuthSchema(db);
  } finally { db.close(); }
});

test('V99: repair refuses a database without main tables before creating auth objects', () => {
  const db = new SQLiteD1({ migrate: false });
  try {
    db.sqlite.exec("CREATE TABLE unrelated_accounting_data(id TEXT, value INTEGER); INSERT INTO unrelated_accounting_data VALUES('keep',500);");
    const before = snapshot(db);
    assert.throws(() => db.sqlite.exec(repair), /no such table: system_users/);
    assert.deepEqual(snapshot(db), before);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='auth_rate_buckets'").get().n, 0);
  } finally { db.close(); }
});

test('V99: repair refuses missing user security columns rather than silently bypassing them', () => {
  const db = new SQLiteD1({ migrate: false });
  try {
    db.sqlite.exec('CREATE TABLE system_users(id TEXT PRIMARY KEY); CREATE TABLE system_sessions(token TEXT PRIMARY KEY);');
    assert.throws(() => db.sqlite.exec(repair), /no such column/);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='auth_rate_buckets'").get().n, 0);
  } finally { db.close(); }
});

test('V99: repair keeps active hashed sessions and existing rate-limit counters intact', async () => {
  const db = new SQLiteD1();
  try {
    await seed(db); const active = await createSession(db, 'existing-user');
    db.sqlite.exec("INSERT INTO auth_rate_buckets VALUES('keep-limits',7,9999999999999)");
    const before = snapshot(db); db.sqlite.exec(repair);
    assert.deepEqual(snapshot(db), before);
    assert.equal((await authenticateSessionRecord(db, active.token)).ok, true);
  } finally { db.close(); }
});

test('V99: repaired schema retains password-reset/deactivation session revocation', async () => {
  const db = new SQLiteD1({ auth: false });
  try {
    await seed(db); db.sqlite.exec(repair);
    const active = await createSession(db, 'existing-user');
    db.sqlite.exec("UPDATE system_users SET active=0 WHERE id='existing-user'");
    assert.equal((await authenticateSessionRecord(db, active.token)).ok, false);
    const result = await through(db, login, req('/api/auth/login', { username: 'existing-user', password }));
    assert.equal(result.status, 401); assert.equal((await result.json()).code, 'INVALID_CREDENTIALS');
  } finally { db.close(); }
});

test('V99: initial-admin route reports the same missing-schema code without creating users', async () => {
  const db = new SQLiteD1({ auth: false });
  try {
    await seed(db);
    const result = await through(db, bootstrap, req('/api/auth/bootstrap', {
      adminToken: 'test-only-token-'.repeat(3), name: 'Test', username: 'new-admin', password,
    }), { ENABLE_ADMIN_BOOTSTRAP: 'true', ADMIN_TOKEN: 'test-only-token-'.repeat(3) });
    assert.equal(result.status, 503);
    assert.equal((await result.json()).code, 'AUTH_SCHEMA_NOT_READY');
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM system_users').get().n, 1);
  } finally { db.close(); }
});

test('V99: bootstrap remains disabled unless an operator explicitly enables it', async () => {
  const db = new SQLiteD1();
  try {
    const result = await through(db, bootstrap, req('/api/auth/bootstrap', {}), { ADMIN_TOKEN: 'test-only-token-'.repeat(3) });
    assert.equal(result.status, 403); assert.equal((await result.json()).code, 'BOOTSTRAP_DISABLED');
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM system_users').get().n, 0);
  } finally { db.close(); }
});
