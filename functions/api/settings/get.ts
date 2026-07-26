// 관인(도장)·로고 이미지 등, 문서서식에 고정으로 쓰이는 종단 설정값을 조회합니다.
import {
  authenticateSession,
  clean,
  ensureTables,
  json,
} from '../../_shared/helpers';

interface Env {
  DB: D1Database;
}

type GetPayload = { token?: string };

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB) return json({ ok: false, message: 'DB가 연결되지 않았습니다.' }, 500);

  let payload: GetPayload;
  try {
    payload = await request.json();
  } catch (error) {
    return json({ ok: false, message: '요청 형식이 올바르지 않습니다.' }, 400);
  }

  await ensureTables(env.DB);
  const auth = await authenticateSession(env.DB, clean(payload.token, 200));
  if (!auth.ok) return json({ ok: false, message: auth.message }, auth.status);

  try {
    const row = await env.DB.prepare(
      `SELECT seal_image, logo_image FROM org_settings WHERE id = 'org'`,
    ).first<{ seal_image: string | null; logo_image: string | null }>();

    return json({
      ok: true,
      sealImage: row?.seal_image || '',
      logoImage: row?.logo_image || '',
    });
  } catch (error) {
    return json({ ok: false, message: '설정을 불러오는 중 오류가 발생했습니다.' }, 500);
  }
};

export const onRequestGet: PagesFunction = async () =>
  json({ ok: false, message: 'POST 방식으로 요청해 주세요.' }, 405);
