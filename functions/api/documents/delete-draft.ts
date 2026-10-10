import { authenticateSession, getSessionToken, clean, ensureTables, json } from '../../_shared/helpers';
import { assertR2KeysWithinPrefixes } from '../../_shared/r2-scope-guard';
interface Env { DB: D1Database; FILES?: R2Bucket; }
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB) return json({ ok: false, code: 'SERVICE_UNAVAILABLE' }, 503);
  let payload: { id?: string };
  try { payload = await request.json(); } catch { return json({ ok: false, code: 'INVALID_JSON' }, 400); }
  await ensureTables(env.DB);
  const auth = await authenticateSession(env.DB, getSessionToken(request));
  if (!auth.ok) return json({ ok: false, code: auth.code, message: auth.message }, auth.status);
  const id = clean(payload.id, 60);
  if (!id) return json({ ok: false, code: 'DOCUMENT_ID_REQUIRED' }, 400);
  // Each statement rechecks the parent inside one transaction. Submission may win, but then nothing is deleted.
  const guard = `EXISTS(SELECT 1 FROM documents d WHERE d.id=? AND d.status='\uc784\uc2dc\uc800\uc7a5'
    AND (?='admin' OR CAST(d.drafter_user_id AS TEXT)=?))`;
  const bind = [id, auth.user.role, auth.user.id];
  const results = await env.DB.batch([
    env.DB.prepare(`SELECT r2_key FROM document_attachments WHERE document_id=? AND storage_type='r2' AND r2_key IS NOT NULL AND ${guard}`).bind(id, ...bind),
    env.DB.prepare(`DELETE FROM document_attachments WHERE document_id=? AND ${guard}`).bind(id, ...bind),
    env.DB.prepare(`DELETE FROM document_approvals WHERE document_id=? AND ${guard}`).bind(id, ...bind),
    env.DB.prepare(`DELETE FROM document_approval_lines WHERE document_id=? AND ${guard}`).bind(id, ...bind),
    env.DB.prepare(`DELETE FROM documents WHERE id=? AND status='\uc784\uc2dc\uc800\uc7a5' AND (?='admin' OR CAST(drafter_user_id AS TEXT)=?)`).bind(id, auth.user.role, auth.user.id),
  ]);
  if (Number(results[4].meta?.changes) !== 1) return json({ ok: false, code: 'DOCUMENT_STATE_CONFLICT', message: '\ubcf8\uc778\uc758 \uc784\uc2dc\uc800\uc7a5 \ubb38\uc11c\ub9cc \uc0ad\uc81c\ud560 \uc218 \uc788\uc2b5\ub2c8\ub2e4. \ubaa9\ub85d\uc744 \uc0c8\ub85c\uace0\uce68\ud574 \uc8fc\uc138\uc694.' }, 409);
  const keys = (results[0].results || []).map((row: { r2_key: string }) => row.r2_key);
  if (env.FILES && keys.length) {
    try { await env.FILES.delete(assertR2KeysWithinPrefixes(keys, [`documents/${id}/`], 'draft attachment cleanup')); }
    catch { console.error('Draft deleted; private R2 orphan cleanup is required', { documentId: id }); }
  }
  return json({ ok: true, message: '\uc784\uc2dc\ubb38\uc11c\uac00 \uc0ad\uc81c\ub418\uc5c8\uc2b5\ub2c8\ub2e4.' });
};
export const onRequestGet: PagesFunction = async () => json({ ok: false, code: 'METHOD_NOT_ALLOWED' }, 405);
