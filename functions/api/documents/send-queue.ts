import { authenticateSession, clean, ensureTables, json } from '../../_shared/helpers';

interface Env { DB: D1Database; }
type Payload = { token?: string };

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB) return json({ ok: false, message: 'DB가 연결되지 않았습니다.' }, 500);

  let payload: Payload;
  try { payload = await request.json(); } catch {
    return json({ ok: false, message: '요청 형식이 올바르지 않습니다.' }, 400);
  }

  try {
    await ensureTables(env.DB);
    const auth = await authenticateSession(env.DB, clean(payload.token, 200));
    if (!auth.ok) return json({ ok: false, message: auth.message }, auth.status);

    const filters = [`d.doc_type = '발송'`, `d.status = '승인'`, `l.document_id IS NULL`];
    const bindings: unknown[] = [];
    if (auth.user.role !== 'admin') {
      filters.push(`d.drafter_user_id = ?`);
      bindings.push(auth.user.id);
    }

    const statement = env.DB.prepare(`
      SELECT d.id, d.title, d.summary, d.body, d.recipient, d.department,
             d.attachments_note, d.drafter, d.created_at, d.updated_at
      FROM documents d
      LEFT JOIN document_dispatch_links l ON l.document_id = d.id
      WHERE ${filters.join(' AND ')}
      ORDER BY d.created_at ASC
      LIMIT 500
    `);
    const rows = bindings.length ? await statement.bind(...bindings).all() : await statement.all();
    return json({ ok: true, rows: rows.results ?? [] });
  } catch (error) {
    console.error('send queue list failed', error);
    return json({ ok: false, message: '발송대기 문서를 불러오는 중 오류가 발생했습니다.' }, 500);
  }
};

export const onRequestGet: PagesFunction = async () =>
  json({ ok: false, message: 'POST 방식으로 요청해 주세요.' }, 405);
