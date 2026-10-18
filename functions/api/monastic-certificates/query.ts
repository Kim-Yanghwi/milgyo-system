import { authenticateSession, getSessionToken, clean, ensureTables, json } from '../../_shared/helpers';
interface Env { DB: D1Database }
type Payload = { operation?: string; query?: string; status?: string; page?: number; pageSize?: number; id?: string };
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB) return json({ ok: false, message: '메인 D1(DB)이 연결되지 않았습니다.' }, 503);
  let p: Payload; try { p = await request.json(); } catch { return json({ ok: false, message: '요청이 잘못됐습니다.' }, 400); }
  await ensureTables(env.DB);
  const auth = await authenticateSession(env.DB, getSessionToken(request));
  if (!auth.ok) return json({ ok: false, code: auth.code, message: auth.message }, auth.status);
  if (auth.user.role !== 'admin') return json({ ok: false, message: '승적증명서 발급대장은 관리자만 열람할 수 있습니다.' }, 403);
  const op = clean(p.operation, 20) || 'list';
  if (op === 'options') {
    const [registry, users] = await env.DB.batch([
      env.DB.prepare(`SELECT id,monastic_no,dharma_name_ko,lay_name,temple,acquired_date,last_verified_date,status FROM monastic_registry WHERE status='재적' ORDER BY dharma_name_ko LIMIT 500`),
      env.DB.prepare(`SELECT CAST(id AS TEXT) AS id,name,position,grade FROM system_users WHERE active=1 AND position IN ('이사장','이사장 직무대리') ORDER BY CASE WHEN position='이사장' THEN 0 ELSE 1 END,name`),
    ]);
    return json({ ok: true, registry: registry.results || [], signatories: users.results || [], me: auth.user, canIssue: true });
  }
  if (op === 'detail') {
    const row = await env.DB.prepare('SELECT * FROM monastic_certificates WHERE id=?').bind(clean(p.id, 80)).first();
    if (!row) return json({ ok: false, message: '발급내역을 찾을 수 없습니다.' }, 404);
    return json({ ok: true, row });
  }
  if (op !== 'list') return json({ ok: false, message: '지원하지 않는 요청입니다.' }, 400);
  const filters: string[] = [], params: string[] = [];
  const status = clean(p.status, 10);
  if (status && !['발급', '취소'].includes(status)) return json({ ok: false, message: '상태값이 올바르지 않습니다.' }, 400);
  if (status) { filters.push('c.status=?'); params.push(status); }
  const query = clean(p.query, 100);
  if (query) {
    filters.push("(c.certificate_no LIKE ? OR json_extract(c.certificate_snapshot,'$.monasticNo') LIKE ? OR json_extract(c.certificate_snapshot,'$.dharmaName') LIKE ? OR c.purpose LIKE ?)");
    params.push(...Array(4).fill(`%${query}%`));
  }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const page = Math.max(1, Math.min(10000, Number(p.page) || 1));
  const pageSize = Math.max(10, Math.min(100, Number(p.pageSize) || 20));
  const from = `FROM monastic_certificates c ${where}`;
  const result = await env.DB.batch([
    env.DB.prepare(`SELECT COUNT(*) AS count ${from}`).bind(...params),
    env.DB.prepare(`SELECT c.id,c.certificate_no,c.issue_date,c.purpose,c.signatory_name,c.status,c.created_at,
      json_extract(c.certificate_snapshot,'$.monasticNo') AS monastic_no,
      json_extract(c.certificate_snapshot,'$.dharmaName') AS dharma_name_ko,
      json_extract(c.certificate_snapshot,'$.temple') AS temple ${from} ORDER BY c.issue_date DESC,c.created_at DESC LIMIT ? OFFSET ?`)
      .bind(...params, pageSize, (page - 1) * pageSize),
  ]);
  const total = Number((result[0].results?.[0] as any)?.count || 0);
  return json({ ok: true, rows: result[1].results || [], page, pageSize, total, pages: Math.max(1, Math.ceil(total / pageSize)) });
};
export const onRequestGet: PagesFunction = async () => json({ ok: false, message: 'POST 요청만 지원합니다.' }, 405);
