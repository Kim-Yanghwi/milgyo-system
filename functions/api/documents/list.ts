import { authenticateSession, clean, ensureTables, isValidIsoDate, json, normalizeDepartmentValue } from '../../_shared/helpers';

interface Env { DB: D1Database; }
type ListPayload = {
  token?: string; view?: string; query?: string; page?: number; pageSize?: number;
  dateFrom?: string; dateTo?: string; docType?: string; category?: string; department?: string; sort?: string;
};

const VIEWS = ['임시저장', '진행', '결재대기', '발송대기', '완료', '반려', '전체'];
const SORTS: Record<string, string> = {
  newest: 'created_at DESC',
  oldest: 'created_at ASC',
  title: 'title ASC',
  updated: 'updated_at DESC',
};
const ACTIVE_STATUSES = "'검토대기','협조대기','결재대기','전결대기'";
const kstDayBoundaryUtc = (dateText: string, dayOffset = 0) => {
  const date = new Date(`${dateText}T00:00:00+09:00`);
  if (Number.isNaN(date.getTime())) return '';
  if (dayOffset) date.setUTCDate(date.getUTCDate() + dayOffset);
  return date.toISOString();
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB) return json({ ok: false, message: 'DB가 연결되지 않았습니다.' }, 500);
  let payload: ListPayload;
  try { payload = await request.json(); } catch { return json({ ok: false, message: '요청 형식이 올바르지 않습니다.' }, 400); }
  await ensureTables(env.DB);
  const auth = await authenticateSession(env.DB, clean(payload.token, 200));
  if (!auth.ok) return json({ ok: false, message: auth.message }, auth.status);
  const me = auth.user;
  const canViewAll = me.role === 'admin' || me.role === 'audit';

  const view = VIEWS.includes(clean(payload.view, 20)) ? clean(payload.view, 20) : '전체';
  const query = clean(payload.query, 100);
  const page = Math.max(1, Math.min(10000, Number(payload.page) || 1));
  const pageSize = Math.max(10, Math.min(100, Number(payload.pageSize) || 20));
  const dateFrom = clean(payload.dateFrom, 10);
  const dateTo = clean(payload.dateTo, 10);
  if (dateFrom && !isValidIsoDate(dateFrom)) return json({ ok: false, message: '조회 시작일이 올바르지 않습니다.' }, 400);
  if (dateTo && !isValidIsoDate(dateTo)) return json({ ok: false, message: '조회 종료일이 올바르지 않습니다.' }, 400);
  if (dateFrom && dateTo && dateFrom > dateTo) return json({ ok: false, message: '조회 시작일은 종료일보다 늦을 수 없습니다.' }, 400);
  const docType = clean(payload.docType, 10);
  const category = clean(payload.category, 100);
  const department = normalizeDepartmentValue(payload.department);
  const orderBy = SORTS[clean(payload.sort, 20)] || SORTS.newest;

  const filters: string[] = [];
  const bindings: unknown[] = [];
  if (view === '임시저장') {
    if (canViewAll) filters.push(`status = '임시저장'`);
    else { filters.push(`status = '임시저장' AND drafter_user_id = ?`); bindings.push(me.id); }
  } else if (view === '진행') {
    filters.push(`status IN (${ACTIVE_STATUSES})`);
    if (!canViewAll) { filters.push(`drafter_user_id = ?`); bindings.push(me.id); }
  } else if (view === '결재대기') {
    if (canViewAll) filters.push(`status IN (${ACTIVE_STATUSES})`);
    else {
      filters.push(`status IN (${ACTIVE_STATUSES}) AND (
        EXISTS (
          SELECT 1 FROM document_approval_lines pending_line
          WHERE pending_line.document_id = documents.id
            AND pending_line.status IN ('대기','예정')
            AND CAST(pending_line.user_id AS TEXT) = ?
            AND NOT EXISTS (
              SELECT 1 FROM document_approval_lines previous_line
              WHERE previous_line.document_id = documents.id
                AND previous_line.line_order < pending_line.line_order
                AND previous_line.status <> '완료'
            )
        )
        OR (
          NOT EXISTS (SELECT 1 FROM document_approval_lines any_line WHERE any_line.document_id = documents.id)
          AND ((status = '검토대기' AND CAST(reviewer_user_id AS TEXT) = ?) OR (status IN ('결재대기','전결대기') AND CAST(approver_user_id AS TEXT) = ?))
        )
      )`);
      bindings.push(me.id, me.id, me.id);
    }
  } else if (view === '발송대기') {
    filters.push(`status = '승인' AND doc_type = '발송'`);
    if (!canViewAll) { filters.push(`drafter_user_id = ?`); bindings.push(me.id); }
  } else if (view === '완료') {
    filters.push(`status IN ('승인','발송완료') AND NOT (status = '승인' AND doc_type = '발송')`);
  } else if (view === '반려') {
    filters.push(`status = '반려'`);
  } else if (view === '전체') {
    filters.push(`status <> '임시저장'`);
  }

  if (!canViewAll) {
    filters.push(`(
      access_scope <> '관련자' OR drafter_user_id = ? OR reviewer_user_id = ? OR approver_user_id = ?
      OR EXISTS (SELECT 1 FROM document_approval_lines access_line WHERE access_line.document_id = documents.id AND access_line.user_id = ?)
    )`);
    bindings.push(me.id, me.id, me.id, me.id);
  }
  if (query) {
    filters.push(`(id LIKE ? OR title LIKE ? OR drafter LIKE ? OR category LIKE ? OR recipient LIKE ? OR department LIKE ?
      OR EXISTS (SELECT 1 FROM document_approval_lines search_line WHERE search_line.document_id = documents.id AND search_line.user_name LIKE ?))`);
    const keyword = `%${query}%`; bindings.push(keyword, keyword, keyword, keyword, keyword, keyword, keyword);
  }
  // created_at은 UTC ISO-8601 문자열입니다. 사용자가 선택한 날짜는 한국시간(KST) 기준 하루로 해석해
  // 00:00~24:00 KST를 UTC 경계값으로 바꾼 뒤 직접 범위 비교하여 인덱스를 활용합니다.
  if (dateFrom) {
    const startUtc = kstDayBoundaryUtc(dateFrom);
    if (startUtc) { filters.push(`created_at >= ?`); bindings.push(startUtc); }
  }
  if (dateTo) {
    const exclusiveEndUtc = kstDayBoundaryUtc(dateTo, 1);
    if (exclusiveEndUtc) { filters.push(`created_at < ?`); bindings.push(exclusiveEndUtc); }
  }
  if (docType && ['기안', '발송'].includes(docType)) { filters.push(`doc_type = ?`); bindings.push(docType); }
  if (category) { filters.push(`category = ?`); bindings.push(category); }
  if (department) {
    const parts = department.split(/\s+-\s+/).map((part) => part.trim()).filter(Boolean);
    if (parts.length > 1) {
      const leaf = parts[parts.length - 1];
      if (leaf === '진향회(향천사)') {
        filters.push(`(department = ? OR department = ? OR department = ? OR department = ?)`);
        bindings.push(department, leaf, '위원회·신도단체 - 신도회', '신도회');
      } else if (leaf === '교무부') {
        // v82에서 잠시 잘못 노출된 '교육부' 저장값도 현행 교무부 조회에 포함합니다.
        filters.push(`(department = ? OR department = ? OR department = ? OR department = ?)`);
        bindings.push(department, leaf, '총무원 - 교육부', '교육부');
      } else {
        filters.push(`(department = ? OR department = ?)`);
        bindings.push(department, leaf);
      }
    } else {
      filters.push(`(department = ? OR department LIKE ?)`);
      bindings.push(department, `${department} - %`);
    }
  }

  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  try {
    const countStatement = env.DB.prepare(`SELECT COUNT(*) AS count FROM documents ${where}`);
    const boundCountStatement = bindings.length ? countStatement.bind(...bindings) : countStatement;
    const offset = (page - 1) * pageSize;
    // 현재 페이지의 문서만 조회하고, 결재선은 문서번호 인덱스를 이용한 소규모 상관조회로 가져옵니다.
    // 페이지 전체 결재선을 먼저 집계하는 CTE 방식보다 D1/SQLite에서 안정적으로 빠릅니다.
    const statement = env.DB.prepare(`
      SELECT id, doc_type, category, title, summary, drafter, drafter_user_id, drafter_position, department,
             recipient, via, approval_track, approval_mode, status, sent_method, sent_at, created_at, updated_at,
             reviewer_name, reviewer_position, reviewer_user_id, approver_name, approver_position, approver_user_id,
             template_id, template_name, access_scope, submitted_at, completed_at,
             COALESCE((SELECT group_concat(user_name, ', ') FROM (
               SELECT user_name FROM document_approval_lines reviewer_lines
               WHERE reviewer_lines.document_id = documents.id AND reviewer_lines.line_type = '검토'
               ORDER BY line_order
             )), reviewer_name, '') AS reviewer_names,
             COALESCE((SELECT group_concat(user_name, ', ') FROM (
               SELECT user_name FROM document_approval_lines cooperator_lines
               WHERE cooperator_lines.document_id = documents.id AND cooperator_lines.line_type = '협조'
               ORDER BY line_order
             )), '') AS cooperator_names,
             (SELECT CAST(current_line.user_id AS TEXT) FROM document_approval_lines current_line
              WHERE current_line.document_id = documents.id
                AND current_line.status IN ('대기','예정')
                AND NOT EXISTS (
                  SELECT 1 FROM document_approval_lines previous_line
                  WHERE previous_line.document_id = documents.id
                    AND previous_line.line_order < current_line.line_order
                    AND previous_line.status <> '완료'
                )
              ORDER BY line_order LIMIT 1) AS current_actor_user_id,
             (SELECT current_line.line_type FROM document_approval_lines current_line
              WHERE current_line.document_id = documents.id
                AND current_line.status IN ('대기','예정')
                AND NOT EXISTS (
                  SELECT 1 FROM document_approval_lines previous_line
                  WHERE previous_line.document_id = documents.id
                    AND previous_line.line_order < current_line.line_order
                    AND previous_line.status <> '완료'
                )
              ORDER BY line_order LIMIT 1) AS current_line_type
      FROM documents ${where}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
    `);
    // 두 SELECT를 D1 batch 한 번으로 보내 네트워크 왕복을 줄입니다.
    const [countResult, result] = await env.DB.batch([
      boundCountStatement,
      statement.bind(...bindings, pageSize, offset),
    ]);
    const countRow = (countResult.results?.[0] || {}) as Record<string, unknown>;
    const total = Number(countRow.count || 0);
    return json({ ok: true, rows: result.results ?? [], total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)), me });
  } catch (error) {
    console.error('document list failed', error);
    return json({ ok: false, message: '문서 목록 조회 중 오류가 발생했습니다.' }, 500);
  }
};
export const onRequestGet: PagesFunction = async () => json({ ok: false, message: 'POST 방식으로 요청해 주세요.' }, 405);
