import { authenticateSession, clean, ensureTables, json, randomHex } from '../../_shared/helpers';
import { writeManagementAudit } from '../../_shared/management';
import {
  deriveForeignNationality,
  deriveForeignSubject,
  ensureForeignFormTables,
  isForeignFormType,
  makeForeignRecordNo,
  sanitizeForeignSnapshot,
} from '../../_shared/foreign-forms';

interface Env { DB: D1Database; }

const canManage = (role: string) => role === 'admin';

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB) return json({ ok: false, message: 'D1(DB) 바인딩이 필요합니다.' }, 503);
  await ensureTables(env.DB);
  await ensureForeignFormTables(env.DB);

  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const auth = await authenticateSession(env.DB, clean(body.token, 160));
  if (!auth.ok) return json({ ok: false, message: auth.message }, auth.status);
  const user = auth.user;
  const action = clean(body.action, 20);

  if (action === 'save') {
    const formType = clean(body.formType, 40);
    if (!isForeignFormType(formType)) return json({ ok: false, message: '지원하지 않는 신청서 종류입니다.' }, 400);
    const snapshot = sanitizeForeignSnapshot(body.snapshot);
    const snapshotJson = JSON.stringify(snapshot);
    if (snapshotJson.length > 120_000) return json({ ok: false, message: '작성 내용이 너무 큽니다.' }, 413);

    const subjectName = deriveForeignSubject(formType, snapshot);
    if (!subjectName) return json({ ok: false, message: '신청인 또는 외국인 성명을 입력해 주세요.' }, 400);
    const nationality = deriveForeignNationality(snapshot);
    const existingId = clean(body.id, 80);
    const now = new Date().toISOString();

    if (existingId) {
      const existing = await env.DB.prepare(`SELECT id,created_by_user_id,status FROM foreign_application_forms WHERE id=? LIMIT 1`)
        .bind(existingId).first<Record<string, unknown>>();
      if (!existing) return json({ ok: false, message: '수정할 기록을 찾을 수 없습니다.' }, 404);
      if (String(existing.status || '') === '취소') return json({ ok: false, message: '취소된 기록은 수정할 수 없습니다.' }, 409);
      if (!canManage(user.role) && String(existing.created_by_user_id || '') !== user.id) {
        return json({ ok: false, message: '이 기록을 수정할 권한이 없습니다.' }, 403);
      }
      await env.DB.prepare(`
        UPDATE foreign_application_forms
        SET form_type=?,subject_name=?,nationality=?,snapshot_json=?,updated_at=?
        WHERE id=?
      `).bind(formType, subjectName, nationality, snapshotJson, now, existingId).run();
      await writeManagementAudit(env.DB, user, '외국인신청서', '수정', existingId, { formType, subjectName });
      const updated = await env.DB.prepare(`SELECT id,record_no,status,updated_at FROM foreign_application_forms WHERE id=?`).bind(existingId).first();
      return json({ ok: true, message: '작성 이력을 저장했습니다.', row: updated });
    }

    const id = `FAR-${randomHex(24)}`;
    let recordNo = makeForeignRecordNo();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const duplicate = await env.DB.prepare(`SELECT id FROM foreign_application_forms WHERE record_no=?`).bind(recordNo).first();
      if (!duplicate) break;
      recordNo = makeForeignRecordNo();
    }
    await env.DB.prepare(`
      INSERT INTO foreign_application_forms
        (id,record_no,form_type,subject_name,nationality,status,snapshot_json,created_by_user_id,created_by_name,created_at,updated_at)
      VALUES(?,?,?,?,?,'저장',?,?,?,?,?)
    `).bind(id, recordNo, formType, subjectName, nationality, snapshotJson, user.id, user.name, now, now).run();
    await writeManagementAudit(env.DB, user, '외국인신청서', '등록', id, { recordNo, formType, subjectName });
    return json({ ok: true, message: '작성 이력을 저장했습니다.', row: { id, record_no: recordNo, status: '저장', updated_at: now } });
  }

  if (action === 'event') {
    const id = clean(body.id, 80);
    const event = clean(body.event, 20);
    if (!id || !['print', 'download'].includes(event)) return json({ ok: false, message: '잘못된 기록 이벤트입니다.' }, 400);
    const row = await env.DB.prepare(`SELECT id,created_by_user_id,status,record_no FROM foreign_application_forms WHERE id=? LIMIT 1`)
      .bind(id).first<Record<string, unknown>>();
    if (!row) return json({ ok: false, message: '기록을 찾을 수 없습니다.' }, 404);
    if (!canManage(user.role) && String(row.created_by_user_id || '') !== user.id) {
      return json({ ok: false, message: '이 기록을 사용할 권한이 없습니다.' }, 403);
    }
    if (String(row.status || '') === '취소') return json({ ok: false, message: '취소된 기록입니다.' }, 409);
    const now = new Date().toISOString();
    if (event === 'print') {
      await env.DB.prepare(`UPDATE foreign_application_forms SET last_printed_at=?,print_count=print_count+1,updated_at=? WHERE id=?`)
        .bind(now, now, id).run();
      await writeManagementAudit(env.DB, user, '외국인신청서', '출력', id, { recordNo: row.record_no });
    } else {
      await env.DB.prepare(`UPDATE foreign_application_forms SET last_downloaded_at=?,download_count=download_count+1,updated_at=? WHERE id=?`)
        .bind(now, now, id).run();
      await writeManagementAudit(env.DB, user, '외국인신청서', '다운로드', id, { recordNo: row.record_no });
    }
    return json({ ok: true });
  }

  if (action === 'cancel') {
    const id = clean(body.id, 80);
    if (!id) return json({ ok: false, message: '기록 ID가 필요합니다.' }, 400);
    const row = await env.DB.prepare(`SELECT id,created_by_user_id,status,record_no FROM foreign_application_forms WHERE id=? LIMIT 1`)
      .bind(id).first<Record<string, unknown>>();
    if (!row) return json({ ok: false, message: '기록을 찾을 수 없습니다.' }, 404);
    if (!canManage(user.role) && String(row.created_by_user_id || '') !== user.id) {
      return json({ ok: false, message: '이 기록을 취소할 권한이 없습니다.' }, 403);
    }
    if (String(row.status || '') === '취소') return json({ ok: true, message: '이미 취소된 기록입니다.' });
    const now = new Date().toISOString();
    await env.DB.prepare(`
      UPDATE foreign_application_forms
      SET status='취소',canceled_at=?,canceled_by_name=?,updated_at=?
      WHERE id=?
    `).bind(now, user.name, now, id).run();
    await writeManagementAudit(env.DB, user, '외국인신청서', '취소', id, { recordNo: row.record_no });
    return json({ ok: true, message: '기록을 취소했습니다.' });
  }

  return json({ ok: false, message: '지원하지 않는 작업입니다.' }, 400);
};
