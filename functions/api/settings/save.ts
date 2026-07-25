// 관인(도장)·로고 이미지를 저장/교체합니다. 관리자만 가능하며, 이후 모든 공문서 미리보기에 고정으로 재사용됩니다.
import {
  authenticateSession,
  clean,
  ensureTables,
  json,
} from '../../_shared/helpers';

interface Env {
  DB: D1Database;
}

type SavePayload = {
  token?: string;
  sealImage?: string;
  logoImage?: string;
};

// data URL 전체 길이 기준 대략 1.5MB로 제한(원본 이미지 약 1MB 상당) — D1 행 크기 제약을 고려한 여유값.
const MAX_IMAGE_DATA_URL_LENGTH = 1.5 * 1024 * 1024;

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB) return json({ ok: false, message: 'DB가 연결되지 않았습니다.' }, 500);

  let payload: SavePayload;
  try {
    payload = await request.json();
  } catch (error) {
    return json({ ok: false, message: '요청 형식이 올바르지 않습니다.' }, 400);
  }

  await ensureTables(env.DB);
  const auth = await authenticateSession(env.DB, clean(payload.token, 200));
  if (!auth.ok) return json({ ok: false, message: auth.message }, auth.status);
  if (auth.user.role !== 'admin') {
    return json({ ok: false, message: '관인·로고 설정은 관리자만 변경할 수 있습니다.' }, 403);
  }

  const sealImage = typeof payload.sealImage === 'string' ? payload.sealImage.slice(0, MAX_IMAGE_DATA_URL_LENGTH) : '';
  const logoImage = typeof payload.logoImage === 'string' ? payload.logoImage.slice(0, MAX_IMAGE_DATA_URL_LENGTH) : '';

  if (payload.sealImage && payload.sealImage.length > MAX_IMAGE_DATA_URL_LENGTH) {
    return json({ ok: false, message: '관인 이미지 용량이 너무 큽니다. 1MB 이하의 이미지를 사용해 주세요.' }, 400);
  }
  if (payload.logoImage && payload.logoImage.length > MAX_IMAGE_DATA_URL_LENGTH) {
    return json({ ok: false, message: '로고 이미지 용량이 너무 큽니다. 1MB 이하의 이미지를 사용해 주세요.' }, 400);
  }

  try {
    const now = new Date().toISOString();
    const existing = await env.DB.prepare(`SELECT id FROM org_settings WHERE id = 'org'`).first();
    if (existing) {
      await env.DB.prepare(`
        UPDATE org_settings
        SET seal_image = COALESCE(NULLIF(?, ''), seal_image),
            logo_image = COALESCE(NULLIF(?, ''), logo_image),
            updated_at = ?
        WHERE id = 'org'
      `).bind(sealImage, logoImage, now).run();
    } else {
      await env.DB.prepare(`
        INSERT INTO org_settings (id, seal_image, logo_image, updated_at) VALUES ('org', ?, ?, ?)
      `).bind(sealImage || null, logoImage || null, now).run();
    }

    return json({ ok: true, message: '저장되었습니다.' });
  } catch (error) {
    return json({ ok: false, message: '저장 중 오류가 발생했습니다.' }, 500);
  }
};

export const onRequestGet: PagesFunction = async () =>
  json({ ok: false, message: 'POST 방식으로 요청해 주세요.' }, 405);
