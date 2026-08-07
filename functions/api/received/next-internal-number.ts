import {
  authenticateSession,
  clean,
  ensureTables,
  json,
  previewNextDocumentNumber,
} from '../../_shared/helpers';

interface Env { DB: D1Database; }
type Payload = { token?: string };

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
    const documentNumber = await previewNextDocumentNumber(env.DB, new Date());
    return json({ ok: true, documentNumber });
  } catch (error) {
    console.error('next internal document number failed', error);
    return json({ ok: false, message: '다음 내부문서 번호를 확인하지 못했습니다. 등록할 때 자동 배정됩니다.' }, 500);
  }
};

export const onRequestGet: PagesFunction = async () =>
  json({ ok: false, message: 'POST 방식으로 요청해 주세요.' }, 405);
