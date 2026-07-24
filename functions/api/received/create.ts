// 문서24, 우편, 이메일 등으로 주고받은 문서를 수기로 등록하는 접수/외부발송 대장.
import {
  checkAdminAuthRateLimit,
  clean,
  clearAdminAuthFailures,
  ensureTables,
  json,
  makeReceivedNumber,
  recordAdminAuthFailure,
  verifyAdminToken,
} from '../../_shared/helpers';

interface Env {
  DB: D1Database;
  ADMIN_TOKEN: string;
}

type CreatePayload = {
  token?: string;
  direction?: string; // '접수' | '외부발송'
  title?: string;
  counterparty?: string;
  sourceSystem?: string;
  externalDocNumber?: string;
  memo?: string;
  handledBy?: string;
  receivedAt?: string; // YYYY-MM-DD
};

const VALID_DIRECTIONS = ['접수', '외부발송'];

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

  const direction = clean(payload.direction, 10);
  const title = clean(payload.title, 200);
  const counterparty = clean(payload.counterparty, 100);
  const sourceSystem = clean(payload.sourceSystem, 40);
  const externalDocNumber = clean(payload.externalDocNumber, 100);
  const memo = clean(payload.memo, 2000);
  const handledBy = clean(payload.handledBy, 40);
  const receivedAt = clean(payload.receivedAt, 10);

  if (!VALID_DIRECTIONS.includes(direction)) {
    return json({ ok: false, message: '구분(접수/외부발송)을 선택해 주세요.' }, 400);
  }
  if (!title || title.length < 2) return json({ ok: false, message: '제목을 2자 이상 입력해 주세요.' }, 400);
  if (!counterparty) {
    return json({ ok: false, message: direction === '접수' ? '발신자를 입력해 주세요.' : '수신자를 입력해 주세요.' }, 400);
  }
  if (!handledBy) return json({ ok: false, message: '등록 담당자를 입력해 주세요.' }, 400);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(receivedAt)) {
    return json({ ok: false, message: '접수·발송 일자를 YYYY-MM-DD 형식으로 입력해 주세요.' }, 400);
  }

  try {
    await ensureTables(env.DB);
    const now = new Date();
    const nowIso = now.toISOString();
    const id = await makeReceivedNumber(env.DB, now, direction);

    await env.DB.prepare(`
      INSERT INTO received_documents (
        id, direction, title, counterparty, source_system, external_doc_number, memo,
        handled_by, received_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .bind(
        id, direction, title, counterparty, sourceSystem || null, externalDocNumber || null,
        memo || null, handledBy, receivedAt, nowIso,
      )
      .run();

    return json({ ok: true, id, message: '등록되었습니다.' });
  } catch (error) {
    return json({ ok: false, message: '등록 중 오류가 발생했습니다.' }, 500);
  }
};

export const onRequestGet: PagesFunction = async () =>
  json({ ok: false, message: 'POST 방식으로 요청해 주세요.' }, 405);
