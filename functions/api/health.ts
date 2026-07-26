import { ensureTables, json } from '../_shared/helpers';

interface Env {
  DB: D1Database;
  FILES?: R2Bucket;
}

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  if (!env.DB) return json({ ok: false, database: false, storage: !!env.FILES, message: 'DB 바인딩이 없습니다.' }, 500);
  try {
    await ensureTables(env.DB);
    const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM system_users`).first<{ count: number }>();
    return json({
      ok: true,
      database: true,
      storage: !!env.FILES,
      users: Number(row?.count || 0),
    });
  } catch (error) {
    console.error('health check failed', error);
    return json({ ok: false, database: false, storage: !!env.FILES, message: 'DB 초기화 또는 마이그레이션에 실패했습니다.' }, 500);
  }
};

export const onRequestPost = onRequestGet;
