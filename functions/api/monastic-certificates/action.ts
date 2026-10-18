import { authenticateSession, getSessionToken, clean, ensureTables, isValidIsoDate, json, randomHex } from '../../_shared/helpers';
import { monasticToday, nextMonasticSequence, toPublicCertificateSnapshot } from '../../_shared/monastic';
import { writeManagementAudit } from '../../_shared/management';
interface Env { DB: D1Database }
type Payload = { operation?: string; requestId?: string; registryId?: string; issueDate?: string; purpose?: string;
  signatoryTitle?: string; signatoryUserId?: string; managerName?: string; contact?: string;
  includeLogoSqSeal?: boolean; id?: string; reason?: string };
const titles = new Set(['이사장', '이사장 직무대리']);
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB) return json({ ok: false, message: '메인 D1(DB)이 연결되지 않았습니다.' }, 503);
  let p: Payload; try { p = await request.json(); } catch { return json({ ok: false, message: '요청 형식이 올바르지 않습니다.' }, 400); }
  await ensureTables(env.DB);
  const auth = await authenticateSession(env.DB, getSessionToken(request));
  if (!auth.ok) return json({ ok: false, code: auth.code, message: auth.message }, auth.status);
  if (auth.user.role !== 'admin') return json({ ok: false, message: '승적증명서 발급·취소는 관리자만 처리할 수 있습니다.' }, 403);
  const operation = clean(p.operation, 20);
  if (operation === 'issue') {
    const requestId = clean(p.requestId, 100);
    if (!/^[A-Za-z0-9_-]{12,100}$/.test(requestId)) return json({ ok: false, message: '요청 식별값이 올바르지 않습니다. 페이지를 다시 열어주세요.' }, 400);
    const prior = await env.DB.prepare('SELECT * FROM monastic_certificates WHERE request_id=? AND issued_by_user_id=?')
      .bind(requestId, auth.user.id).first<Record<string, unknown>>();
    if (prior) return json({ ok: true, row: prior, repeated: true, message: '이미 발급된 증명서입니다. 기존 발급본을 반환합니다.' });
    const registryId = clean(p.registryId, 80);
    const record = await env.DB.prepare('SELECT * FROM monastic_registry WHERE id=?').bind(registryId).first<Record<string, unknown>>();
    if (!record) return json({ ok: false, message: '승적원부가 등록되지 않았습니다.' }, 404);
    if (!record.lay_name) return json({ ok: false, message: '대외증명서 성명란을 위한 속명을 승적원부에 먼저 기록해 주세요.' }, 409);
    if (record.status !== '재적') return json({ ok: false, message: '현재 재적 중인 승려에 대해서만 승적증명서를 발급할 수 있습니다.' }, 409);
    if (record.processing_basis === '비동의' || record.sensitive_basis === '비동의') return json({ ok: false, message: '동의하지 않은 개인정보 처리항목이 있습니다. 적법한 처리근거를 확인하기 전에는 대외증명서를 발급할 수 없습니다.' }, 409);
    const issueDate = clean(p.issueDate, 10) || monasticToday();
    if (!isValidIsoDate(issueDate) || issueDate > monasticToday() || issueDate < String(record.acquired_date) || issueDate < String(record.last_verified_date)) {
      return json({ ok: false, message: '발급일은 실제 확인일·승적 취득일 이후이며 오늘 이전이어야 합니다.' }, 400);
    }
    const purpose = clean(p.purpose, 300);
    if (!purpose) return json({ ok: false, message: '제출 용도를 입력해 주세요.' }, 400);
    const signatoryTitle = clean(p.signatoryTitle, 30);
    if (!titles.has(signatoryTitle)) return json({ ok: false, message: '발급명의 직함을 선택해 주세요.' }, 400);
    const signatoryUserId = clean(p.signatoryUserId, 80);
    const signatory = await env.DB.prepare('SELECT CAST(id AS TEXT) AS id,name,position FROM system_users WHERE CAST(id AS TEXT)=? AND active=1')
      .bind(signatoryUserId).first<{ id: string; name: string; position: string }>();
    if (!signatory) return json({ ok: false, message: '유효한 발급명의 계정을 선택해 주세요.' }, 400);
    const managerName = clean(p.managerName, 60) || auth.user.name;
    const contact = clean(p.contact, 80);
    const includeLogo = p.includeLogoSqSeal === true;
    const certificateNo = await nextMonasticSequence(env.DB, 'CERT', issueDate);
    const id = `MONCERT-${randomHex(24)}`, now = new Date().toISOString();
    const snapshot = toPublicCertificateSnapshot(record, { certificateNo, issueDate, purpose,
      signatoryTitle, signatoryName: signatory.name, includeLogo, managerName, contact });
    try {
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO monastic_certificates(id,certificate_no,request_id,registry_id,certificate_snapshot,issue_date,purpose,
          signatory_title,signatory_user_id,signatory_name,include_logo_sq_seal,manager_name,contact,
          status,issued_by_user_id,issued_by_name,created_at,updated_at)
          SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM monastic_registry WHERE id=? AND status='재적' AND version=?)`)
          .bind(id, certificateNo, requestId, registryId, JSON.stringify(snapshot), issueDate, purpose,
            signatoryTitle, signatoryUserId, signatory.name, includeLogo ? 1 : 0, managerName, contact,
            '발급', auth.user.id, auth.user.name, now, now, registryId, Number(record.version)),
        env.DB.prepare(`INSERT INTO management_audit_logs(id,category,action,target_id,actor_user_id,actor_name,details_json,created_at)
          SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM monastic_certificates WHERE id=?)`)
          .bind(`MAL-${randomHex(24)}`, '승적증명서', '발급', id, auth.user.id, auth.user.name,
            JSON.stringify({ certificateNo, registryId }), now, id),
      ]);
    } catch (error) {
      const repeated = await env.DB.prepare('SELECT * FROM monastic_certificates WHERE request_id=? AND issued_by_user_id=?')
        .bind(requestId, auth.user.id).first<Record<string, unknown>>();
      if (repeated) return json({ ok: true, row: repeated, repeated: true, message: '기존 발급본을 반환합니다.' });
      if (String(error).includes('UNIQUE constraint')) return json({ ok: false, message: '발급번호가 중복됐습니다. 다시 시도해 주세요.' }, 409);
      throw error;
    }
    const row = await env.DB.prepare('SELECT * FROM monastic_certificates WHERE id=?').bind(id).first<Record<string, unknown>>();
    if (!row) return json({ ok: false, message: '원부가 수정되어 발급이 중단됐습니다. 다시 조회해 주세요.' }, 409);
    return json({ ok: true, row, message: `${certificateNo} 승적증명서가 발급되었습니다.` });
  }
  if (operation === 'cancel') {
    const id = clean(p.id, 80), reason = clean(p.reason, 500);
    if (!reason) return json({ ok: false, message: '발급취소 사유를 입력해 주세요.' }, 400);
    const row = await env.DB.prepare('SELECT certificate_no,status FROM monastic_certificates WHERE id=?').bind(id).first<any>();
    if (!row) return json({ ok: false, message: '증명서를 찾을 수 없습니다.' }, 404);
    if (row.status === '취소') return json({ ok: false, message: '이미 취소된 증명서입니다.' }, 409);
    const now = new Date().toISOString();
    const changed = await env.DB.prepare(`UPDATE monastic_certificates SET status='취소',canceled_at=?,canceled_by_user_id=?,canceled_by_name=?,cancel_reason=?,updated_at=? WHERE id=? AND status='발급'`)
      .bind(now, auth.user.id, auth.user.name, reason, now, id).run();
    if (Number(changed.meta?.changes) !== 1) return json({ ok: false, message: '다른 요청이 발급내역을 먼저 변경했습니다. 다시 조회해 주세요.' }, 409);
    await writeManagementAudit(env.DB, auth.user, '승적증명서', '취소', id, { certificateNo: row.certificate_no });
    return json({ ok: true, message: '승적증명서 발급을 취소했습니다.' });
  }
  return json({ ok: false, message: '지원하지 않는 작업입니다.' }, 400);
};
export const onRequestGet: PagesFunction = async () => json({ ok: false, message: 'POST 요청만 지원합니다.' }, 405);
