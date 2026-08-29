import { authenticateSession, clean, ensureTables, json } from '../../_shared/helpers';

interface Env { DB: D1Database; }
type Payload = { token?: string };

// 관리 하위화면의 세션 확인 전용 엔드포인트입니다.
// 대시보드 집계(여러 COUNT/최근목록 쿼리)를 세션 확인 용도로 호출하지 않도록 분리합니다.
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB) return json({ ok: false, message: 'DB가 연결되지 않았습니다.' }, 500);
  let payload: Payload;
  try { payload = await request.json(); } catch { return json({ ok: false, message: '요청 형식이 올바르지 않습니다.' }, 400); }

  await ensureTables(env.DB);
  const auth = await authenticateSession(env.DB, clean(payload.token, 200));
  if (!auth.ok) return json({ ok: false, message: auth.message }, auth.status);
  return json({ ok: true });
};

export const onRequestGet: PagesFunction = async () =>
  json({ ok: false, message: 'POST 방식으로 요청해 주세요.' }, 405);
