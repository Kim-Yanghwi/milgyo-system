import { ALL_CATEGORIES, authenticateSession, clean, ensureTables, json, randomHex, TemplateField } from '../../_shared/helpers';

interface Env { DB: D1Database; }
type Payload = {
  token?: string; id?: string; name?: string; description?: string; docType?: string; category?: string;
  titlePrefix?: string; fields?: unknown; bodyTemplate?: string; active?: boolean;
};
const TYPES = ['text', 'textarea', 'number', 'money', 'date', 'time', 'select', 'checkbox'];

const sanitizeFields = (raw: unknown): TemplateField[] | null => {
  if (!Array.isArray(raw) || raw.length > 30) return null;
  const ids = new Set<string>();
  const fields: TemplateField[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') return null;
    const source = item as Record<string, unknown>;
    const id = clean(source.id, 40).replace(/[^A-Za-z0-9_-]/g, '');
    const label = clean(source.label, 60);
    const type = clean(source.type, 20) as TemplateField['type'];
    if (!id || ids.has(id) || !label || !TYPES.includes(type)) return null;
    ids.add(id);
    const options = Array.isArray(source.options)
      ? source.options.map((value) => clean(value, 60)).filter(Boolean).slice(0, 30)
      : [];
    if (type === 'select' && !options.length) return null;
    fields.push({
      id, label, type, required: !!source.required,
      options: options.length ? options : undefined,
      placeholder: clean(source.placeholder, 120) || undefined,
      defaultValue: clean(source.defaultValue, 120) || undefined,
      width: source.width === 'half' ? 'half' : 'full',
    });
  }
  return fields;
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB) return json({ ok: false, message: 'DB가 연결되지 않았습니다.' }, 500);
  let payload: Payload;
  try { payload = await request.json(); } catch { return json({ ok: false, message: '요청 형식이 올바르지 않습니다.' }, 400); }
  await ensureTables(env.DB);
  const auth = await authenticateSession(env.DB, clean(payload.token, 200));
  if (!auth.ok) return json({ ok: false, message: auth.message }, auth.status);
  if (auth.user.role !== 'admin') return json({ ok: false, message: '서식 관리는 관리자만 할 수 있습니다.' }, 403);

  const id = clean(payload.id, 60) || `TPL-${randomHex(20)}`;
  const name = clean(payload.name, 80);
  const description = clean(payload.description, 300);
  const docType = clean(payload.docType, 10) === '발송' ? '발송' : '기안';
  const category = clean(payload.category, 100);
  const titlePrefix = clean(payload.titlePrefix, 80);
  const bodyTemplate = clean(payload.bodyTemplate, 8000);
  const fields = sanitizeFields(payload.fields);
  if (!name) return json({ ok: false, message: '서식명을 입력해 주세요.' }, 400);
  if (!(ALL_CATEGORIES as readonly string[]).includes(category)) return json({ ok: false, message: '문서분류를 정확히 선택해 주세요.' }, 400);
  if (!fields) return json({ ok: false, message: '서식 항목 구성이 올바르지 않습니다.' }, 400);

  try {
    const existing = await env.DB.prepare(`SELECT id, is_system FROM document_templates WHERE id = ?`).bind(id).first<{ id: string; is_system: number }>();
    if (existing?.is_system) return json({ ok: false, message: '기본 제공 서식은 직접 수정할 수 없습니다. 복사하여 새 서식으로 저장해 주세요.' }, 400);
    const duplicate = await env.DB.prepare(`SELECT id FROM document_templates WHERE name = ? AND id <> ?`).bind(name, id).first();
    if (duplicate) return json({ ok: false, message: '같은 이름의 서식이 이미 있습니다.' }, 400);
    const now = new Date().toISOString();
    await env.DB.prepare(`
      INSERT INTO document_templates
        (id, name, description, doc_type, category, title_prefix, fields_json, body_template, is_system, active, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, description=excluded.description, doc_type=excluded.doc_type, category=excluded.category,
        title_prefix=excluded.title_prefix, fields_json=excluded.fields_json, body_template=excluded.body_template,
        active=excluded.active, updated_at=excluded.updated_at
    `).bind(id, name, description, docType, category, titlePrefix, JSON.stringify(fields), bodyTemplate,
      payload.active === false ? 0 : 1, auth.user.name, now, now).run();
    return json({ ok: true, id, message: '서식이 저장되었습니다.' });
  } catch {
    return json({ ok: false, message: '서식 저장 중 오류가 발생했습니다.' }, 500);
  }
};
export const onRequestGet: PagesFunction = async () => json({ ok: false, message: 'POST 방식으로 요청해 주세요.' }, 405);
