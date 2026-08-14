import { authenticateSession, clean, ensureTables, isValidIsoDate, json, normalizeDepartmentValue } from '../../_shared/helpers';

interface Env { DB: D1Database; }
type Payload = {
  token?: string;
  id?: string;
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
const VALID_DIRECTIONS = ['접수', '외부발송'];

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB) return json({ ok: false, message: 'DB가 연결되지 않았습니다.' }, 500);
  let payload: Payload;
  try { payload = await request.json(); } catch {
    return json({ ok: false, message: '요청 형식이 올바르지 않습니다.' }, 400);
  }

  try {
    await ensureTables(env.DB);
    const auth = await authenticateSession(env.DB, clean(payload.token, 200));
    if (!auth.ok) return json({ ok: false, message: auth.message }, auth.status);

    const id = clean(payload.id, 60);
    const direction = clean(payload.direction, 10);
    const title = clean(payload.title, 200);
    const counterparty = clean(payload.counterparty, 120);
    const sourceSystem = clean(payload.sourceSystem, 40);
    const externalDocNumber = clean(payload.externalDocNumber, 100);
    const memo = clean(payload.memo, 3000);
    const receivedAt = clean(payload.receivedAt, 10);
    const department = normalizeDepartmentValue(payload.department, auth.user.position || '');
    const relatedDocumentId = clean(payload.relatedDocumentId, 60);

    if (!id) return json({ ok: false, message: '등록번호가 필요합니다.' }, 400);
    if (!VALID_DIRECTIONS.includes(direction)) return json({ ok: false, message: '구분을 선택해 주세요.' }, 400);
    if (title.length < 2) return json({ ok: false, message: '제목을 2자 이상 입력해 주세요.' }, 400);
    if (!counterparty) {
      return json({ ok: false, message: direction === '접수' ? '발신자를 입력해 주세요.' : '수신자를 입력해 주세요.' }, 400);
    }
    if (!isValidIsoDate(receivedAt)) {
      return json({ ok: false, message: '접수·발송 일자를 정확히 입력해 주세요.' }, 400);
    }

    const existing = await env.DB.prepare(`
      SELECT id, direction, related_document_id, CAST(handled_by_user_id AS TEXT) AS handled_by_user_id
      FROM received_documents WHERE id = ?
    `).bind(id).first<{
      id: string;
      direction: string;
      related_document_id: string | null;
      handled_by_user_id: string | null;
    }>();
    if (!existing) return json({ ok: false, message: '수정할 대장 문서를 찾을 수 없습니다.' }, 404);
    if (auth.user.role !== 'admin' && existing.handled_by_user_id !== auth.user.id) {
      return json({ ok: false, message: '등록자 또는 관리자만 수정할 수 있습니다.' }, 403);
    }
    if (existing.direction !== direction) {
      return json({ ok: false, message: '접수·외부발송 구분은 수정할 수 없습니다. 삭제 후 다시 등록해 주세요.' }, 400);
    }
    if ((existing.related_document_id || '') !== relatedDocumentId) {
      return json({ ok: false, message: '연결 내부문서는 수정할 수 없습니다. 연결이 잘못된 경우 삭제 후 다시 등록해 주세요.' }, 400);
    }

    const now = new Date().toISOString();
    const statements: D1PreparedStatement[] = [
      env.DB.prepare(`
        UPDATE received_documents SET
          title = ?, counterparty = ?, source_system = ?, external_doc_number = ?, memo = ?,
          department = ?, received_at = ?, updated_at = ?
        WHERE id = ?
      `).bind(
        title,
        counterparty,
        sourceSystem || null,
        externalDocNumber || null,
        memo || null,
        department || null,
        receivedAt,
        now,
        id,
      ),
    ];
    if (direction === '외부발송' && relatedDocumentId) {
      statements.push(
        env.DB.prepare(`UPDATE documents SET sent_method = ?, updated_at = ? WHERE id = ?`)
          .bind(sourceSystem || '외부발송', now, relatedDocumentId),
      );
    }
    await env.DB.batch(statements);
    return json({ ok: true, id, message: '접수·발송대장 내용이 수정되었습니다.' });
  } catch (error) {
    console.error('received update failed', error);
    return json({ ok: false, message: '대장 문서 수정 중 오류가 발생했습니다.' }, 500);
  }
};

export const onRequestGet: PagesFunction = async () =>
  json({ ok: false, message: 'POST 방식으로 요청해 주세요.' }, 405);
