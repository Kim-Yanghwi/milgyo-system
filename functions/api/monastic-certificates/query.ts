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
  // 조직도는 활성 system_users 계정을 표시합니다. 발급권자는 action.ts가 최종 검증합니다.
  const registryColumns = 'id,monastic_no,dharma_name_ko,lay_name,temple,acquired_date,last_verified_date,status';
  if (op === 'options') {
    const [registry, users] = await env.DB.batch([
      env.DB.prepare(`SELECT ${registryColumns} FROM monastic_registry WHERE status='재적' ORDER BY dharma_name_ko,monastic_no LIMIT 51`),
      env.DB.prepare(`SELECT CAST(id AS TEXT) AS id,name,position,grade,department FROM system_users WHERE active=1 ORDER BY name,id`),
    ]);
    const organizationUsers = users.results || [];
    const signatories = organizationUsers.filter((u: any) => ['이사장', '이사장 직무대리'].includes(String(u.position || '').trim()));
    return json({ ok: true, registry: (registry.results || []).slice(0, 50), hasMoreRegistry: (registry.results || []).length > 50,
      organizationUsers, signatories, me: auth.user, canIssue: signatories.length > 0 });
  }
  if (op === 'search-registry') {
    const query = clean(p.query, 100);
    let result: D1Result;
    if (query) {
      // LIKE 특수문자도 문자 그대로 검색하고, 모든 검색값은 바인딩합니다.
      const term = `%${query.replace(/[!%_]/g, (char) => `!${char}`)}%`;
      result = await env.DB.prepare(`SELECT ${registryColumns} FROM monastic_registry WHERE status='재적'
        AND (monastic_no LIKE ? ESCAPE '!' OR dharma_name_ko LIKE ? ESCAPE '!'
          OR lay_name LIKE ? ESCAPE '!' OR temple LIKE ? ESCAPE '!')
        ORDER BY dharma_name_ko,monastic_no LIMIT 51`).bind(term,term,term,term).all();
    } else {
      result = await env.DB.prepare(`SELECT ${registryColumns} FROM monastic_registry WHERE status='재적'
        ORDER BY dharma_name_ko,monastic_no LIMIT 51`).all();
    }
    return json({ ok: true, registry: (result.results || []).slice(0, 50), hasMoreRegistry: (result.results || []).length > 50 });
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
