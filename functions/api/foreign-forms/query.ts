import { authenticateSession, clean, ensureTables, json } from '../../_shared/helpers';
import { ensureForeignFormTables, isForeignFormType } from '../../_shared/foreign-forms';

interface Env { DB: D1Database; }

const canReadAll = (role: string) => role === 'admin' || role === 'audit';

const parseSnapshot = (value: unknown) => {
  try { return JSON.parse(String(value || '{}')); } catch { return {}; }
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB) return json({ ok: false, message: 'D1(DB) 바인딩이 필요합니다.' }, 503);
  await ensureTables(env.DB);
  await ensureForeignFormTables(env.DB);

  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const auth = await authenticateSession(env.DB, clean(body.token, 160));
  if (!auth.ok) return json({ ok: false, message: auth.message }, auth.status);
  const user = auth.user;

  const mode = clean(body.mode, 20) || 'list';
  if (mode === 'detail') {
    const id = clean(body.id, 80);
    if (!id) return json({ ok: false, message: '기록 ID가 필요합니다.' }, 400);
    const row = await env.DB.prepare(`SELECT * FROM foreign_application_forms WHERE id=? LIMIT 1`).bind(id).first<Record<string, unknown>>();
    if (!row) return json({ ok: false, message: '기록을 찾을 수 없습니다.' }, 404);
    if (!canReadAll(user.role) && String(row.created_by_user_id || '') !== user.id) {
      return json({ ok: false, message: '이 기록을 열람할 권한이 없습니다.' }, 403);
    }
    return json({ ok: true, row: { ...row, snapshot: parseSnapshot(row.snapshot_json), snapshot_json: undefined } });
  }

  const page = Math.max(1, Math.min(100000, Number(body.page) || 1));
  const size = Math.max(10, Math.min(100, Number(body.size) || 20));
  const formType = clean(body.formType, 40);
  const status = clean(body.status, 20);
  const query = clean(body.query, 120);
  const from = clean(body.from, 10);
  const to = clean(body.to, 10);

  const clauses: string[] = [];
  const bindings: unknown[] = [];
  if (!canReadAll(user.role)) {
    clauses.push('created_by_user_id=?');
    bindings.push(user.id);
  }
  if (formType && isForeignFormType(formType)) {
    clauses.push('form_type=?');
    bindings.push(formType);
  }
  if (status) {
    clauses.push('status=?');
    bindings.push(status);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(from)) {
    clauses.push("date(datetime(created_at,'+9 hours'))>=date(?)");
    bindings.push(from);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    clauses.push("date(datetime(created_at,'+9 hours'))<=date(?)");
    bindings.push(to);
  }
  if (query) {
    clauses.push('(record_no LIKE ? OR subject_name LIKE ? OR nationality LIKE ? OR created_by_name LIKE ?)');
    const like = `%${query.replace(/[%_]/g, '')}%`;
    bindings.push(like, like, like, like);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const totalRow = await env.DB.prepare(`SELECT COUNT(*) AS count FROM foreign_application_forms ${where}`)
    .bind(...bindings).first<{ count?: number }>();
  const total = Number(totalRow?.count || 0);
  const pages = Math.max(1, Math.ceil(total / size));
  const safePage = Math.min(page, pages);
  const offset = (safePage - 1) * size;

  const result = await env.DB.prepare(`
    SELECT id,record_no,form_type,subject_name,nationality,status,created_by_name,
           created_at,updated_at,last_printed_at,last_downloaded_at,print_count,download_count
    FROM foreign_application_forms
    ${where}
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).bind(...bindings, size, offset).all<Record<string, unknown>>();

  return json({
    ok: true,
    rows: result.results || [],
    pagination: { page: safePage, pages, size, total },
    canManageAll: user.role === 'admin',
    canAudit: user.role === 'admin' || user.role === 'audit',
  });
};
