import { authenticateSession, getSessionToken, clean, ensureTables, json } from '../../_shared/helpers';
import { writeManagementAudit } from '../../_shared/management';
interface Env { DB: D1Database; FILES?: R2Bucket }
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB) return json({ ok: false, message: 'D1 연결이 필요합니다.' }, 503);
  let p: { attachmentId?: string }; try { p = await request.json(); } catch { return json({ ok: false, message: '요청이 잘못됐습니다.' }, 400); }
  await ensureTables(env.DB);
  const auth = await authenticateSession(env.DB, getSessionToken(request));
  if (!auth.ok) return json({ ok: false, code: auth.code, message: auth.message }, auth.status);
  if (auth.user.role !== 'admin') return json({ ok: false, message: '증빙자료 삭제 권한이 없습니다.' }, 403);
  const id = clean(p.attachmentId, 80);
  const row = await env.DB.prepare('SELECT id,registry_id,storage_type,r2_key FROM monastic_registry_attachments WHERE id=?')
    .bind(id).first<any>();
  if (!row) return json({ ok: false, message: '증빙자료를 찾을 수 없습니다.' }, 404);
  // 감사기록을 먼저 보존하고 DB의 첨부 메타데이터를 삭제합니다.
  await writeManagementAudit(env.DB, auth.user, '승적원부', '증빙삭제', row.registry_id, { attachmentId: id });
  await env.DB.prepare('DELETE FROM monastic_registry_attachments WHERE id=?').bind(id).run();
  if (row.storage_type === 'r2' && row.r2_key && env.FILES) {
    try { await env.FILES.delete(row.r2_key); }
    catch { console.error('monastic evidence object cleanup failed', { attachmentId: id }); }
  }
  return json({ ok: true, message: '증빙자료를 삭제했습니다.' });
};
export const onRequestGet: PagesFunction = async () => json({ ok: false, message: 'POST 요청만 지원합니다.' }, 405);
