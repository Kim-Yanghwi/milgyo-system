import { json } from '../_shared/helpers';
interface Env { DB?: D1Database; ACCOUNTING_DB?: D1Database; FILES?: R2Bucket; ACCOUNTING_FILES?: R2Bucket; }
export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  if (!env.DB || !env.ACCOUNTING_DB || !env.FILES || !env.ACCOUNTING_FILES) return json({ ok: false, message: '서비스 준비가 필요합니다.' }, 503);
  try {
    await Promise.all([env.DB.prepare('SELECT 1').first(), env.ACCOUNTING_DB.prepare('SELECT 1').first()]);
    return json({ ok: true, message: '정상' });
  } catch {
    return json({ ok: false, message: '서비스 점검이 필요합니다.' }, 503);
  }
};
export const onRequestPost = onRequestGet;
