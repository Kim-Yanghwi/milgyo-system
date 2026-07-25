import { clean, destroySession, ensureTables, json } from '../../_shared/helpers';

interface Env {
  DB: D1Database;
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB) return json({ ok: false, message: 'DB가 연결되지 않았습니다.' }, 500);
  let payload: { token?: string };
  try {
    payload = await request.json();
  } catch (error) {
    return json({ ok: true });
  }
  await ensureTables(env.DB);
  await destroySession(env.DB, clean(payload.token, 200));
  return json({ ok: true });
};

export const onRequestGet: PagesFunction = async () =>
  json({ ok: false, message: 'POST 방식으로 요청해 주세요.' }, 405);
