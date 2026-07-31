import { authenticateSession, clean, ensureTables, isValidIsoDate, json, randomHex } from '../../_shared/helpers';
import { isRegisterType, kstDate, makeRegisterNumber, registerTitle, sanitizeRegisterContent, writeManagementAudit } from '../../_shared/management';

interface Env { DB: D1Database; FILES?: R2Bucket; }
type Payload = { token?: string; operation?: string; id?: string; type?: string; requestDate?: string; content?: unknown; status?: string; memo?: string };

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB) return json({ ok: false, message: 'DB가 연결되지 않았습니다.' }, 500);
  let payload: Payload;
  try { payload = await request.json(); } catch { return json({ ok: false, message: '요청 형식이 올바르지 않습니다.' }, 400); }
  await ensureTables(env.DB);
  const auth = await authenticateSession(env.DB, clean(payload.token, 200));
  if (!auth.ok) return json({ ok: false, message: auth.message }, auth.status);
  const operation = clean(payload.operation, 30);

  if (operation === 'create') {
    if (auth.user.role === 'audit') return json({ ok: false, message: '감사계정은 신청자료를 등록할 수 없습니다.' }, 403);
    const type = clean(payload.type, 40);
    if (!isRegisterType(type)) return json({ ok: false, message: '대장 유형을 선택해 주세요.' }, 400);
    const requestDate = clean(payload.requestDate, 10) || kstDate();
    if (!isValidIsoDate(requestDate)) return json({ ok: false, message: '신청일자가 올바르지 않습니다.' }, 400);
    const content = sanitizeRegisterContent(type, payload.content);
    const title = registerTitle(type, content as unknown as Record<string, string>);
    if (!title) return json({ ok: false, message: type === '공고대장' ? '공고명을 입력해 주세요.' : '건명 또는 사용목적을 입력해 주세요.' }, 400);
    if (type === '공고대장' && !content.noticeDate) content.noticeDate = requestDate;
    if (type === '인영관리기록부' && content.usageStartDate && content.usageEndDate && content.usageStartDate > content.usageEndDate) {
      return json({ ok: false, message: '사용기간 종료일은 시작일보다 빠를 수 없습니다.' }, 400);
    }
    if (type === '인영관리기록부' && !content.pledgeAccepted) {
      return json({ ok: false, message: '인영 사용 준수사항을 확인하고 서약해 주세요.' }, 400);
    }
    const id = `MREG-${randomHex(24)}`;
    const requestNo = await makeRegisterNumber(env.DB, type, requestDate);
    const now = new Date().toISOString();
    await env.DB.prepare(`
      INSERT INTO management_registers
        (id,request_no,record_type,title,content_json,applicant_user_id,applicant_name,applicant_department,status,request_date,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    `).bind(id, requestNo, type, title, JSON.stringify(content), auth.user.id, auth.user.name, auth.user.department || '', '신청', requestDate, now, now).run();
    await writeManagementAudit(env.DB, auth.user, '대장관리', '신청', id, { requestNo, type, title });
    return json({ ok: true, id, requestNo, message: `${requestNo} 신청이 등록되었습니다.` });
  }

  const id = clean(payload.id, 80);
  const row = await env.DB.prepare(`SELECT * FROM management_registers WHERE id=?`).bind(id).first<Record<string, unknown>>();
  if (!row) return json({ ok: false, message: '대장 신청내역을 찾을 수 없습니다.' }, 404);

  if (operation === 'updateStatus') {
    if (auth.user.role !== 'admin') return json({ ok: false, message: '처리상태 변경은 관리자만 할 수 있습니다.' }, 403);
    const status = clean(payload.status, 20);
    if (!['신청', '검토중', '완료', '반려'].includes(status)) return json({ ok: false, message: '처리상태가 올바르지 않습니다.' }, 400);
    const memo = clean(payload.memo, 1000);
    const now = new Date().toISOString();
    await env.DB.prepare(`UPDATE management_registers SET status=?,processing_memo=?,processed_by=?,processed_by_user_id=?,processed_at=?,updated_at=? WHERE id=?`)
      .bind(status, memo, auth.user.name, auth.user.id, now, now, id).run();
    await writeManagementAudit(env.DB, auth.user, '대장관리', `상태:${status}`, id, { memo });
    return json({ ok: true, message: '처리상태가 변경되었습니다.' });
  }

  if (operation === 'cancel') {
    const isOwner = String(row.applicant_user_id || '') === auth.user.id;
    if (!isOwner && auth.user.role !== 'admin') return json({ ok: false, message: '본인 신청자료만 취소할 수 있습니다.' }, 403);
    if (!['신청', '검토중'].includes(String(row.status || ''))) return json({ ok: false, message: '현재 상태에서는 신청을 취소할 수 없습니다.' }, 400);
    const now = new Date().toISOString();
    await env.DB.prepare(`UPDATE management_registers SET status='취소',processing_memo=?,processed_by=?,processed_by_user_id=?,processed_at=?,updated_at=? WHERE id=?`)
      .bind(clean(payload.memo, 1000) || '신청자 취소', auth.user.name, auth.user.id, now, now, id).run();
    await writeManagementAudit(env.DB, auth.user, '대장관리', '취소', id, {});
    return json({ ok: true, message: '신청이 취소되었습니다.' });
  }

  return json({ ok: false, message: '지원하지 않는 작업입니다.' }, 400);
};

export const onRequestGet: PagesFunction = async () => json({ ok: false, message: 'POST 방식으로 요청해 주세요.' }, 405);
