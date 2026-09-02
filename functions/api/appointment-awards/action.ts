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
  managerName?: string;
};

const allowedTypes = new Set(['임명장', '표창장']);
const allowedBodyOrganizations = new Set(['종단', '香天寺']);
const allowedIssuerTypes = new Set(['이사장', '香天寺']);

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
    db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_appointment_award_serial_no ON appointment_award_certificates(serial_no)'),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_appointment_award_created_at ON appointment_award_certificates(created_at DESC)'),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_appointment_award_recipient ON appointment_award_certificates(recipient_name, dharma_name)'),
  ]);
};

const validMonthDay = (month: number, day: number) => {
  if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(day) || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(2000, month - 1, day));
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
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
    const serialNo = clean(payload.serialNo, 40);
    const headerPosition = clean(payload.headerPosition, 80);
    const recipientName = clean(payload.recipientName, 80);
    const dharmaName = clean(payload.dharmaName, 80);
    const bodyOrganization = clean(payload.bodyOrganization, 20);
    const appointmentPosition = clean(payload.appointmentPosition, 80);
    const commendationText = clean(payload.commendationText, 1600);
    const buddhistYear = Number(payload.buddhistYear);
    const issueMonth = Number(payload.issueMonth);
    const issueDay = Number(payload.issueDay);
    const issuerType = clean(payload.issuerType, 20);
    const managerName = clean(payload.managerName, 60) || auth.user.name;

    if (!allowedTypes.has(documentType)) return json({ ok: false, message: '발급 종류를 선택해 주세요.' }, 400);
    if (!serialNo) return json({ ok: false, message: '연번을 입력해 주세요.' }, 400);
    if (!recipientName) return json({ ok: false, message: '성명을 입력해 주세요.' }, 400);
    if (!Number.isInteger(buddhistYear) || buddhistYear < 1 || buddhistYear > 9999) return json({ ok: false, message: '불기 연도를 확인해 주세요.' }, 400);
    if (!validMonthDay(issueMonth, issueDay)) return json({ ok: false, message: '발급 월·일을 확인해 주세요.' }, 400);
    if (!allowedIssuerTypes.has(issuerType)) return json({ ok: false, message: '발행주체를 선택해 주세요.' }, 400);
    if (documentType === '임명장') {
      if (!allowedBodyOrganizations.has(bodyOrganization)) return json({ ok: false, message: '본문 발행단위를 선택해 주세요.' }, 400);
      if (!appointmentPosition) return json({ ok: false, message: '임명 직위명을 입력해 주세요.' }, 400);
    }
    if (documentType === '표창장' && !commendationText) return json({ ok: false, message: '표창장 본문을 입력해 주세요.' }, 400);

    const id = `APAWD-${randomHex(24)}`;
    const now = new Date().toISOString();
    try {
      await env.DB.prepare(`
        INSERT INTO appointment_award_certificates(
          id,serial_no,document_type,header_position,recipient_name,dharma_name,body_organization,
          appointment_position,commendation_text,buddhist_year,issue_month,issue_day,issuer_type,
          issuer_user_id,issuer_name,manager_name,status,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).bind(
        id, serialNo, documentType, headerPosition, recipientName, dharmaName,
        documentType === '임명장' ? bodyOrganization : '',
        documentType === '임명장' ? appointmentPosition : '',
        documentType === '표창장' ? commendationText : '',
        buddhistYear, issueMonth, issueDay, issuerType,
        auth.user.id, auth.user.name, managerName, '발급', now, now,
      ).run();
    } catch (error) {
      const message = String((error as any)?.message || error || '');
      if (/unique|constraint/i.test(message)) return json({ ok: false, message: '이미 사용된 연번입니다. 다른 연번을 입력해 주세요.' }, 409);
      console.error('appointment/award issue failed', error);
      return json({ ok: false, message: '임명장·표창장 발급대장 저장 중 오류가 발생했습니다.' }, 500);
    }

    await writeManagementAudit(env.DB, auth.user, '임명장표창장', '발급', id, {
      serialNo, documentType, recipientName, dharmaName, headerPosition, appointmentPosition, issuerType,
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
