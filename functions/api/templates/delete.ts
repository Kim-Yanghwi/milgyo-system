import { authenticateSession, clean, ensureTables, json } from '../../_shared/helpers';
interface Env { DB: D1Database; }
type Payload = { token?: string; id?: string };
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB) return json({ ok: false, message: 'DB가 연결되지 않았습니다.' }, 500);
  let payload: Payload;
  try { payload = await request.json(); } catch { return json({ ok: false, message: '요청 형식이 올바르지 않습니다.' }, 400); }
  await ensureTables(env.DB);
  const auth = await authenticateSession(env.DB, clean(payload.token, 200));
  if (!auth.ok) return json({ ok: false, message: auth.message }, auth.status);
  if (auth.user.role !== 'admin') return json({ ok: false, message: '서식 관리는 관리자만 할 수 있습니다.' }, 403);
  const id = clean(payload.id, 60);
  const row = await env.DB.prepare(`SELECT is_system FROM document_templates WHERE id = ?`).bind(id).first<{ is_system: number }>();
  if (!row) return json({ ok: false, message: '서식을 찾을 수 없습니다.' }, 404);
  if (row.is_system) return json({ ok: false, message: '기본 제공 서식은 삭제할 수 없습니다.' }, 400);
  await env.DB.prepare(`UPDATE document_templates SET active = 0, updated_at = ? WHERE id = ?`)
    .bind(new Date().toISOString(), id).run();
  return json({ ok: true, message: '서식 사용이 중지되었습니다.' });
};
export const onRequestGet: PagesFunction = async () => json({ ok: false, message: 'POST 방식으로 요청해 주세요.' }, 405);
