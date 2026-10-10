import { destroySession, getSessionToken, sessionCookie, json } from '../../_shared/helpers';
interface Env { DB: D1Database; }
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB) return json({ ok: false, code: 'SERVICE_UNAVAILABLE' }, 503);
  await destroySession(env.DB, getSessionToken(request));
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(request, '') });
};
export const onRequestGet: PagesFunction = async () => json({ ok: false, code: 'METHOD_NOT_ALLOWED' }, 405);
