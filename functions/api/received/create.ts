import {
  authenticateSession,
  clean,
  ensureTables,
  isValidIsoDate,
  json,
  makeDocumentNumber,
  makeReceivedNumber,
  randomHex,
} from '../../_shared/helpers';

interface Env { DB: D1Database; }
type CreatePayload = {
  token?: string;
  direction?: string;
  title?: string;
  counterparty?: string;
  sourceSystem?: string;
  externalDocNumber?: string;
  memo?: string;
  receivedAt?: string;
  department?: string;
  relatedDocumentId?: string;
};

type RelatedDocument = {
  id: string;
  doc_type: string;
  status: string;
  title: string;
  summary: string | null;
  recipient: string | null;
  department: string | null;
  drafter_user_id: string | null;
};

const VALID_DIRECTIONS = ['접수', '외부발송'];

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB) return json({ ok: false, message: 'DB가 연결되지 않았습니다.' }, 500);

  let payload: CreatePayload;
  try { payload = await request.json(); } catch {
    return json({ ok: false, message: '요청 형식이 올바르지 않습니다.' }, 400);
  }

  try {
    await ensureTables(env.DB);
    const auth = await authenticateSession(env.DB, clean(payload.token, 200));
    if (!auth.ok) return json({ ok: false, message: auth.message }, auth.status);

    const direction = clean(payload.direction, 10);
    let title = clean(payload.title, 200);
    let counterparty = clean(payload.counterparty, 120);
    let sourceSystem = clean(payload.sourceSystem, 40);
    const externalDocNumber = clean(payload.externalDocNumber, 100);
    let memo = clean(payload.memo, 3000);
    const receivedAt = clean(payload.receivedAt, 10);
    let department = clean(payload.department, 80);
    let relatedDocumentId = clean(payload.relatedDocumentId, 60);

    if (!VALID_DIRECTIONS.includes(direction)) {
      return json({ ok: false, message: '구분(접수/외부발송)을 선택해 주세요.' }, 400);
    }
    if (!isValidIsoDate(receivedAt)) {
      return json({ ok: false, message: '접수·발송 일자를 정확히 입력해 주세요.' }, 400);
    }

    if (direction === '외부발송' && !relatedDocumentId) {
      return json({ ok: false, message: '발송대기함에서 연결할 내부문서를 선택해 주세요.' }, 400);
    }

    let related: RelatedDocument | null = null;
    if (direction === '외부발송' && relatedDocumentId) {
      related = await env.DB.prepare(`
        SELECT id, doc_type, status, title, summary, recipient, department, CAST(drafter_user_id AS TEXT) AS drafter_user_id
        FROM documents WHERE id = ?
      `).bind(relatedDocumentId).first<RelatedDocument>();
      if (!related) return json({ ok: false, message: '연결할 내부문서를 찾을 수 없습니다.' }, 400);
    }

    if (direction === '외부발송' && related) {
      if (related.doc_type !== '발송') {
        return json({ ok: false, message: '발송문서만 외부발송 기록과 연결할 수 있습니다.' }, 400);
      }
      if (related.status !== '승인') {
        return json({ ok: false, message: '최종 승인되어 발송대기 중인 문서만 선택할 수 있습니다.' }, 400);
      }
      if (auth.user.role !== 'admin' && related.drafter_user_id !== auth.user.id) {
        return json({ ok: false, message: '해당 발송문서의 기안자 또는 관리자만 발송 등록할 수 있습니다.' }, 403);
      }
      const existingLink = await env.DB.prepare(`SELECT registry_id FROM document_dispatch_links WHERE document_id = ?`)
        .bind(related.id).first<{ registry_id: string }>();
      if (existingLink) {
        return json({ ok: false, message: `이미 외부발송대장에 등록된 문서입니다. (${existingLink.registry_id})` }, 400);
      }

      title = title || related.title;
      counterparty = counterparty || clean(related.recipient, 120);
      sourceSystem = sourceSystem || '문서24';
      department = department || clean(related.department, 80);
      memo = memo || `${related.id} 승인문서 외부발송 등록`;
    }

    if (title.length < 2) return json({ ok: false, message: '제목을 2자 이상 입력해 주세요.' }, 400);
    if (!counterparty) {
      return json({ ok: false, message: direction === '접수' ? '발신자를 입력해 주세요.' : '수신자를 입력해 주세요.' }, 400);
    }

    const now = new Date();
    const nowIso = now.toISOString();
    if (direction === '접수') relatedDocumentId = await makeDocumentNumber(env.DB, now);
    const id = await makeReceivedNumber(env.DB, now, direction);
    const finalDepartment = department || auth.user.department || null;

    const statements: D1PreparedStatement[] = [
      env.DB.prepare(`
        INSERT INTO received_documents
          (id, direction, title, counterparty, source_system, external_doc_number, memo, department,
           related_document_id, handled_by, handled_by_user_id, received_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        id,
        direction,
        title,
        counterparty,
        sourceSystem || null,
        externalDocNumber || null,
        memo || null,
        finalDepartment,
        relatedDocumentId || null,
        auth.user.name,
        auth.user.id,
        receivedAt,
        nowIso,
        nowIso,
      ),
    ];

    if (direction === '외부발송' && related) {
      statements.push(
        env.DB.prepare(`
          INSERT INTO document_dispatch_links (document_id, registry_id, created_at)
          VALUES (?, ?, ?)
        `).bind(related.id, id, nowIso),
        env.DB.prepare(`
          UPDATE documents
          SET status = '발송완료', sent_method = ?, sent_at = ?, completed_at = ?, updated_at = ?
          WHERE id = ? AND status = '승인' AND doc_type = '발송'
        `).bind(sourceSystem || '외부발송', nowIso, nowIso, nowIso, related.id),
        env.DB.prepare(`
          INSERT INTO document_approvals
            (id, document_id, action, approver_name, approver_role, memo, created_at)
          VALUES (?, ?, '발송완료', ?, ?, ?, ?)
        `).bind(
          `AP-${randomHex(20)}`,
          related.id,
          auth.user.name,
          auth.user.position || '담당자',
          `접수·발송대장 ${id} 등록 · 발송경로: ${sourceSystem || '외부발송'}`,
          nowIso,
        ),
      );
    }

    await env.DB.batch(statements);
    return json({
      ok: true,
      id,
      linkedDocumentId: related?.id || null,
      documentStatus: direction === '외부발송' && related ? '발송완료' : null,
      message: direction === '외부발송' && related
        ? '외부발송대장에 등록하고 내부문서를 발송완료 처리했습니다.'
        : `접수·발송대장에 등록하고 내부문서 번호 ${relatedDocumentId}을(를) 자동 배정했습니다.`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('received create failed', error);
    if (/UNIQUE constraint failed: document_dispatch_links\.document_id|document_dispatch_links\.document_id/i.test(message)) {
      return json({ ok: false, message: '이미 외부발송대장에 등록된 문서입니다.' }, 400);
    }
    return json({ ok: false, message: '등록 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' }, 500);
  }
};

export const onRequestGet: PagesFunction = async () =>
  json({ ok: false, message: 'POST 방식으로 요청해 주세요.' }, 405);
