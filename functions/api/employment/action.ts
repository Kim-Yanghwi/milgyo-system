import { authenticateSession, clean, ensureTables, isValidIsoDate, json, randomHex } from '../../_shared/helpers';
import { kstDate, makeEmploymentCertificateNumber, writeManagementAudit } from '../../_shared/management';

interface Env { DB: D1Database; }

type Payload = {
  token?: string;
  operation?: string;
  employeeUserId?: string;
  employeeNameKo?: string;
  nameHanja?: string;
  birthOrRegistration?: string;
  address?: string;
  employmentStartDate?: string;
  department?: string;
  positionGrade?: string;
  purpose?: string;
  issueDate?: string;
  managerName?: string;
  contact?: string;
  signatoryTitle?: string;
  signatoryUserId?: string;
  includeLogoSqSeal?: boolean | number | string;
  id?: string;
  reason?: string;
};

const allowedSignatoryTitles = new Set(['이사장', '이사장 직무대리']);
const truthyFlag = (value: unknown) => value === true || value === 1 || value === '1' || value === 'true' || value === 'on';

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB) return json({ ok: false, message: 'DB가 연결되지 않았습니다.' }, 500);

  let payload: Payload;
  try { payload = await request.json(); }
  catch { return json({ ok: false, message: '요청 형식이 올바르지 않습니다.' }, 400); }

  await ensureTables(env.DB);
  const auth = await authenticateSession(env.DB, clean(payload.token, 200));
  if (!auth.ok) return json({ ok: false, message: auth.message }, auth.status);
  const operation = clean(payload.operation, 30);

  if (operation === 'issue') {
    if (auth.user.role !== 'admin') return json({ ok: false, message: '재직증명서는 관리자만 발급할 수 있습니다.' }, 403);

    const employeeUserId = clean(payload.employeeUserId, 80) || auth.user.id;
    const employee = await env.DB.prepare(`
      SELECT CAST(id AS TEXT) AS id,name,position,grade,department,active
      FROM system_users WHERE CAST(id AS TEXT)=?
    `).bind(employeeUserId).first<any>();
    if (!employee || !Number(employee.active)) return json({ ok: false, message: '재직 중인 임·직원 계정을 찾을 수 없습니다.' }, 404);

    const issueDate = clean(payload.issueDate, 10) || kstDate();
    const startDate = clean(payload.employmentStartDate, 10);
    if (!isValidIsoDate(issueDate)) return json({ ok: false, message: '발급일자가 올바르지 않습니다.' }, 400);
    if (!isValidIsoDate(startDate)) return json({ ok: false, message: '재직 시작일을 입력해 주세요.' }, 400);

    const employeeNameKo = clean(payload.employeeNameKo, 60) || clean(employee.name, 60);
    const department = clean(payload.department, 100) || clean(employee.department, 100);
    const positionGrade = clean(payload.positionGrade, 100) || clean([employee.position, employee.grade].filter(Boolean).join(' / '), 100);
    const purpose = clean(payload.purpose, 300);
    const address = clean(payload.address, 500);
    const identity = clean(payload.birthOrRegistration, 30);
    if (!employeeNameKo || !department || !positionGrade || !purpose || !address || !identity) {
      return json({ ok: false, message: '성명(한글), 소속, 직위·직급, 용도, 주소, 생년월일 또는 주민등록번호를 모두 입력해 주세요.' }, 400);
    }

    const signatoryTitle = clean(payload.signatoryTitle, 20);
    if (!allowedSignatoryTitles.has(signatoryTitle)) return json({ ok: false, message: '발급명의 직함을 선택해 주세요.' }, 400);
    const signatoryUserId = clean(payload.signatoryUserId, 80);
    const signatory = await env.DB.prepare(`
      SELECT CAST(id AS TEXT) AS id,name FROM system_users
      WHERE CAST(id AS TEXT)=? AND active=1
    `).bind(signatoryUserId).first<any>();
    if (!signatory) return json({ ok: false, message: '발급명의로 사용할 활성 계정을 찾을 수 없습니다.' }, 400);

    const includeLogoSqSeal = truthyFlag(payload.includeLogoSqSeal);
    const id = `EMPCERT-${randomHex(24)}`;
    const certificateNo = await makeEmploymentCertificateNumber(env.DB, issueDate);
    const now = new Date().toISOString();
    const managerName = clean(payload.managerName, 60) || auth.user.name;
    const contact = clean(payload.contact, 80);

    await env.DB.prepare(`
      INSERT INTO employee_profiles(user_id,name_hanja,birth_or_registration,address,employment_start_date,updated_at)
      VALUES(?,?,?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET
        name_hanja=excluded.name_hanja,birth_or_registration=excluded.birth_or_registration,
        address=excluded.address,employment_start_date=excluded.employment_start_date,updated_at=excluded.updated_at
    `).bind(employeeUserId, clean(payload.nameHanja, 60), identity, address, startDate, now).run();

    await env.DB.prepare(`
      INSERT INTO employment_certificates(
        id,certificate_no,employee_user_id,employee_name_ko,employee_name_hanja,birth_or_registration,
        address,department,position_grade,employment_start_date,purpose,issue_date,issuer_user_id,issuer_name,
        signatory_title,signatory_user_id,signatory_name,include_logo_sq_seal,manager_name,contact,status,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).bind(
      id, certificateNo, employeeUserId, employeeNameKo, clean(payload.nameHanja, 60), identity,
      address, department, positionGrade, startDate, purpose, issueDate, auth.user.id, auth.user.name,
      signatoryTitle, signatory.id, signatory.name, includeLogoSqSeal ? 1 : 0, managerName, contact, '발급', now, now,
    ).run();

    await writeManagementAudit(env.DB, auth.user, '임직원증명서', '발급', id, {
      certificateNo,
      employeeUserId,
      employeeName: employeeNameKo,
      purpose,
      signatoryTitle,
      signatoryUserId: signatory.id,
      signatoryName: signatory.name,
      includeLogoSqSeal,
    });
    const row = await env.DB.prepare('SELECT * FROM employment_certificates WHERE id=?').bind(id).first<any>();
    return json({ ok: true, row, message: `${certificateNo} 재직증명서가 발급되었습니다.` });
  }

  if (operation === 'cancel') {
    if (auth.user.role !== 'admin') return json({ ok: false, message: '증명서 취소는 관리자만 할 수 있습니다.' }, 403);
    const id = clean(payload.id, 80);
    const row = await env.DB.prepare('SELECT * FROM employment_certificates WHERE id=?').bind(id).first<any>();
    if (!row) return json({ ok: false, message: '발급내역을 찾을 수 없습니다.' }, 404);
    if (row.status === '취소') return json({ ok: false, message: '이미 취소된 증명서입니다.' }, 400);
    const reason = clean(payload.reason, 500);
    if (!reason) return json({ ok: false, message: '취소 사유를 입력해 주세요.' }, 400);
    const now = new Date().toISOString();
    await env.DB.prepare(`
      UPDATE employment_certificates
      SET status='취소',canceled_at=?,canceled_by_user_id=?,canceled_by_name=?,cancel_reason=?,updated_at=?
      WHERE id=?
    `).bind(now, auth.user.id, auth.user.name, reason, now, id).run();
    await writeManagementAudit(env.DB, auth.user, '임직원증명서', '취소', id, { certificateNo: row.certificate_no, reason });
    return json({ ok: true, message: '재직증명서 발급이 취소되었습니다.' });
  }

  return json({ ok: false, message: '지원하지 않는 작업입니다.' }, 400);
};

export const onRequestGet: PagesFunction = async () => json({ ok: false, message: 'POST 방식으로 요청해 주세요.' }, 405);
