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

interface Env {
  DB: D1Database;
}

type CreatePayload = {
  token?: string;
  docType?: string;             // '기안' | '발송'
  category?: string;            // 문서분류(온나라의 "과제카드명" 역할 겸용)
  title?: string;
  summary?: string;             // 문서요지
  body?: string;
  attachmentsNote?: string;
  department?: string;
  recipient?: string;
  via?: string;                 // 경유
  approvalTrackChoice?: string; // '이사장결재' | '이사회의결'
  reviewerUserId?: string;
  approverUserId?: string;
};

const VALID_DOC_TYPES = ['기안', '발송'];

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB) return json({ ok: false, message: 'DB가 연결되지 않았습니다.' }, 500);

  let payload: CreatePayload;
  try {
    payload = await request.json();
  } catch (error) {
    return json({ ok: false, message: '요청 형식이 올바르지 않습니다.' }, 400);
  }

  await ensureTables(env.DB);
  const auth = await authenticateSession(env.DB, clean(payload.token, 200));
  if (!auth.ok) return json({ ok: false, message: auth.message }, auth.status);
  const me = auth.user;

  const docType = clean(payload.docType, 10);
  const category = clean(payload.category, 80);
  const title = clean(payload.title, 200);
  const summary = clean(payload.summary, 400);
  const body = clean(payload.body, 8000);
  const attachmentsNote = clean(payload.attachmentsNote, 400);
  const department = clean(payload.department, 60);
  const recipient = clean(payload.recipient, 100);
  const via = clean(payload.via, 100);
  const approvalTrackChoice = clean(payload.approvalTrackChoice, 20);
  const reviewerUserId = clean(payload.reviewerUserId, 60);
  const approverUserId = clean(payload.approverUserId, 60);

  if (!VALID_DOC_TYPES.includes(docType)) {
    return json({ ok: false, message: '문서구분(기안/발송)을 선택해 주세요.' }, 400);
  }
  if (!(ALL_CATEGORIES as readonly string[]).includes(category)) {
    return json({ ok: false, message: '문서 분류(과제카드명)를 정확히 선택해 주세요.' }, 400);
  }
  if (!title || title.length < 2) {
    return json({ ok: false, message: '제목을 2자 이상 입력해 주세요.' }, 400);
  }
  if (!body || body.length < 5) {
    return json({ ok: false, message: '본문을 입력해 주세요.' }, 400);
  }
  if (docType === '발송' && !recipient) {
    return json({ ok: false, message: '발송문서는 수신처를 입력해 주세요.' }, 400);
  }

  const approvalTrack = resolveApprovalTrack(category, approvalTrackChoice);

  let reviewerName: string | null = null;
  let reviewerPosition: string | null = null;
  if (reviewerUserId) {
    const reviewer = await env.DB.prepare(`SELECT name, position FROM system_users WHERE id = ? AND active = 1`)
      .bind(reviewerUserId).first<{ name: string; position: string | null }>();
    if (!reviewer) return json({ ok: false, message: '지정한 검토자를 찾을 수 없습니다.' }, 400);
    reviewerName = reviewer.name;
    reviewerPosition = reviewer.position;
  }

  let approverName: string;
  let approverPosition: string | null;
  let resolvedApproverUserId: string | null = null;

  if (approvalTrack === '전결') {
    // 전결(경미한 문서)은 기안자 본인이 즉시 처리한다(제13조④).
    approverName = me.name;
    approverPosition = me.position;
  } else {
    if (!approverUserId) {
      return json({ ok: false, message: '중요문서는 결재자를 지정해 주세요(제13조②).' }, 400);
    }
    const approver = await env.DB.prepare(
      `SELECT name, position, can_approve FROM system_users WHERE id = ? AND active = 1`,
    ).bind(approverUserId).first<{ name: string; position: string | null; can_approve: number }>();
    if (!approver) return json({ ok: false, message: '지정한 결재자를 찾을 수 없습니다.' }, 400);
    if (!approver.can_approve) {
      return json({ ok: false, message: '결재권이 없는 계정입니다. 계정관리에서 결재권자로 지정해 주세요.' }, 400);
    }
    approverName = approver.name;
    approverPosition = approver.position;
    resolvedApproverUserId = approverUserId;
  }

  const status = approvalTrack === '전결' ? '승인' : '결재대기';

  try {
    const now = new Date();
    const nowIso = now.toISOString();
    const id = await makeDocumentNumber(env.DB, now);

    await env.DB.prepare(`
      INSERT INTO documents (
        id, doc_type, category, title, summary, body, attachments_note,
        drafter, drafter_user_id, drafter_position,
        reviewer_user_id, reviewer_name, reviewer_position,
        approver_user_id, approver_name, approver_position,
        department, recipient, via, approval_track, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .bind(
        id, docType, category, title, summary, body, attachmentsNote,
        me.name, me.id, me.position || null,
        reviewerUserId || null, reviewerName, reviewerPosition,
        resolvedApproverUserId, approverName, approverPosition,
        department || null, recipient || null, via || null, approvalTrack, status, nowIso, nowIso,
      )
      .run();

    if (approvalTrack === '전결') {
      await env.DB.prepare(`
        INSERT INTO document_approvals (id, document_id, action, approver_name, approver_role, memo, created_at)
        VALUES (?, ?, '전결처리', ?, ?, '규정 제13조④에 따른 전결', ?)
      `)
        .bind(`AP-${randomHex(20)}`, id, me.name, me.position || '담당자', nowIso)
        .run();
    }

    return json({ ok: true, id, status, approvalTrack, message: '문서가 등록되었습니다.' });
  } catch (error) {
    return json({ ok: false, message: '문서 등록 중 오류가 발생했습니다.' }, 500);
  }
};

export const onRequestGet: PagesFunction = async () =>
  json({ ok: false, message: 'POST 방식으로 요청해 주세요.' }, 405);
