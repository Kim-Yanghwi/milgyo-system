import { authenticateSession, getSessionToken, clean, ensureTables, json, randomHex } from '../../_shared/helpers';
import { writeManagementAudit } from '../../_shared/management';
import { normalizeRegistryInput, serializeRegistry, registryFields, nextMonasticSequence, MONASTIC_CHANGE_TYPES, MONASTIC_USER_REF, monasticToday, toRegistryResponse } from '../../_shared/monastic';

interface Env { DB: D1Database }
type Payload = { operation?: string; id?: string; version?: number; content?: unknown; changeType?: string; evidenceNote?: string; approvalNote?: string };
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB) return json({ ok: false, message: '메인 D1(DB)이 연결되지 않았습니다.' }, 503);
  let p: Payload; try { p = await request.json(); } catch { return json({ ok: false, message: '요청 형식이 올바르지 않습니다.' }, 400); }
  await ensureTables(env.DB);
  const auth = await authenticateSession(env.DB, getSessionToken(request));
  if (!auth.ok) return json({ ok: false, code: auth.code, message: auth.message }, auth.status);
  // 승적원부의 신원·종교기록은 모든 변경 작업에서 관리자 권한을 재검증합니다.
  if (auth.user.role !== 'admin') return json({ ok: false, message: '승적원부 등록 및 정정은 관리자만 처리할 수 있습니다.' }, 403);
  const operation = clean(p.operation, 20);
  if (operation !== 'create' && operation !== 'update') return json({ ok: false, message: '지원하지 않는 작업입니다.' }, 400);
  const validated = normalizeRegistryInput(p.content);
  if (!validated.ok) return json({ ok: false, message: validated.message }, 400);
  const v = validated.content;
  // 필드에는 계정의 고유 ID(user:<id>)를 저장합니다. 화면에 보이는 이름은 출력 시 해석합니다.
  // 과거 자유입력값은 해당 원부 수정에서 변경하지 않는 경우에만 보존합니다.
  const original = operation === 'update' ? await env.DB.prepare('SELECT prepared_by,reviewed_by,approved_by FROM monastic_registry WHERE id=?')
    .bind(clean(p.id, 80)).first<Record<string, unknown>>() : null;
  const userFields: Array<[keyof typeof v, string]> = [
    ['preparedBy', 'prepared_by'], ['reviewedBy', 'reviewed_by'], ['approvedBy', 'approved_by'],
  ];
  const userRefs = userFields.map(([key]) => String(v[key] || '')).filter((ref) => MONASTIC_USER_REF.test(ref));
  const uniqueRefs = [...new Set(userRefs.map((ref) => ref.slice(5)))];
  const known = new Set<string>();
  if (uniqueRefs.length) {
    const rows = await env.DB.prepare(`SELECT CAST(id AS TEXT) AS id FROM system_users WHERE active=1 AND CAST(id AS TEXT) IN (${uniqueRefs.map(() => '?').join(',')})`)
      .bind(...uniqueRefs).all<{ id: string }>();
    for (const row of rows.results || []) known.add(row.id);
  }
  for (const [key, column] of userFields) {
    const selected = String(v[key] || '');
    if (!selected) continue;
    if (MONASTIC_USER_REF.test(selected)) {
      // 이미 선택된 비활성 계정은 기존 값 그대로라면 유지; 새로운 계정 선택은 활성 사용자만 가능
      if (!known.has(selected.slice(5)) && String(original?.[column] || '') !== selected) {
        return json({ ok: false, message: '작성·검토·승인자는 현재 활성화된 계정에서 선택해 주세요.' }, 400);
      }
    } else if (String(original?.[column] || '') !== selected) {
      return json({ ok: false, message: '작성·검토·승인자는 등록된 계정을 선택해야 합니다.' }, 400);
    }
  }
  const now = new Date().toISOString();
  const values = serializeRegistry(v);
  if (operation === 'create') {
    const existing = await env.DB.prepare('SELECT id FROM monastic_registry WHERE monastic_no=?').bind(v.monasticNo).first();
    if (existing) return json({ ok: false, message: '이미 등록된 승적번호입니다.' }, 409);
    const id = `MONREG-${randomHex(24)}`;
    const registerNo = await nextMonasticSequence(env.DB, 'REGISTRY', v.firstRegisteredDate);
    const columnList = registryFields.join(',');
    const placeholders = registryFields.map(() => '?').join(',');
    try {
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO monastic_registry(id,register_no,${columnList},created_by_user_id,updated_by_user_id,created_at,updated_at) VALUES(?,?,${placeholders},?,?,?,?)`)
          .bind(id, registerNo, ...values, auth.user.id, auth.user.id, now, now),
        env.DB.prepare(`INSERT INTO monastic_registry_changes(id,registry_id,change_date,change_type,before_json,after_json,evidence_note,approved_by,actor_user_id,actor_name,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
          .bind(`MONCHG-${randomHex(24)}`, id, monasticToday(), '최초 취적', '{}', JSON.stringify(v), clean(p.evidenceNote, 500), v.approvedBy, auth.user.id, auth.user.name, now),
      ]);
    } catch (error) {
      if (String(error).includes('UNIQUE constraint')) return json({ ok: false, message: '승적번호 또는 원부번호가 중복됩니다. 다시 조회해 주세요.' }, 409);
      throw error;
    }
    await writeManagementAudit(env.DB, auth.user, '승적원부', '최초 취적', id, { registerNo, monasticNo: v.monasticNo });
    const row = await env.DB.prepare('SELECT * FROM monastic_registry WHERE id=?').bind(id).first<Record<string, unknown>>();
    return json({ ok: true, row: row ? toRegistryResponse(row) : null, message: `${registerNo} 원부를 등록했습니다.` });
  }
  const id = clean(p.id, 80);
  const version = Number(p.version);
  if (!id || !Number.isSafeInteger(version) || version < 1) return json({ ok: false, message: '수정대상과 데이터 버전이 올바르지 않습니다.' }, 400);
  const changeType = clean(p.changeType, 30);
  if (!MONASTIC_CHANGE_TYPES.includes(changeType as typeof MONASTIC_CHANGE_TYPES[number]) || changeType === '최초 취적') return json({ ok: false, message: '정정 처리 구분을 선택해 주세요.' }, 400);
  const evidenceNote = clean(p.evidenceNote, 500);
  if (!evidenceNote) return json({ ok: false, message: '원부 정정 근거 및 승인 내용을 기록해 주세요.' }, 400);
  const prior = await env.DB.prepare('SELECT * FROM monastic_registry WHERE id=?').bind(id).first<Record<string, unknown>>();
  if (!prior) return json({ ok: false, message: '승적원부를 찾을 수 없습니다.' }, 404);
  if (Number(prior.version) !== version) return json({ ok: false, message: '다른 사용자가 먼저 수정했습니다. 원부를 다시 조회해 주세요.' }, 409);
  if (String(prior.monastic_no) !== v.monasticNo) return json({ ok: false, message: '승적번호는 변경할 수 없습니다. 관리자에게 별도 정정 절차를 문의하세요.' }, 400);
  const assignments = registryFields.map((f) => `${f}=?`).join(',');
  const before = Object.fromEntries(registryFields.map((f) => [f, prior[f]]));
  const after = Object.fromEntries(registryFields.map((f, i) => [f, values[i]]));
  try {
    const batch = await env.DB.batch([
      env.DB.prepare(`UPDATE monastic_registry SET ${assignments},version=version+1,updated_by_user_id=?,updated_at=? WHERE id=? AND version=?`)
        .bind(...values, auth.user.id, now, id, version),
      env.DB.prepare(`INSERT INTO monastic_registry_changes(id,registry_id,change_date,change_type,before_json,after_json,evidence_note,approved_by,actor_user_id,actor_name,created_at)
        SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM monastic_registry WHERE id=? AND version=? AND updated_at=?)`)
        .bind(`MONCHG-${randomHex(24)}`, id, monasticToday(), changeType, JSON.stringify(before), JSON.stringify(after), evidenceNote, v.approvedBy, auth.user.id, auth.user.name, now, id, version + 1, now),
    ]);
    if (Number(batch[0].meta?.changes) !== 1 || Number(batch[1].meta?.changes) !== 1) return json({ ok: false, message: '다른 요청이 먼저 처리됐습니다. 다시 조회해 주세요.' }, 409);
  } catch (error) {
    if (String(error).includes('UNIQUE constraint')) return json({ ok: false, message: '중복된 승적번호입니다.' }, 409);
    throw error;
  }
  await writeManagementAudit(env.DB, auth.user, '승적원부', changeType, id, { registerNo: prior.register_no, evidenceNote: '내부 변경 이력에 보존' });
  const updated = await env.DB.prepare('SELECT * FROM monastic_registry WHERE id=?').bind(id).first<Record<string, unknown>>();
  return json({ ok: true, row: updated ? toRegistryResponse(updated) : null, message: '승적원부 정정 및 변경 이력을 저장했습니다.' });
};
export const onRequestGet: PagesFunction = async () => json({ ok: false, message: 'POST 요청만 지원합니다.' }, 405);
