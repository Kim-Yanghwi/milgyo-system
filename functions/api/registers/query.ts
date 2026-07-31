import { authenticateSession, clean, ensureTables, json } from '../../_shared/helpers';
import { isRegisterType, REGISTER_TYPES } from '../../_shared/management';

interface Env { DB: D1Database; }
type Payload = { token?: string; operation?: string; type?: string; scope?: string; status?: string; query?: string; dateFrom?: string; dateTo?: string; page?: number; pageSize?: number; id?: string };

const parseContent = <T>(value: unknown, fallback: T): T => {
  try { return value ? JSON.parse(String(value)) as T : fallback; } catch { return fallback; }
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB) return json({ ok: false, message: 'DB가 연결되지 않았습니다.' }, 500);
  let payload: Payload;
  try { payload = await request.json(); } catch { return json({ ok: false, message: '요청 형식이 올바르지 않습니다.' }, 400); }
  await ensureTables(env.DB);
  const auth = await authenticateSession(env.DB, clean(payload.token, 200));
  if (!auth.ok) return json({ ok: false, message: auth.message }, auth.status);

  const operation = clean(payload.operation, 20) || 'list';
  if (operation === 'options') {
    return json({ ok: true, types: REGISTER_TYPES, me: auth.user, canManage: auth.user.role === 'admin', canWrite: auth.user.role !== 'audit' });
  }
  if (operation === 'detail') {
    const id = clean(payload.id, 80);
    const row = await env.DB.prepare(`SELECT * FROM management_registers WHERE id=?`).bind(id).first<Record<string, unknown>>();
    if (!row) return json({ ok: false, message: '대장 신청내역을 찾을 수 없습니다.' }, 404);
    const attachments = await env.DB.prepare(`SELECT id,file_name,mime_type,size_bytes,storage_type,created_at FROM management_register_attachments WHERE register_id=? ORDER BY created_at`)
      .bind(id).all();
    return json({ ok: true, row: { ...row, content: parseContent(row.content_json, {}) }, attachments: attachments.results || [], me: auth.user, canManage: auth.user.role === 'admin' });
  }

  const type = clean(payload.type, 40);
  if (type && !isRegisterType(type)) return json({ ok: false, message: '대장 유형이 올바르지 않습니다.' }, 400);
  const page = Math.max(1, Math.min(10000, Number(payload.page) || 1));
  const pageSize = Math.max(10, Math.min(100, Number(payload.pageSize) || 20));
  const filters: string[] = [];
  const bindings: unknown[] = [];
  if (type) { filters.push('record_type=?'); bindings.push(type); }
  if (clean(payload.scope, 10) === 'mine') { filters.push('applicant_user_id=?'); bindings.push(auth.user.id); }
  const status = clean(payload.status, 20);
  if (status) { filters.push('status=?'); bindings.push(status); }
  const query = clean(payload.query, 100);
  if (query) {
    const keyword = `%${query}%`;
    filters.push('(request_no LIKE ? OR title LIKE ? OR applicant_name LIKE ? OR applicant_department LIKE ?)');
    bindings.push(keyword, keyword, keyword, keyword);
  }
  const dateFrom = clean(payload.dateFrom, 10);
  const dateTo = clean(payload.dateTo, 10);
  if (dateFrom) { filters.push('request_date>=?'); bindings.push(dateFrom); }
  if (dateTo) { filters.push('request_date<=?'); bindings.push(dateTo); }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const offset = (page - 1) * pageSize;
  try {
    const [countResult, rowsResult] = await env.DB.batch([
      (bindings.length ? env.DB.prepare(`SELECT COUNT(*) AS count FROM management_registers ${where}`).bind(...bindings) : env.DB.prepare(`SELECT COUNT(*) AS count FROM management_registers ${where}`)),
      env.DB.prepare(`
        SELECT id,request_no,record_type,title,applicant_name,applicant_department,status,request_date,processed_by,processed_at,processing_memo,content_json,created_at,updated_at,
          (SELECT COUNT(*) FROM management_register_attachments a WHERE a.register_id=management_registers.id) AS attachment_count
        FROM management_registers ${where}
        ORDER BY request_date DESC, created_at DESC LIMIT ? OFFSET ?
      `).bind(...bindings, pageSize, offset),
    ]);
    const total = Number((countResult.results?.[0] as Record<string, unknown> | undefined)?.count || 0);
    const rows = (rowsResult.results || []).map((row: any) => ({ ...row, content: parseContent(row.content_json, {}) }));
    return json({ ok: true, rows, total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)), me: auth.user, canManage: auth.user.role === 'admin' });
  } catch (error) {
    console.error('register query failed', error);
    return json({ ok: false, message: '대장 목록 조회 중 오류가 발생했습니다.' }, 500);
  }
};

export const onRequestGet: PagesFunction = async () => json({ ok: false, message: 'POST 방식으로 요청해 주세요.' }, 405);
