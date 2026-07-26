import { authenticateSession, clean, ensureTables, json } from '../../_shared/helpers';

interface Env { DB: D1Database; FILES?: R2Bucket; }
type Payload = { token?: string };
const ACTIVE_STATUSES = "'검토대기','협조대기','결재대기','전결대기'";

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB) return json({ ok: false, message: 'DB가 연결되지 않았습니다.' }, 500);
  let payload: Payload;
  try { payload = await request.json(); } catch { return json({ ok: false, message: '요청 형식이 올바르지 않습니다.' }, 400); }

  await ensureTables(env.DB);
  const auth = await authenticateSession(env.DB, clean(payload.token, 200));
  if (!auth.ok) return json({ ok: false, message: auth.message }, auth.status);
  const me = auth.user;

  const canViewAll = me.role === 'admin' || me.role === 'audit';
  const visibilitySql = canViewAll
    ? '1=1'
    : `(access_scope <> '관련자' OR drafter_user_id = ? OR reviewer_user_id = ? OR approver_user_id = ?
       OR EXISTS (SELECT 1 FROM document_approval_lines access_line WHERE access_line.document_id = documents.id AND access_line.user_id = ?))`;
  const visibilityBindings = canViewAll ? [] : [me.id, me.id, me.id, me.id];

  const countQueries: Array<{ key: string; sql: string; values: unknown[] }> = [
    { key: 'draft', sql: canViewAll ? `SELECT COUNT(*) AS count FROM documents WHERE status='임시저장'` : `SELECT COUNT(*) AS count FROM documents WHERE status='임시저장' AND drafter_user_id=?`, values: canViewAll ? [] : [me.id] },
    { key: 'progress', sql: canViewAll ? `SELECT COUNT(*) AS count FROM documents WHERE status IN (${ACTIVE_STATUSES})` : `SELECT COUNT(*) AS count FROM documents WHERE status IN (${ACTIVE_STATUSES}) AND drafter_user_id=?`, values: canViewAll ? [] : [me.id] },
    {
      key: 'pending',
      sql: canViewAll
        ? `SELECT COUNT(*) AS count FROM documents WHERE status IN (${ACTIVE_STATUSES})`
        : `SELECT COUNT(*) AS count FROM documents WHERE status IN (${ACTIVE_STATUSES}) AND (
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
            OR (NOT EXISTS (SELECT 1 FROM document_approval_lines any_line WHERE any_line.document_id = documents.id)
                AND ((status='검토대기' AND CAST(reviewer_user_id AS TEXT)=?) OR (status IN ('결재대기','전결대기') AND CAST(approver_user_id AS TEXT)=?)))
          )`,
      values: canViewAll ? [] : [me.id, me.id, me.id],
    },
    {
      key: 'send',
      sql: `SELECT COUNT(*) AS count FROM documents WHERE status='승인' AND doc_type='발송' AND ${visibilitySql}`,
      values: [...visibilityBindings],
    },
    {
      key: 'complete',
      sql: `SELECT COUNT(*) AS count FROM documents WHERE status IN ('승인','발송완료') AND NOT (status='승인' AND doc_type='발송') AND ${visibilitySql}`,
      values: [...visibilityBindings],
    },
    { key: 'received', sql: `SELECT COUNT(*) AS count FROM received_documents`, values: [] },
  ];

  try {
    const statements = countQueries.map(({ sql, values }) => {
      const statement = env.DB.prepare(sql);
      return values.length ? statement.bind(...values) : statement;
    });
    const recentDocumentsStatement = env.DB.prepare(`
      SELECT id, doc_type, title, status, drafter, department, created_at, updated_at
      FROM documents
      WHERE status <> '임시저장' AND ${visibilitySql}
      ORDER BY updated_at DESC LIMIT 8
    `);
    statements.push(visibilityBindings.length
      ? recentDocumentsStatement.bind(...visibilityBindings)
      : recentDocumentsStatement);
    statements.push(env.DB.prepare(`
      SELECT id, direction, title, counterparty, received_at
      FROM received_documents ORDER BY created_at DESC LIMIT 6
    `));

    // 홈 수량과 최근 목록을 한 번의 D1 batch로 조회해 원격 DB 왕복을 최소화합니다.
    const results = await env.DB.batch(statements);
    const counts: Record<string, number> = {};
    countQueries.forEach((query, index) => {
      const row = (results[index]?.results?.[0] || {}) as Record<string, unknown>;
      counts[query.key] = Number(row.count || 0);
    });
    const recentDocuments = results[countQueries.length]?.results ?? [];
    const recentRegistry = results[countQueries.length + 1]?.results ?? [];

    return json({
      ok: true,
      counts,
      recentDocuments,
      recentRegistry,
      storage: { r2Connected: !!env.FILES },
    });
  } catch (error) {
    console.error('dashboard summary failed', error);
    return json({ ok: false, message: '홈 화면 정보를 불러오는 중 오류가 발생했습니다.' }, 500);
  }
};

export const onRequestGet: PagesFunction = async () => json({ ok: false, message: 'POST 방식으로 요청해 주세요.' }, 405);
