import { authenticateSession, clean, ensureTables, isValidIsoDate, json } from '../../_shared/helpers';

interface Env { DB: D1Database; }
type Payload = {
  token?: string;
  operation?: string;
  query?: string;
  status?: string;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  pageSize?: number;
  id?: string;
};

const DEFAULTS = {
  teacherName: '睡翁 眞妙',
  preceptorName: '東翁 呑析',
  witnessName: 'LAMA WANGDA',
  organizationName: '大韓佛敎 密敎宗',
  templeName: '香天寺',
  issuerName: '睡翁 眞妙',
  closingText: '合掌',
  includeTopSeal: true,
  topSealKey: 'hyangcheonsa',
};

const maskBirthDate = (value: unknown) => {
  const raw = String(value || '');
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw.slice(0, 8)}**` : raw;
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB) return json({ ok: false, message: 'DB가 연결되지 않았습니다.' }, 500);
  let payload: Payload;
  try { payload = await request.json(); }
  catch { return json({ ok: false, message: '요청 형식이 올바르지 않습니다.' }, 400); }

  await ensureTables(env.DB);
  const auth = await authenticateSession(env.DB, clean(payload.token, 200));
  if (!auth.ok) return json({ ok: false, message: auth.message }, auth.status);
  if (auth.user.role !== 'admin' && auth.user.role !== 'audit') {
    return json({ ok: false, message: '수계증서 발급대장 열람 권한이 없습니다.' }, 403);
  }

  const operation = clean(payload.operation, 20) || 'list';
  if (operation === 'options') {
    return json({
      ok: true,
      canIssue: auth.user.role === 'admin',
      canManage: auth.user.role === 'admin',
      defaults: DEFAULTS,
      me: auth.user,
    });
  }

  if (operation === 'detail') {
    const id = clean(payload.id, 80);
    const row = await env.DB.prepare('SELECT * FROM ordination_certificates WHERE id=?').bind(id).first<any>();
    if (!row) return json({ ok: false, message: '수계증서 발급내역을 찾을 수 없습니다.' }, 404);
    let snapshot: Record<string, unknown> | null = null;
    try { snapshot = JSON.parse(String(row.certificate_snapshot || '{}')); } catch {}
    return json({ ok: true, row: { ...row, snapshot }, canManage: auth.user.role === 'admin', me: auth.user });
  }

  const page = Math.max(1, Math.min(10000, Number(payload.page) || 1));
  const pageSize = Math.max(10, Math.min(100, Number(payload.pageSize) || 20));
  const filters: string[] = [];
  const binds: unknown[] = [];
  const query = clean(payload.query, 100);
  if (query) {
    const keyword = `%${query}%`;
    filters.push('(certificate_no LIKE ? OR recipient_name LIKE ? OR dharma_name_hanja LIKE ? OR dharma_name_korean LIKE ?)');
    binds.push(keyword, keyword, keyword, keyword);
  }
  const status = clean(payload.status, 20);
  if (status) { filters.push('status=?'); binds.push(status); }
  const dateFrom = clean(payload.dateFrom, 10);
  const dateTo = clean(payload.dateTo, 10);
  if (dateFrom) {
    if (!isValidIsoDate(dateFrom)) return json({ ok: false, message: '조회 시작일이 올바르지 않습니다.' }, 400);
    filters.push('ordination_date>=?'); binds.push(dateFrom);
  }
  if (dateTo) {
    if (!isValidIsoDate(dateTo)) return json({ ok: false, message: '조회 종료일이 올바르지 않습니다.' }, 400);
    filters.push('ordination_date<=?'); binds.push(dateTo);
  }
  if (dateFrom && dateTo && dateFrom > dateTo) return json({ ok: false, message: '조회 시작일은 종료일보다 늦을 수 없습니다.' }, 400);

  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const offset = (page - 1) * pageSize;
  try {
    const [countResult, rowsResult] = await env.DB.batch([
      binds.length
        ? env.DB.prepare(`SELECT COUNT(*) AS count FROM ordination_certificates ${where}`).bind(...binds)
        : env.DB.prepare(`SELECT COUNT(*) AS count FROM ordination_certificates ${where}`),
      env.DB.prepare(`
        SELECT id,certificate_no,recipient_name,birth_calendar,birth_date,dharma_name_hanja,dharma_name_korean,
               ordination_date,buddhist_year,teacher_name,preceptor_name,witness_name,status,issued_by_name,
               issued_at,canceled_at,cancel_reason,created_at
        FROM ordination_certificates ${where}
        ORDER BY ordination_date DESC, sequence_no DESC, created_at DESC
        LIMIT ? OFFSET ?
      `).bind(...binds, pageSize, offset),
    ]);
    const total = Number((countResult.results?.[0] as any)?.count || 0);
    const rows = (rowsResult.results || []).map((row: any) => ({ ...row, birth_date_masked: maskBirthDate(row.birth_date), birth_date: undefined }));
    return json({
      ok: true, rows, total, page, pageSize,
      pages: Math.max(1, Math.ceil(total / pageSize)),
      canManage: auth.user.role === 'admin', me: auth.user,
    });
  } catch (error) {
    console.error('ordination certificate query failed', error);
    return json({ ok: false, message: '수계증서 발급대장 조회 중 오류가 발생했습니다.' }, 500);
  }
};

export const onRequestGet: PagesFunction = async () => json({ ok: false, message: 'POST 방식으로 요청해 주세요.' }, 405);
