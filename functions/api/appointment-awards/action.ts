import { authenticateSession, clean, ensureTables, json, randomHex } from '../../_shared/helpers';
import { writeManagementAudit } from '../../_shared/management';

interface Env { DB: D1Database; }
type Payload = {
  token?: string;
  operation?: string;
  id?: string;
  reason?: string;
  documentType?: string;
  serialNo?: string;
  headerPosition?: string;
  recipientName?: string;
  dharmaName?: string;
  bodyOrganization?: string;
  appointmentPosition?: string;
  commendationText?: string;
  buddhistYear?: number | string;
  issueMonth?: number | string;
  issueDay?: number | string;
  issuerType?: string;
  sealType?: string;
  managerName?: string;
};

const allowedTypes = new Set(['임명장', '표창장']);
const allowedBodyOrganizations = new Set(['종단', '香天寺']);
const allowedIssuerTypes = new Set(['이사장', '香天寺']);
const allowedSealTypes = new Set(['auto', 'organization', 'hyangcheonsa-juji', 'none']);

const ensureAwardTable = async (db: D1Database) => {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS appointment_award_certificates (
      id TEXT PRIMARY KEY,
      serial_no TEXT NOT NULL,
      document_type TEXT NOT NULL,
      header_position TEXT NOT NULL DEFAULT '',
      recipient_name TEXT NOT NULL,
      dharma_name TEXT NOT NULL DEFAULT '',
      body_organization TEXT NOT NULL DEFAULT '',
      appointment_position TEXT NOT NULL DEFAULT '',
      commendation_text TEXT NOT NULL DEFAULT '',
      buddhist_year INTEGER NOT NULL,
      issue_month INTEGER NOT NULL,
      issue_day INTEGER NOT NULL,
      issuer_type TEXT NOT NULL,
      seal_type TEXT NOT NULL DEFAULT 'auto',
      issuer_user_id TEXT NOT NULL,
      issuer_name TEXT NOT NULL,
      manager_name TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT '발급',
      canceled_at TEXT,
      canceled_by_user_id TEXT,
      canceled_by_name TEXT,
      cancel_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
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

  // V92의 전역 연번 UNIQUE를 종류별 UNIQUE로 교체한다. 임명장과 표창장은 같은 연번을 각각 사용할 수 있다.
  await db.prepare('DROP INDEX IF EXISTS idx_appointment_award_serial_no').run();
  await db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_appointment_award_type_serial ON appointment_award_certificates(document_type, serial_no)').run();
};

const validMonthDay = (month: number, day: number) => {
  if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(day) || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(2000, month - 1, day));
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};

const currentKstGregorianYear = () => {
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return now.getUTCFullYear();
};

const serialYear2 = () => currentKstGregorianYear() % 100;
const currentBuddhistYear = () => currentKstGregorianYear() + 544;

const serialSequence = (serial: unknown, year2: number) => {
  const normalized = String(serial ?? '').replace(/\s+/g, '');
  const match = normalized.match(/^제(\d{2})-(\d+)(?:호)?$/);
  if (!match || Number(match[1]) !== year2) return 0;
  return Number(match[2]) || 0;
};

const seedSerialCounter = async (db: D1Database, documentType: string, year2: number) => {
  const existing = await db.prepare('SELECT serial_no FROM appointment_award_certificates WHERE document_type=?').bind(documentType).all<any>();
  const maxExisting = Math.max(0, ...(existing.results || []).map((row: any) => serialSequence(row?.serial_no, year2)));
  await db.prepare('INSERT OR IGNORE INTO appointment_award_serial_counters(document_type,year2,current_no) VALUES(?,?,?)')
    .bind(documentType, year2, maxExisting).run();
  await db.prepare('UPDATE appointment_award_serial_counters SET current_no=? WHERE document_type=? AND year2=? AND current_no<?')
    .bind(maxExisting, documentType, year2, maxExisting).run();
};

