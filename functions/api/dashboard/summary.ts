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

  const visibilitySql = me.role === 'admin'
    ? '1=1'
    : `(access_scope <> '관련자' OR drafter_user_id = ? OR reviewer_user_id = ? OR approver_user_id = ?
       OR EXISTS (SELECT 1 FROM document_approval_lines access_line WHERE access_line.document_id = documents.id AND access_line.user_id = ?))`;
  const visibilityBindings = me.role === 'admin' ? [] : [me.id, me.id, me.id, me.id];

  const countQueries: Array<{ key: string; sql: string; values: unknown[] }> = [
    { key: 'draft', sql: `SELECT COUNT(*) AS count FROM documents WHERE status='임시저장' AND drafter_user_id=?`, values: [me.id] },
    { key: 'progress', sql: `SELECT COUNT(*) AS count FROM documents WHERE status IN (${ACTIVE_STATUSES}) AND drafter_user_id=?`, values: [me.id] },
    {
      key: 'pending',
      sql: me.role === 'admin'
        ? `SELECT COUNT(*) AS count FROM documents WHERE status IN (${ACTIVE_STATUSES})`
        : `SELECT COUNT(*) AS count FROM documents WHERE
            EXISTS (SELECT 1 FROM document_approval_lines pending_line WHERE pending_line.document_id = documents.id AND pending_line.status='대기' AND pending_line.user_id=?)
            OR (NOT EXISTS (SELECT 1 FROM document_approval_lines any_line WHERE any_line.document_id = documents.id)
                AND ((status='검토대기' AND reviewer_user_id=?) OR (status IN ('결재대기','전결대기') AND approver_user_id=?)))`,
      values: me.role === 'admin' ? [] : [me.id, me.id, me.id],
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
    const countResults = await env.DB.batch(statements);
    const counts: Record<string, number> = {};
    countQueries.forEach((query, index) => {
      const row = (countResults[index]?.results?.[0] || {}) as Record<string, unknown>;
      counts[query.key] = Number(row.count || 0);
    });

    const recentDocumentsStatement = env.DB.prepare(`
      SELECT id, doc_type, title, status, drafter, department, created_at, updated_at
      FROM documents
      WHERE status <> '임시저장' AND ${visibilitySql}
      ORDER BY updated_at DESC LIMIT 8
    `);
    const recentDocuments = visibilityBindings.length
      ? await recentDocumentsStatement.bind(...visibilityBindings).all()
      : await recentDocumentsStatement.all();

    const recentRegistry = await env.DB.prepare(`
      SELECT id, direction, title, counterparty, received_at
      FROM received_documents ORDER BY created_at DESC LIMIT 6
    `).all();

    return json({
      ok: true,
      counts,
      recentDocuments: recentDocuments.results ?? [],
      recentRegistry: recentRegistry.results ?? [],
      storage: { r2Connected: !!env.FILES },
    });
  } catch (error) {
    console.error('dashboard summary failed', error);
    return json({ ok: false, message: '홈 화면 정보를 불러오는 중 오류가 발생했습니다.' }, 500);
  }
};

export const onRequestGet: PagesFunction = async () => json({ ok: false, message: 'POST 방식으로 요청해 주세요.' }, 405);
