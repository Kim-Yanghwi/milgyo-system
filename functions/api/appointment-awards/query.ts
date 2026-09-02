import { authenticateSession, clean, ensureTables, json } from '../../_shared/helpers';

interface Env { DB: D1Database; }
type Payload = { token?: string; operation?: string; id?: string; documentType?: string; status?: string; query?: string; page?: number; pageSize?: number; };

const allowedTypes = new Set(['임명장', '표창장']);

const ensureAwardTable = async (db: D1Database) => {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS appointment_award_certificates (
      id TEXT PRIMARY KEY, serial_no TEXT NOT NULL, document_type TEXT NOT NULL,
      header_position TEXT NOT NULL DEFAULT '', recipient_name TEXT NOT NULL, dharma_name TEXT NOT NULL DEFAULT '',
      body_organization TEXT NOT NULL DEFAULT '', appointment_position TEXT NOT NULL DEFAULT '', commendation_text TEXT NOT NULL DEFAULT '',
      buddhist_year INTEGER NOT NULL, issue_month INTEGER NOT NULL, issue_day INTEGER NOT NULL,
      issuer_type TEXT NOT NULL, seal_type TEXT NOT NULL DEFAULT 'auto', issuer_user_id TEXT NOT NULL,
      issuer_name TEXT NOT NULL, manager_name TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT '발급',
      canceled_at TEXT, canceled_by_user_id TEXT, canceled_by_name TEXT, cancel_reason TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS appointment_award_serial_counters (
      document_type TEXT NOT NULL,
      year2 INTEGER NOT NULL,
      current_no INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(document_type, year2)
    )`),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_appointment_award_created_at ON appointment_award_certificates(created_at DESC)'),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_appointment_award_recipient ON appointment_award_certificates(recipient_name, dharma_name)'),
  ]);

  const columns = await db.prepare('PRAGMA table_info(appointment_award_certificates)').all<any>();
  if (!(columns.results || []).some((column: any) => column?.name === 'seal_type')) {
    try {
      await db.prepare("ALTER TABLE appointment_award_certificates ADD COLUMN seal_type TEXT NOT NULL DEFAULT 'auto'").run();
    } catch (error) {
      if (!/duplicate column/i.test(String((error as any)?.message || error || ''))) throw error;
    }
  }
  await db.prepare('DROP INDEX IF EXISTS idx_appointment_award_serial_no').run();
  await db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_appointment_award_type_serial ON appointment_award_certificates(document_type, serial_no)').run();
};

const serialYear2 = () => {
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return now.getUTCFullYear() % 100;
};

const serialSequence = (serial: unknown, year2: number) => {
  const normalized = String(serial ?? '').replace(/\s+/g, '');
  const match = normalized.match(/^제(\d{2})-(\d+)(?:호)?$/);
  if (!match || Number(match[1]) !== year2) return 0;
  return Number(match[2]) || 0;
};

const getNextSerial = async (db: D1Database, documentType: string) => {
  const year2 = serialYear2();
  const [counter, existing] = await Promise.all([
    db.prepare('SELECT current_no FROM appointment_award_serial_counters WHERE document_type=? AND year2=?').bind(documentType, year2).first<any>(),
    db.prepare('SELECT serial_no FROM appointment_award_certificates WHERE document_type=?').bind(documentType).all<any>(),
  ]);
  const maxExisting = Math.max(0, ...(existing.results || []).map((row: any) => serialSequence(row?.serial_no, year2)));
  const current = Math.max(Number(counter?.current_no || 0), maxExisting);
  return `제${String(year2).padStart(2, '0')}-${current + 1}`;
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB) return json({ ok: false, message: 'DB가 연결되지 않았습니다.' }, 500);
  let payload: Payload;
  try { payload = await request.json(); }
  catch { return json({ ok: false, message: '요청 형식이 올바르지 않습니다.' }, 400); }
  await ensureTables(env.DB);
  await ensureAwardTable(env.DB);
  const auth = await authenticateSession(env.DB, clean(payload.token, 200));
  if (!auth.ok) return json({ ok: false, message: auth.message }, auth.status);
  const operation = clean(payload.operation, 20) || 'list';
  const canManage = auth.user.role === 'admin';
  const canReadLedger = auth.user.role === 'admin' || auth.user.role === 'audit';

  if (operation === 'options') {
    const [appointmentSerial, commendationSerial] = await Promise.all([
      getNextSerial(env.DB, '임명장'),
      getNextSerial(env.DB, '표창장'),
    ]);
    return json({ ok: true, me: auth.user, canManage, canReadLedger, nextSerials: { '임명장': appointmentSerial, '표창장': commendationSerial } });
  }

  if (operation === 'nextSerial') {
    const documentType = clean(payload.documentType, 20);
    if (!allowedTypes.has(documentType)) return json({ ok: false, message: '발급 종류를 확인해 주세요.' }, 400);
    return json({ ok: true, serialNo: await getNextSerial(env.DB, documentType) });
  }

  if (!canReadLedger) return json({ ok: false, message: '임명장·표창장 발급대장 열람 권한이 없습니다.' }, 403);

  if (operation === 'detail') {
    const id = clean(payload.id, 80);
    const row = await env.DB.prepare('SELECT * FROM appointment_award_certificates WHERE id=?').bind(id).first<any>();
    if (!row) return json({ ok: false, message: '발급내역을 찾을 수 없습니다.' }, 404);
    return json({ ok: true, row, me: auth.user, canManage });
  }

  const page = Math.max(1, Math.min(10000, Number(payload.page) || 1));
  const pageSize = Math.max(10, Math.min(100, Number(payload.pageSize) || 20));
  const filters: string[] = [];
  const binds: unknown[] = [];
  const documentType = clean(payload.documentType, 20);
  const status = clean(payload.status, 20);
  const query = clean(payload.query, 120);
  if (documentType) { filters.push('document_type=?'); binds.push(documentType); }
  if (status) { filters.push('status=?'); binds.push(status); }
  if (query) {
    const keyword = `%${query}%`;
    filters.push('(serial_no LIKE ? OR recipient_name LIKE ? OR dharma_name LIKE ? OR header_position LIKE ? OR appointment_position LIKE ?)');
    binds.push(keyword, keyword, keyword, keyword, keyword);
  }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const offset = (page - 1) * pageSize;
  try {
    const countStatement = binds.length
      ? env.DB.prepare(`SELECT COUNT(*) AS count FROM appointment_award_certificates ${where}`).bind(...binds)
      : env.DB.prepare(`SELECT COUNT(*) AS count FROM appointment_award_certificates ${where}`);
    const rowStatement = env.DB.prepare(`SELECT * FROM appointment_award_certificates ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).bind(...binds, pageSize, offset);
    const [countResult, rowResult] = await env.DB.batch([countStatement, rowStatement]);
    const total = Number((countResult.results?.[0] as any)?.count || 0);
    return json({ ok: true, rows: rowResult.results || [], total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)), me: auth.user, canManage });
  } catch (error) {
    console.error('appointment/award query failed', error);
    return json({ ok: false, message: '임명장·표창장 발급대장 조회 중 오류가 발생했습니다.' }, 500);
  }
};

export const onRequestGet: PagesFunction = async () => json({ ok: false, message: 'POST 방식으로 요청해 주세요.' }, 405);