const allocateSerialNo = async (db: D1Database, documentType: string) => {
  const year2 = serialYear2();
  await seedSerialCounter(db, documentType, year2);
  const row = await db.prepare(`
    UPDATE appointment_award_serial_counters
    SET current_no=current_no+1
    WHERE document_type=? AND year2=?
    RETURNING current_no
  `).bind(documentType, year2).first<any>();
  const sequence = Number(row?.current_no || 1);
  return `제${String(year2).padStart(2, '0')}-${sequence}`;
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
  const operation = clean(payload.operation, 30);

  if (operation === 'issue') {
    if (auth.user.role !== 'admin') return json({ ok: false, message: '임명장·표창장은 관리자만 발급할 수 있습니다.' }, 403);
    const documentType = clean(payload.documentType, 20);
    const headerPosition = clean(payload.headerPosition, 80);
    const recipientName = clean(payload.recipientName, 80);
    const dharmaName = clean(payload.dharmaName, 80);
    const bodyOrganization = clean(payload.bodyOrganization, 20);
    const appointmentPosition = clean(payload.appointmentPosition, 80);
    const commendationText = clean(payload.commendationText, 1600);
    const buddhistYear = currentBuddhistYear();
    const issueMonth = Number(payload.issueMonth);
    const issueDay = Number(payload.issueDay);
    const issuerType = clean(payload.issuerType, 20);
    const requestedSealType = clean(payload.sealType, 30) || 'auto';
    const sealType = allowedSealTypes.has(requestedSealType) ? requestedSealType : 'auto';
    const managerName = clean(payload.managerName, 60) || auth.user.name;

    if (!allowedTypes.has(documentType)) return json({ ok: false, message: '발급 종류를 선택해 주세요.' }, 400);
    if (!recipientName) return json({ ok: false, message: '성명을 입력해 주세요.' }, 400);
    if (!Number.isInteger(buddhistYear) || buddhistYear < 1 || buddhistYear > 9999) return json({ ok: false, message: '불기 연도를 확인해 주세요.' }, 400);
    if (!validMonthDay(issueMonth, issueDay)) return json({ ok: false, message: '발급 월·일을 확인해 주세요.' }, 400);
    if (!allowedIssuerTypes.has(issuerType)) return json({ ok: false, message: '발행주체를 선택해 주세요.' }, 400);
    if (documentType === '임명장') {
      if (!allowedBodyOrganizations.has(bodyOrganization)) return json({ ok: false, message: '본문 발행단위를 선택해 주세요.' }, 400);
      if (!appointmentPosition) return json({ ok: false, message: '임명 직위명을 입력해 주세요.' }, 400);
    }
    if (documentType === '표창장' && !commendationText) return json({ ok: false, message: '표창장 본문을 입력해 주세요.' }, 400);

    const serialNo = await allocateSerialNo(env.DB, documentType);
    const id = `APAWD-${randomHex(24)}`;
    const now = new Date().toISOString();
    try {
      await env.DB.prepare(`
        INSERT INTO appointment_award_certificates(
          id,serial_no,document_type,header_position,recipient_name,dharma_name,body_organization,
          appointment_position,commendation_text,buddhist_year,issue_month,issue_day,issuer_type,seal_type,
          issuer_user_id,issuer_name,manager_name,status,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).bind(
        id, serialNo, documentType, headerPosition, recipientName, dharmaName,
        documentType === '임명장' ? bodyOrganization : '',
        documentType === '임명장' ? appointmentPosition : '',
        documentType === '표창장' ? commendationText : '',
        buddhistYear, issueMonth, issueDay, issuerType, sealType,
        auth.user.id, auth.user.name, managerName, '발급', now, now,
      ).run();
    } catch (error) {
      const message = String((error as any)?.message || error || '');
      if (/unique|constraint/i.test(message)) return json({ ok: false, message: '연번 자동부여 중 충돌이 발생했습니다. 다시 저장해 주세요.' }, 409);
      console.error('appointment/award issue failed', error);
      return json({ ok: false, message: '임명장·표창장 발급대장 저장 중 오류가 발생했습니다.' }, 500);
    }

    await writeManagementAudit(env.DB, auth.user, '임명장표창장', '발급', id, {
      serialNo, documentType, recipientName, dharmaName, headerPosition, appointmentPosition, issuerType, sealType,
    });
    const row = await env.DB.prepare('SELECT * FROM appointment_award_certificates WHERE id=?').bind(id).first<any>();
    return json({ ok: true, row, message: `${serialNo} ${documentType}이(가) 발급대장에 저장되었습니다.` });
  }

  if (operation === 'cancel') {
    if (auth.user.role !== 'admin') return json({ ok: false, message: '발급 취소는 관리자만 할 수 있습니다.' }, 403);
    const id = clean(payload.id, 80);
    const reason = clean(payload.reason, 500);
    if (!reason) return json({ ok: false, message: '취소 사유를 입력해 주세요.' }, 400);
    const row = await env.DB.prepare('SELECT * FROM appointment_award_certificates WHERE id=?').bind(id).first<any>();
    if (!row) return json({ ok: false, message: '발급내역을 찾을 수 없습니다.' }, 404);
    if (row.status === '취소') return json({ ok: false, message: '이미 취소된 발급내역입니다.' }, 400);
    const now = new Date().toISOString();
    await env.DB.prepare(`
      UPDATE appointment_award_certificates
      SET status='취소',canceled_at=?,canceled_by_user_id=?,canceled_by_name=?,cancel_reason=?,updated_at=?
      WHERE id=?
    `).bind(now, auth.user.id, auth.user.name, reason, now, id).run();
    await writeManagementAudit(env.DB, auth.user, '임명장표창장', '취소', id, { serialNo: row.serial_no, reason });
    return json({ ok: true, message: '발급내역이 취소되었습니다.' });
  }

  return json({ ok: false, message: '지원하지 않는 작업입니다.' }, 400);
};

export const onRequestGet: PagesFunction = async () => json({ ok: false, message: 'POST 방식으로 요청해 주세요.' }, 405);
