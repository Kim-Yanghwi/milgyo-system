import { authenticateSession, clean, ensureTables, json } from '../../_shared/helpers';

interface Env { DB: D1Database; }
type Payload = { token?: string; includeInactive?: boolean };

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB) return json({ ok: false, message: 'DB가 연결되지 않았습니다.' }, 500);
  let payload: Payload;
  try { payload = await request.json(); } catch { return json({ ok: false, message: '요청 형식이 올바르지 않습니다.' }, 400); }
  await ensureTables(env.DB);
  const auth = await authenticateSession(env.DB, clean(payload.token, 200));
  if (!auth.ok) return json({ ok: false, message: auth.message }, auth.status);
  const includeInactive = !!payload.includeInactive && auth.user.role === 'admin';
  try {
    const rows = await env.DB.prepare(`
      SELECT id, name, description, doc_type, category, title_prefix, fields_json, body_template,
             is_system, active, created_by, created_at, updated_at
      FROM document_templates
      ${includeInactive ? '' : 'WHERE active = 1'}
      ORDER BY is_system DESC, name ASC
    `).all();
    return json({ ok: true, rows: (rows.results ?? []).map((row: any) => ({
      ...row,
      fields: (() => { try { return JSON.parse(row.fields_json || '[]'); } catch { return []; } })(),
    })) });
  } catch {
    return json({ ok: false, message: '서식 목록 조회 중 오류가 발생했습니다.' }, 500);
  }
};
export const onRequestGet: PagesFunction = async () => json({ ok: false, message: 'POST 방식으로 요청해 주세요.' }, 405);
