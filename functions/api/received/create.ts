// 문서24, 우편, 이메일 등으로 주고받은 문서를 수기로 등록하는 접수/외부발송 대장.
import {
  authenticateSession,
  clean,
  ensureTables,
  json,
  makeReceivedNumber,
} from '../../_shared/helpers';

interface Env {
  DB: D1Database;
}

type CreatePayload = {
  token?: string;
  direction?: string; // '접수' | '외부발송'
  title?: string;
  counterparty?: string;
  sourceSystem?: string;
  externalDocNumber?: string;
  memo?: string;
  receivedAt?: string; // YYYY-MM-DD
};

const VALID_DIRECTIONS = ['접수', '외부발송'];

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

  const direction = clean(payload.direction, 10);
  const title = clean(payload.title, 200);
  const counterparty = clean(payload.counterparty, 100);
  const sourceSystem = clean(payload.sourceSystem, 40);
  const externalDocNumber = clean(payload.externalDocNumber, 100);
  const memo = clean(payload.memo, 2000);
  const receivedAt = clean(payload.receivedAt, 10);

  if (!VALID_DIRECTIONS.includes(direction)) {
    return json({ ok: false, message: '구분(접수/외부발송)을 선택해 주세요.' }, 400);
  }
  if (!title || title.length < 2) return json({ ok: false, message: '제목을 2자 이상 입력해 주세요.' }, 400);
  if (!counterparty) {
    return json({ ok: false, message: direction === '접수' ? '발신자를 입력해 주세요.' : '수신자를 입력해 주세요.' }, 400);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(receivedAt)) {
    return json({ ok: false, message: '접수·발송 일자를 YYYY-MM-DD 형식으로 입력해 주세요.' }, 400);
  }

  try {
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
        memo || null, me.name, receivedAt, nowIso,
      )
      .run();

    return json({ ok: true, id, message: '등록되었습니다.' });
  } catch (error) {
    return json({ ok: false, message: '등록 중 오류가 발생했습니다.' }, 500);
  }
};

export const onRequestGet: PagesFunction = async () =>
  json({ ok: false, message: 'POST 방식으로 요청해 주세요.' }, 405);
