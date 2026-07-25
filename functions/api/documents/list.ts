import { authenticateSession, clean, ensureTables, json } from '../../_shared/helpers';

interface Env { DB: D1Database; }
type ListPayload = {
  token?: string; view?: string; query?: string; page?: number; pageSize?: number;
  dateFrom?: string; dateTo?: string; docType?: string; category?: string; sort?: string;
};

const VIEWS = ['임시저장', '진행', '결재대기', '발송대기', '완료', '반려', '전체'];
const SORTS: Record<string, string> = {
  newest: 'created_at DESC', oldest: 'created_at ASC', title: 'title ASC', updated: 'updated_at DESC',
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB) return json({ ok: false, message: 'DB가 연결되지 않았습니다.' }, 500);
  let payload: ListPayload;
  try { payload = await request.json(); } catch { return json({ ok: false, message: '요청 형식이 올바르지 않습니다.' }, 400); }
  await ensureTables(env.DB);
  const auth = await authenticateSession(env.DB, clean(payload.token, 200));
  if (!auth.ok) return json({ ok: false, message: auth.message }, auth.status);
  const me = auth.user;

  const view = VIEWS.includes(clean(payload.view, 20)) ? clean(payload.view, 20) : '전체';
  const query = clean(payload.query, 100);
  const page = Math.max(1, Math.min(10000, Number(payload.page) || 1));
  const pageSize = Math.max(10, Math.min(100, Number(payload.pageSize) || 20));
  const dateFrom = clean(payload.dateFrom, 10);
  const dateTo = clean(payload.dateTo, 10);
  const docType = clean(payload.docType, 10);
  const category = clean(payload.category, 100);
  const orderBy = SORTS[clean(payload.sort, 20)] || SORTS.newest;

  const filters: string[] = [];
  const bindings: unknown[] = [];
  if (view === '임시저장') {
    filters.push(`status = '임시저장' AND drafter_user_id = ?`); bindings.push(me.id);
  } else if (view === '진행') {
    filters.push(`status IN ('검토대기','결재대기') AND drafter_user_id = ?`); bindings.push(me.id);
  } else if (view === '결재대기') {
    if (me.role === 'admin') filters.push(`status IN ('검토대기','결재대기')`);
    else {
      filters.push(`((status = '검토대기' AND reviewer_user_id = ?) OR (status = '결재대기' AND approver_user_id = ?))`);
      bindings.push(me.id, me.id);
    }
  } else if (view === '발송대기') {
    filters.push(`status = '승인' AND doc_type = '발송'`);
    if (me.role !== 'admin') { filters.push(`drafter_user_id = ?`); bindings.push(me.id); }
  } else if (view === '완료') {
    filters.push(`status IN ('승인','발송완료') AND NOT (status = '승인' AND doc_type = '발송')`);
  } else if (view === '반려') {
    filters.push(`status = '반려'`);
  } else if (view === '전체') {
    filters.push(`status <> '임시저장'`);
  }

  if (me.role !== 'admin') {
    filters.push(`(access_scope <> '관련자' OR drafter_user_id = ? OR reviewer_user_id = ? OR approver_user_id = ?)`);
    bindings.push(me.id, me.id, me.id);
  }
  if (query) {
    filters.push(`(id LIKE ? OR title LIKE ? OR drafter LIKE ? OR category LIKE ? OR recipient LIKE ? OR department LIKE ?)`);
    const keyword = `%${query}%`; bindings.push(keyword, keyword, keyword, keyword, keyword, keyword);
  }
  if (dateFrom) { filters.push(`substr(created_at,1,10) >= ?`); bindings.push(dateFrom); }
  if (dateTo) { filters.push(`substr(created_at,1,10) <= ?`); bindings.push(dateTo); }
  if (docType && ['기안', '발송'].includes(docType)) { filters.push(`doc_type = ?`); bindings.push(docType); }
  if (category) { filters.push(`category = ?`); bindings.push(category); }

  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  try {
    const countStatement = env.DB.prepare(`SELECT COUNT(*) AS count FROM documents ${where}`);
    const countRow = bindings.length
      ? await countStatement.bind(...bindings).first<{ count: number }>()
      : await countStatement.first<{ count: number }>();
    const total = Number(countRow?.count || 0);
    const offset = (page - 1) * pageSize;
    const statement = env.DB.prepare(`
      SELECT id, doc_type, category, title, summary, drafter, drafter_user_id, drafter_position, department,
             recipient, via, approval_track, status, sent_method, sent_at, created_at, updated_at,
             reviewer_name, reviewer_position, reviewer_user_id, approver_name, approver_position, approver_user_id,
             template_id, template_name, access_scope, submitted_at, completed_at
      FROM documents ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?
    `);
    const result = await statement.bind(...bindings, pageSize, offset).all();
    return json({ ok: true, rows: result.results ?? [], total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)), me });
  } catch {
    return json({ ok: false, message: '문서 목록 조회 중 오류가 발생했습니다.' }, 500);
  }
};
export const onRequestGet: PagesFunction = async () => json({ ok: false, message: 'POST 방식으로 요청해 주세요.' }, 405);
