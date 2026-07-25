import {
  ALL_CATEGORIES,
  IMPORTANT_CATEGORIES,
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
  approvalMode?: string;
  reviewerUserId?: string;
  reviewerUserIds?: unknown;
  cooperatorUserIds?: unknown;
  approverUserId?: string;
  templateId?: string;
  templateName?: string;
  formData?: unknown;
  accessScope?: string;
};

type ApprovalLineInput = {
  lineType: '검토' | '협조' | '결재' | '전결';
  userId: string;
  userName: string;
  userPosition: string | null;
};

type UserRow = { id: string; name: string; position: string | null; can_approve: number; active: number };

const VALID_DOC_TYPES = ['기안', '발송'];
const VALID_ACCESS_SCOPES = ['전체', '관련자'];
const VALID_APPROVAL_MODES = ['결재', '전결'];
const MAX_PEOPLE_PER_ROLE = 10;

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

const sanitizeIdList = (raw: unknown, fallback?: string) => {
  const values = Array.isArray(raw) ? raw : fallback ? [fallback] : [];
  return values
    .map((value) => clean(value, 60))
    .filter((value, index, array) => value && array.indexOf(value) === index);
};

const statusForLineType = (lineType: ApprovalLineInput['lineType']) => {
  if (lineType === '검토') return '검토대기';
  if (lineType === '협조') return '협조대기';
  if (lineType === '전결') return '전결대기';
  return '결재대기';
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
  const reviewerUserIds = sanitizeIdList(payload.reviewerUserIds, clean(payload.reviewerUserId, 60));
  const cooperatorUserIds = sanitizeIdList(payload.cooperatorUserIds);
  if (reviewerUserIds.length > MAX_PEOPLE_PER_ROLE || cooperatorUserIds.length > MAX_PEOPLE_PER_ROLE) {
    return json({ ok: false, message: `검토자와 협조자는 각각 최대 ${MAX_PEOPLE_PER_ROLE}명까지 지정할 수 있습니다.` }, 400);
  }
  let approverUserId = clean(payload.approverUserId, 60);
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

  const isImportant = (IMPORTANT_CATEGORIES as readonly string[]).includes(category);
  const requestedMode = clean(payload.approvalMode, 10);
  const approvalMode = VALID_APPROVAL_MODES.includes(requestedMode) ? requestedMode : (isImportant ? '결재' : '전결');
  const approvalTrack = approvalMode === '전결'
    ? '전결'
    : isImportant ? resolveApprovalTrack(category, approvalTrackChoice) : '일반결재';

  if (approvalMode === '전결' && !approverUserId) approverUserId = me.id;

  const allSelectedIds = [...reviewerUserIds, ...cooperatorUserIds, ...(approverUserId ? [approverUserId] : [])];
  if (new Set(allSelectedIds).size !== allSelectedIds.length) {
    return json({ ok: false, message: '검토자·협조자·최종 처리자는 서로 다르게 지정해 주세요.' }, 400);
  }
  if (!saveAsDraft && reviewerUserIds.includes(me.id)) return json({ ok: false, message: '기안자 본인을 검토자로 지정할 수 없습니다.' }, 400);
  if (!saveAsDraft && cooperatorUserIds.includes(me.id)) return json({ ok: false, message: '기안자 본인을 협조자로 지정할 수 없습니다.' }, 400);
  if (!saveAsDraft && approvalMode === '결재' && approverUserId === me.id) return json({ ok: false, message: '기안자 본인을 결재자로 지정할 수 없습니다. 본인 처리 문서는 전결을 선택해 주세요.' }, 400);
  if (!saveAsDraft && !approverUserId) return json({ ok: false, message: `${approvalMode}자를 지정해 주세요.` }, 400);

  const userMap = new Map<string, UserRow>();
  if (allSelectedIds.length) {
    const placeholders = allSelectedIds.map(() => '?').join(',');
    const users = await env.DB.prepare(`SELECT CAST(id AS TEXT) AS id, name, position, can_approve, active FROM system_users WHERE id IN (${placeholders})`)
      .bind(...allSelectedIds).all<UserRow>();
    for (const user of users.results ?? []) userMap.set(user.id, user);
    const missing = allSelectedIds.filter((id) => !userMap.get(id)?.active);
    if (missing.length) return json({ ok: false, message: '선택한 검토자·협조자·처리자 중 사용 중지되었거나 찾을 수 없는 계정이 있습니다.' }, 400);
  }

  const finalApprover = approverUserId ? userMap.get(approverUserId) : undefined;
  if (approverUserId && !finalApprover) return json({ ok: false, message: `지정한 ${approvalMode}자를 찾을 수 없습니다.` }, 400);
  if (!saveAsDraft && finalApprover && !finalApprover.can_approve && !(approvalMode === '전결' && finalApprover.id === me.id)) {
    return json({ ok: false, message: `${approvalMode}권이 없는 계정입니다. 계정관리에서 결재권을 부여해 주세요.` }, 400);
  }

  const lines: ApprovalLineInput[] = [];
  reviewerUserIds.forEach((id) => {
    const user = userMap.get(id);
    if (user) lines.push({ lineType: '검토', userId: user.id, userName: user.name, userPosition: user.position });
  });
  cooperatorUserIds.forEach((id) => {
    const user = userMap.get(id);
    if (user) lines.push({ lineType: '협조', userId: user.id, userName: user.name, userPosition: user.position });
  });
  if (finalApprover) lines.push({
    lineType: approvalMode as '결재' | '전결',
    userId: finalApprover.id,
    userName: finalApprover.name,
    userPosition: finalApprover.position,
  });

  const firstReviewer = lines.find((line) => line.lineType === '검토');
  const now = new Date();
  const nowIso = now.toISOString();
  const status = saveAsDraft ? '임시저장' : statusForLineType(lines[0].lineType);
  const submittedAt = saveAsDraft ? null : nowIso;

  try {
    const id = documentId || await makeDocumentNumber(env.DB, now);
    const statements: D1PreparedStatement[] = [];
    if (documentId) {
      statements.push(env.DB.prepare(`
        UPDATE documents SET
          doc_type=?, category=?, title=?, summary=?, body=?, attachments_note=?,
          reviewer_user_id=?, reviewer_name=?, reviewer_position=?, approver_user_id=?, approver_name=?, approver_position=?,
          department=?, recipient=?, via=?, approval_track=?, approval_mode=?, status=?, template_id=?, template_name=?, form_data_json=?,
          access_scope=?, client_request_id=COALESCE(client_request_id, ?), submitted_at=?, completed_at=NULL, updated_at=?
        WHERE id=?
      `).bind(
        docType, category, title || '(제목 미입력)', summary, body, attachmentsNote,
        firstReviewer?.userId || null, firstReviewer?.userName || null, firstReviewer?.userPosition || null,
        finalApprover?.id || null, finalApprover?.name || null, finalApprover?.position || null,
        department || null, recipient || null, via || null, approvalTrack, approvalMode, status,
        templateId || null, templateName || null, JSON.stringify(formData), accessScope, clientRequestId,
        submittedAt, nowIso, id,
      ));
      statements.push(env.DB.prepare(`DELETE FROM document_approvals WHERE document_id = ? AND action = '임시저장'`).bind(id));
      statements.push(env.DB.prepare(`DELETE FROM document_approval_lines WHERE document_id = ?`).bind(id));
    } else {
      statements.push(env.DB.prepare(`
        INSERT INTO documents (
          id, doc_type, category, title, summary, body, attachments_note,
          drafter, drafter_user_id, drafter_position,
          reviewer_user_id, reviewer_name, reviewer_position,
          approver_user_id, approver_name, approver_position,
          department, recipient, via, approval_track, approval_mode, status,
          template_id, template_name, form_data_json, access_scope, client_request_id,
          submitted_at, completed_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
      `).bind(
        id, docType, category, title || '(제목 미입력)', summary, body, attachmentsNote,
        me.name, me.id, me.position || null,
        firstReviewer?.userId || null, firstReviewer?.userName || null, firstReviewer?.userPosition || null,
        finalApprover?.id || null, finalApprover?.name || null, finalApprover?.position || null,
        department || me.department || null, recipient || null, via || null, approvalTrack, approvalMode, status,
        templateId || null, templateName || null, JSON.stringify(formData), accessScope, clientRequestId,
        submittedAt, nowIso, nowIso,
      ));
    }

    lines.forEach((line, index) => {
      statements.push(env.DB.prepare(`
        INSERT INTO document_approval_lines
          (id, document_id, line_order, line_type, user_id, user_name, user_position, status, acted_at, memo, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
      `).bind(
        `AL-${randomHex(20)}`, id, index + 1, line.lineType, line.userId, line.userName, line.userPosition,
        !saveAsDraft && index === 0 ? '대기' : '예정', nowIso,
      ));
    });

    if (saveAsDraft) {
      statements.push(env.DB.prepare(`
        INSERT INTO document_approvals (id, document_id, action, approver_name, approver_role, memo, created_at)
        VALUES (?, ?, '임시저장', ?, ?, NULL, ?)
      `).bind(`AP-${randomHex(20)}`, id, me.name, me.position || '기안자', nowIso));
    } else {
      const firstLineLabel = lines[0].lineType === '검토' ? '검토자' : lines[0].lineType === '협조' ? '협조자' : `${lines[0].lineType}자`;
      statements.push(env.DB.prepare(`
        INSERT INTO document_approvals (id, document_id, action, approver_name, approver_role, memo, created_at)
        VALUES (?, ?, '상신', ?, ?, ?, ?)
      `).bind(`AP-${randomHex(20)}`, id, me.name, me.position || '기안자', `${firstLineLabel}에게 상신`, nowIso));
    }

    await env.DB.batch(statements);
    return json({
      ok: true,
      id,
      status,
      approvalTrack,
      approvalMode,
      message: saveAsDraft ? '임시저장되었습니다.' : `문서가 ${lines[0].lineType} 단계로 상신되었습니다.`,
    });
  } catch (error) {
    console.error('document create failed', error);
    return json({ ok: false, message: '문서 저장 중 오류가 발생했습니다.' }, 500);
  }
};

export const onRequestGet: PagesFunction = async () => json({ ok: false, message: 'POST 방식으로 요청해 주세요.' }, 405);
