import { authenticateSession, getSessionToken, clean, ensureTables, json } from '../../_shared/helpers';
import { toRegistryResponse, MONASTIC_STATUSES } from '../../_shared/monastic';
interface Env { DB: D1Database }
type Payload = { operation?: string; id?: string; query?: string; status?: string; page?: number; pageSize?: number };
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB) return json({ ok: false, message: '메인 D1(DB)이 연결되지 않았습니다.' }, 503);
  let p: Payload; try { p = await request.json(); } catch { return json({ ok: false, message: '요청 형식이 올바르지 않습니다.' }, 400); }
  await ensureTables(env.DB);
  const auth = await authenticateSession(env.DB, getSessionToken(request));
  if (!auth.ok) return json({ ok: false, code: auth.code, message: auth.message }, auth.status);
  if (auth.user.role !== 'admin') return json({ ok: false, message: '승적원부 열람은 관리자만 가능합니다.' }, 403);
  const op = clean(p.operation, 20) || 'list';
  if (op === 'options') {
    // 개인정보·종교 기록의 결재자 선택용: 관리자에게 최소한의 계정 정보만 제공합니다.
    const users = await env.DB.prepare(`SELECT CAST(id AS TEXT) AS id,name,position,active FROM system_users ORDER BY active DESC,name,id`).all();
    return json({ ok: true, me: auth.user, canManage: true, statuses: MONASTIC_STATUSES, users: users.results || [] });
  }
  if (op === 'detail') {
    const id = clean(p.id, 80);
    const results = await env.DB.batch([
      env.DB.prepare('SELECT * FROM monastic_registry WHERE id=?').bind(id),
      env.DB.prepare(`SELECT id,change_date,change_type,before_json,after_json,evidence_note,approved_by,actor_name,created_at FROM monastic_registry_changes WHERE registry_id=? ORDER BY created_at DESC LIMIT 100`).bind(id),
      env.DB.prepare(`SELECT id,file_name,mime_type,size_bytes,evidence_type,issuing_authority,verified_date,created_at FROM monastic_registry_attachments WHERE registry_id=? ORDER BY created_at DESC`).bind(id),
    ]);
    const row = results[0].results?.[0] as Record<string, unknown> | undefined;
    if (!row) return json({ ok: false, message: '승적원부를 찾을 수 없습니다.' }, 404);
    const changes = (results[1].results || []).map((item: any) => ({
      id: item.id, changeDate: item.change_date, changeType: item.change_type,
      // 정정 이력 전체는 담당자가 상세 조회할 때만 전달합니다.
      before: JSON.parse(String(item.before_json || '{}')),
      after: JSON.parse(String(item.after_json || '{}')),
      evidenceNote: item.evidence_note, approvedBy: item.approved_by, actorName: item.actor_name,
    }));
    return json({ ok: true, row: toRegistryResponse(row), changes, attachments: results[2].results || [] });
  }
  if (op !== 'list') return json({ ok: false, message: '지원하지 않는 조회입니다.' }, 400);
  const status = clean(p.status, 10);
  if (status && !MONASTIC_STATUSES.includes(status as typeof MONASTIC_STATUSES[number])) return json({ ok: false, message: '상태값이 올바르지 않습니다.' }, 400);
  const query = clean(p.query, 100);
  const params: string[] = [], filters: string[] = [];
  if (status) { filters.push('status=?'); params.push(status); }
  if (query) { filters.push('(register_no LIKE ? OR monastic_no LIKE ? OR dharma_name_ko LIKE ? OR dharma_name_hanja LIKE ? OR temple LIKE ?)'); params.push(...Array(5).fill(`%${query}%`)); }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const page = Math.max(1, Math.min(10000, Number(p.page) || 1));
  const pageSize = Math.max(10, Math.min(100, Number(p.pageSize) || 20));
  const results = await env.DB.batch([
    env.DB.prepare(`SELECT COUNT(*) AS count FROM monastic_registry ${where}`).bind(...params),
    env.DB.prepare(`SELECT id,register_no,monastic_no,dharma_name_ko,status,temple,acquired_date,last_verified_date,version,updated_at,
      (SELECT COUNT(*) FROM monastic_registry_attachments a WHERE a.registry_id=monastic_registry.id) AS attachment_count
      FROM monastic_registry ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`).bind(...params, pageSize, (page - 1) * pageSize),
  ]);
  const total = Number((results[0].results?.[0] as any)?.count || 0);
  return json({ ok: true, rows: results[1].results || [], total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)) });
};
export const onRequestGet: PagesFunction = async () => json({ ok: false, message: 'POST 요청만 지원합니다.' }, 405);
