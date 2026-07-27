import { authenticateSession, clean, ensureTables, json } from '../../_shared/helpers';
import { ensureAccountingTables } from '../../_shared/accounting';
import {
  authorizeAccountingReference,
  normalizeAccountingReferenceType,
} from '../../_shared/accounting-attachments';

interface Env {
  DB: D1Database;
  ACCOUNTING_DB: D1Database;
}

type Payload = {
  token?: string;
  referenceType?: string;
  referenceId?: string;
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB || !env.ACCOUNTING_DB) {
    return json({ ok: false, message: '전자문서 DB 또는 회계 전용 DB가 연결되지 않았습니다.' }, 500);
  }

  let payload: Payload;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, message: '요청 형식이 올바르지 않습니다.' }, 400);
  }

  await ensureTables(env.DB);
  const auth = await authenticateSession(env.DB, clean(payload.token, 200));
  if ('message' in auth) return json({ ok: false, message: auth.message }, auth.status);
  await ensureAccountingTables(env.ACCOUNTING_DB);

  const referenceType = normalizeAccountingReferenceType(payload.referenceType);
  const referenceId = clean(payload.referenceId, 100);
  if (!referenceType || !referenceId) {
    return json({ ok: false, message: '회계자료 구분과 식별번호를 확인해 주세요.' }, 400);
  }

  const access = await authorizeAccountingReference(
    env.ACCOUNTING_DB,
    auth.user,
    referenceType,
    referenceId,
    'read',
  );
  if (!access.ok) return json({ ok: false, message: access.message || '첨부파일 열람 권한이 없습니다.' }, access.exists ? 403 : 404);

  const rows = await env.ACCOUNTING_DB.prepare(`
    SELECT id,reference_type,reference_id,file_category,original_filename,content_type,
           size_bytes,checksum_sha256,uploaded_by,uploaded_at
    FROM accounting_attachments
    WHERE reference_type=? AND reference_id=? AND deleted_at IS NULL
    ORDER BY uploaded_at DESC,id DESC
  `).bind(referenceType, referenceId).all();

  return json({ ok: true, referenceType, referenceId, rows: rows.results || [] });
};

export const onRequestGet: PagesFunction = async () =>
  json({ ok: false, message: 'POST 방식으로 요청해 주세요.' }, 405);
