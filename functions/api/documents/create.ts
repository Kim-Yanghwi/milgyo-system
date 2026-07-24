import {
  ALL_CATEGORIES,
  checkAdminAuthRateLimit,
  clean,
  clearAdminAuthFailures,
  ensureTables,
  json,
  makeDocumentNumber,
  randomHex,
  recordAdminAuthFailure,
  resolveApprovalTrack,
  verifyAdminToken,
} from '../../_shared/helpers';

interface Env {
  DB: D1Database;
  ADMIN_TOKEN: string;
}

type CreatePayload = {
  token?: string;
  docType?: string;             // '기안' | '발송'
  category?: string;
  title?: string;
  body?: string;
  attachmentsNote?: string;
  drafter?: string;
  department?: string;
  recipient?: string;
  approvalTrackChoice?: string; // '이사장결재' | '이사회의결'
};

const VALID_DOC_TYPES = ['기안', '발송'];

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB) return json({ ok: false, message: 'DB가 연결되지 않았습니다.' }, 500);
  if (!env.ADMIN_TOKEN) return json({ ok: false, message: 'ADMIN_TOKEN이 설정되지 않았습니다.' }, 500);

  let payload: CreatePayload;
  try {
    payload = await request.json();
  } catch (error) {
    return json({ ok: false, message: '요청 형식이 올바르지 않습니다.' }, 400);
  }

  const authRateLimit = await checkAdminAuthRateLimit(env.DB, request);
  if (!authRateLimit.ok) return json({ ok: false, message: authRateLimit.message }, 429);

  const token = clean(payload.token, 300);
  if (!(await verifyAdminToken(token, env.ADMIN_TOKEN))) {
    await recordAdminAuthFailure(env.DB, authRateLimit.rateKey);
    return json({ ok: false, message: '관리자 인증값이 올바르지 않습니다.' }, 401);
  }
  await clearAdminAuthFailures(env.DB, authRateLimit.rateKey);

  const docType = clean(payload.docType, 10);
  const category = clean(payload.category, 80);
  const title = clean(payload.title, 200);
  const body = clean(payload.body, 8000);
  const attachmentsNote = clean(payload.attachmentsNote, 400);
  const drafter = clean(payload.drafter, 40);
  const department = clean(payload.department, 60);
  const recipient = clean(payload.recipient, 100);
  const approvalTrackChoice = clean(payload.approvalTrackChoice, 20);

  if (!VALID_DOC_TYPES.includes(docType)) {
    return json({ ok: false, message: '문서구분(기안/발송)을 선택해 주세요.' }, 400);
  }
  if (!(ALL_CATEGORIES as readonly string[]).includes(category)) {
    return json({ ok: false, message: '문서 분류를 정확히 선택해 주세요.' }, 400);
  }
  if (!title || title.length < 2) {
    return json({ ok: false, message: '제목을 2자 이상 입력해 주세요.' }, 400);
  }
  if (!body || body.length < 5) {
    return json({ ok: false, message: '본문을 입력해 주세요.' }, 400);
  }
  if (!drafter) {
    return json({ ok: false, message: '기안자를 입력해 주세요.' }, 400);
  }
  if (docType === '발송' && !recipient) {
    return json({ ok: false, message: '발송문서는 수신처를 입력해 주세요.' }, 400);
  }

  const approvalTrack = resolveApprovalTrack(category, approvalTrackChoice);
  const status = approvalTrack === '전결' ? '승인' : '결재대기';

  try {
    await ensureTables(env.DB);
    const now = new Date();
    const nowIso = now.toISOString();
    const id = await makeDocumentNumber(env.DB, now);

    await env.DB.prepare(`
      INSERT INTO documents (
        id, doc_type, category, title, body, attachments_note, drafter, department, recipient,
        approval_track, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .bind(
        id, docType, category, title, body, attachmentsNote, drafter, department || null,
        recipient || null, approvalTrack, status, nowIso, nowIso,
      )
      .run();

    if (approvalTrack === '전결') {
      await env.DB.prepare(`
        INSERT INTO document_approvals (id, document_id, action, approver_name, approver_role, memo, created_at)
        VALUES (?, ?, '전결처리', ?, '담당자', '규정 제13조④에 따른 전결', ?)
      `)
        .bind(`AP-${randomHex(20)}`, id, drafter, nowIso)
        .run();
    }

    return json({ ok: true, id, status, approvalTrack, message: '문서가 등록되었습니다.' });
  } catch (error) {
    return json({ ok: false, message: '문서 등록 중 오류가 발생했습니다.' }, 500);
  }
};

export const onRequestGet: PagesFunction = async () =>
  json({ ok: false, message: 'POST 방식으로 요청해 주세요.' }, 405);
