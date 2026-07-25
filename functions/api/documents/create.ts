import {
  ALL_CATEGORIES,
  authenticateSession,
  clean,
  ensureTables,
  json,
  makeDocumentNumber,
  randomHex,
  resolveApprovalTrack,
} from '../../_shared/helpers';

interface Env { DB: D1Database; }

type CreatePayload = {
  token?: string;
  documentId?: string;
  clientRequestId?: string;
  saveAsDraft?: boolean;
  docType?: string;
  category?: string;
  title?: string;
  summary?: string;
  body?: string;
  attachmentsNote?: string;
  department?: string;
  recipient?: string;
  via?: string;
  approvalTrackChoice?: string;
  reviewerUserId?: string;
  approverUserId?: string;
  templateId?: string;
  templateName?: string;
  formData?: unknown;
  accessScope?: string;
};

const VALID_DOC_TYPES = ['기안', '발송'];
const VALID_ACCESS_SCOPES = ['전체', '관련자'];

const sanitizeFormData = (raw: unknown) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>).slice(0, 50)) {
    const safeKey = clean(key, 40).replace(/[^A-Za-z0-9_-]/g, '');
    if (!safeKey) continue;
    output[safeKey] = clean(value, 4000);
  }
  return output;
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB) return json({ ok: false, message: 'DB가 연결되지 않았습니다.' }, 500);
  let payload: CreatePayload;
  try { payload = await request.json(); } catch { return json({ ok: false, message: '요청 형식이 올바르지 않습니다.' }, 400); }

  await ensureTables(env.DB);
  const auth = await authenticateSession(env.DB, clean(payload.token, 200));
  if (!auth.ok) return json({ ok: false, message: auth.message }, auth.status);
  const me = auth.user;

  const saveAsDraft = !!payload.saveAsDraft;
  const documentId = clean(payload.documentId, 60);
  const clientRequestId = clean(payload.clientRequestId, 80) || null;
  let docType = clean(payload.docType, 10);
  let category = clean(payload.category, 100);
  const title = clean(payload.title, 200);
  const summary = clean(payload.summary, 400);
  const body = clean(payload.body, 12000);
  const attachmentsNote = clean(payload.attachmentsNote, 800);
  const department = clean(payload.department, 80);
  const recipient = clean(payload.recipient, 120);
  const via = clean(payload.via, 120);
  const approvalTrackChoice = clean(payload.approvalTrackChoice, 20);
  const reviewerUserId = clean(payload.reviewerUserId, 60);
  const approverUserId = clean(payload.approverUserId, 60);
  const templateId = clean(payload.templateId, 60);
  let templateName = clean(payload.templateName, 100);
  const formData = sanitizeFormData(payload.formData);
  const accessScope = VALID_ACCESS_SCOPES.includes(clean(payload.accessScope, 20)) ? clean(payload.accessScope, 20) : '전체';

  if (templateId) {
    const template = await env.DB.prepare(`SELECT name, doc_type, category, fields_json FROM document_templates WHERE id = ? AND active = 1`)
      .bind(templateId).first<{ name: string; doc_type: string; category: string; fields_json: string }>();
    if (!template) return json({ ok: false, message: '선택한 문서 서식을 찾을 수 없거나 사용이 중지되었습니다.' }, 400);
    templateName = template.name;
    docType = template.doc_type;
    category = template.category;
    try {
      const fields = JSON.parse(template.fields_json || '[]') as Array<{ id?: string; label?: string; required?: boolean }>;
      if (!saveAsDraft) {
        const missing = fields.filter((field) => field.required && !clean(formData[field.id || ''], 4000)).map((field) => field.label || field.id || '필수항목');
        if (missing.length) return json({ ok: false, message: `서식 필수항목을 입력해 주세요: ${missing.join(', ')}` }, 400);
      }
    } catch {
      return json({ ok: false, message: '선택한 서식의 입력항목 설정이 올바르지 않습니다.' }, 500);
    }
  }

  if (!VALID_DOC_TYPES.includes(docType)) return json({ ok: false, message: '문서구분(기안/발송)을 선택해 주세요.' }, 400);
  if (!(ALL_CATEGORIES as readonly string[]).includes(category)) return json({ ok: false, message: '문서 분류를 정확히 선택해 주세요.' }, 400);
  if (!saveAsDraft) {
    if (!title || title.length < 2) return json({ ok: false, message: '제목을 2자 이상 입력해 주세요.' }, 400);
    if (!body || body.length < 5) return json({ ok: false, message: '본문을 입력해 주세요.' }, 400);
    if (docType === '발송' && !recipient) return json({ ok: false, message: '발송문서는 수신처를 입력해 주세요.' }, 400);
  }

  let existing: any = null;
  if (documentId) {
    existing = await env.DB.prepare(`SELECT * FROM documents WHERE id = ?`).bind(documentId).first();
    if (!existing) return json({ ok: false, message: '수정할 임시저장 문서를 찾을 수 없습니다.' }, 404);
    if (existing.status !== '임시저장') return json({ ok: false, message: '임시저장 상태의 문서만 수정·상신할 수 있습니다.' }, 400);
    if (me.role !== 'admin' && existing.drafter_user_id !== me.id) return json({ ok: false, message: '본인이 작성한 임시문서만 수정할 수 있습니다.' }, 403);
  }

  if (clientRequestId && !documentId) {
    const duplicate = await env.DB.prepare(`SELECT id, status FROM documents WHERE client_request_id = ?`).bind(clientRequestId).first();
    if (duplicate) return json({ ok: true, id: (duplicate as any).id, status: (duplicate as any).status, duplicate: true, message: '이미 등록된 요청입니다.' });
  }

  const approvalTrack = resolveApprovalTrack(category, approvalTrackChoice);
  let reviewerName: string | null = null;
  let reviewerPosition: string | null = null;
  if (reviewerUserId && approvalTrack !== '전결') {
    const reviewer = await env.DB.prepare(`SELECT name, position FROM system_users WHERE id = ? AND active = 1`)
      .bind(reviewerUserId).first<{ name: string; position: string | null }>();
    if (!reviewer) return json({ ok: false, message: '지정한 검토자를 찾을 수 없습니다.' }, 400);
    if (reviewerUserId === me.id && !saveAsDraft) return json({ ok: false, message: '기안자 본인을 검토자로 지정할 수 없습니다.' }, 400);
    reviewerName = reviewer.name;
    reviewerPosition = reviewer.position;
  }

  let approverName: string | null = null;
  let approverPosition: string | null = null;
  let resolvedApproverUserId: string | null = null;
  if (approvalTrack === '전결') {
    approverName = me.name;
    approverPosition = me.position;
  } else if (approverUserId) {
    const approver = await env.DB.prepare(`SELECT name, position, can_approve FROM system_users WHERE id = ? AND active = 1`)
      .bind(approverUserId).first<{ name: string; position: string | null; can_approve: number }>();
    if (!approver) return json({ ok: false, message: '지정한 결재자를 찾을 수 없습니다.' }, 400);
    if (!approver.can_approve) return json({ ok: false, message: '결재권이 없는 계정입니다.' }, 400);
    if (reviewerUserId && reviewerUserId === approverUserId) return json({ ok: false, message: '검토자와 최종 결재자는 서로 다르게 지정해 주세요.' }, 400);
    approverName = approver.name;
    approverPosition = approver.position;
    resolvedApproverUserId = approverUserId;
  } else if (!saveAsDraft) {
    return json({ ok: false, message: '중요문서는 최종 결재자를 지정해 주세요.' }, 400);
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const status = saveAsDraft ? '임시저장' : approvalTrack === '전결' ? '승인' : reviewerUserId ? '검토대기' : '결재대기';
  const submittedAt = saveAsDraft ? null : nowIso;
  const completedAt = status === '승인' ? nowIso : null;

  try {
    const id = documentId || await makeDocumentNumber(env.DB, now);
    if (documentId) {
      await env.DB.prepare(`
        UPDATE documents SET
          doc_type=?, category=?, title=?, summary=?, body=?, attachments_note=?,
          reviewer_user_id=?, reviewer_name=?, reviewer_position=?, approver_user_id=?, approver_name=?, approver_position=?,
          department=?, recipient=?, via=?, approval_track=?, status=?, template_id=?, template_name=?, form_data_json=?,
          access_scope=?, client_request_id=COALESCE(client_request_id, ?), submitted_at=?, completed_at=?, updated_at=?
        WHERE id=?
      `).bind(
        docType, category, title || '(제목 미입력)', summary, body, attachmentsNote,
        reviewerUserId || null, reviewerName, reviewerPosition, resolvedApproverUserId, approverName, approverPosition,
        department || null, recipient || null, via || null, approvalTrack, status, templateId || null, templateName || null,
        JSON.stringify(formData), accessScope, clientRequestId, submittedAt, completedAt, nowIso, id,
      ).run();
      await env.DB.prepare(`DELETE FROM document_approvals WHERE document_id = ? AND action = '임시저장'`).bind(id).run();
    } else {
      await env.DB.prepare(`
        INSERT INTO documents (
          id, doc_type, category, title, summary, body, attachments_note,
          drafter, drafter_user_id, drafter_position,
          reviewer_user_id, reviewer_name, reviewer_position,
          approver_user_id, approver_name, approver_position,
          department, recipient, via, approval_track, status,
          template_id, template_name, form_data_json, access_scope, client_request_id,
          submitted_at, completed_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        id, docType, category, title || '(제목 미입력)', summary, body, attachmentsNote,
        me.name, me.id, me.position || null,
        reviewerUserId || null, reviewerName, reviewerPosition,
        resolvedApproverUserId, approverName, approverPosition,
        department || me.department || null, recipient || null, via || null, approvalTrack, status,
        templateId || null, templateName || null, JSON.stringify(formData), accessScope, clientRequestId,
        submittedAt, completedAt, nowIso, nowIso,
      ).run();
    }

    if (saveAsDraft) {
      await env.DB.prepare(`
        INSERT INTO document_approvals (id, document_id, action, approver_name, approver_role, memo, created_at)
        VALUES (?, ?, '임시저장', ?, ?, NULL, ?)
      `).bind(`AP-${randomHex(20)}`, id, me.name, me.position || '기안자', nowIso).run();
    } else if (approvalTrack === '전결') {
      await env.DB.prepare(`
        INSERT INTO document_approvals (id, document_id, action, approver_name, approver_role, memo, created_at)
        VALUES (?, ?, '전결처리', ?, ?, '규정 제13조④에 따른 전결', ?)
      `).bind(`AP-${randomHex(20)}`, id, me.name, me.position || '담당자', nowIso).run();
    } else {
      await env.DB.prepare(`
        INSERT INTO document_approvals (id, document_id, action, approver_name, approver_role, memo, created_at)
        VALUES (?, ?, '상신', ?, ?, ?, ?)
      `).bind(`AP-${randomHex(20)}`, id, me.name, me.position || '기안자', reviewerUserId ? '검토자에게 상신' : '최종 결재자에게 상신', nowIso).run();
    }

    return json({ ok: true, id, status, approvalTrack, message: saveAsDraft ? '임시저장되었습니다.' : '문서가 상신되었습니다.' });
  } catch (error) {
    return json({ ok: false, message: '문서 저장 중 오류가 발생했습니다.' }, 500);
  }
};

export const onRequestGet: PagesFunction = async () => json({ ok: false, message: 'POST 방식으로 요청해 주세요.' }, 405);
