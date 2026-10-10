import { authenticateSession, getSessionToken, clean, ensureTables, json, randomHex } from '../../_shared/helpers';
import { decodeUploadBase64, inspectMainAttachment } from '../../_shared/security/attachments';
interface Env { DB: D1Database; FILES?: R2Bucket; }
type Payload = { registerId?: string; fileName?: string; dataBase64?: string };
const safeKey = (name: string) => name.replace(/[^0-9A-Za-z._-]+/g, '_').slice(-120) || 'attachment.bin';
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB) return json({ ok: false, code: 'SERVICE_UNAVAILABLE' }, 503);
  let payload: Payload;
  try { payload = await request.json(); } catch { return json({ ok: false, code: 'INVALID_JSON' }, 400); }
  await ensureTables(env.DB);
  const auth = await authenticateSession(env.DB, getSessionToken(request));
  if (!auth.ok) return json({ ok: false, code: auth.code, message: auth.message }, auth.status);
  const registerId = clean(payload.registerId, 80), fileName = clean(payload.fileName, 200);
  const data = typeof payload.dataBase64 === 'string' ? payload.dataBase64 : '';
  const bytes = decodeUploadBase64(data);
  if (!registerId || !bytes) return json({ ok: false, message: '\ucca8\ubd80\ud30c\uc77c \uc815\ubcf4\ub97c \ud655\uc778\ud574 \uc8fc\uc138\uc694.' }, 400);
  const inspection = inspectMainAttachment(fileName, bytes);
  if (!inspection.ok) return json({ ok: false, message: inspection.message }, 400);
  const row = await env.DB.prepare('SELECT applicant_user_id,status FROM management_registers WHERE id=?').bind(registerId).first<any>();
  if (!row) return json({ ok: false, message: '\uc2e0\uccad\ub0b4\uc5ed\uc744 \ucc3e\uc744 \uc218 \uc5c6\uc2b5\ub2c8\ub2e4.' }, 404);
  if (auth.user.role !== 'admin' && String(row.applicant_user_id || '') !== auth.user.id) return json({ ok: false, message: '\ucca8\ubd80 \uad8c\ud55c\uc774 \uc5c6\uc2b5\ub2c8\ub2e4.' }, 403);
  if (['\uc644\ub8cc', '\ubc18\ub824', '\ucde8\uc18c'].includes(row.status)) return json({ ok: false, message: '\ucc98\ub9ac\uac00 \uc885\ub8cc\ub41c \uc2e0\uccad\uc785\ub2c8\ub2e4.' }, 409);
  const id = `MRATT-${randomHex(20)}`, now = new Date().toISOString();
  let storage = 'd1', key: string | null = null, stored = data;
  if (env.FILES) {
    storage = 'r2'; stored = ''; key = `registers/${registerId}/${id}-${safeKey(fileName)}`;
    await env.FILES.put(key, bytes, { httpMetadata: { contentType: inspection.mimeType }, customMetadata: { originalName: fileName, registerId } });
  } else if (bytes.length > 1250 * 1024) return json({ ok: false, message: '1.2MB\ub97c \ub118\ub294 \ud30c\uc77c\uc740 R2(FILES) \uc5f0\uacb0\uc774 \ud544\uc694\ud569\ub2c8\ub2e4.' }, 400);
  try {
    const results = await env.DB.batch([
      env.DB.prepare(`INSERT INTO management_register_attachments(id,register_id,file_name,mime_type,size_bytes,data_base64,storage_type,r2_key,created_at)
        SELECT ?,?,?,?,?,?,?,?,?
        WHERE EXISTS(SELECT 1 FROM management_registers WHERE id=? AND status NOT IN ('\uc644\ub8cc','\ubc18\ub824','\ucde8\uc18c') AND (?='admin' OR CAST(applicant_user_id AS TEXT)=?))
        AND (SELECT COUNT(*) FROM management_register_attachments WHERE register_id=?)<10`)
        .bind(id, registerId, fileName, inspection.mimeType, bytes.length, stored, storage, key, now, registerId, auth.user.role, auth.user.id, registerId),
      env.DB.prepare(`INSERT INTO management_audit_logs(id,category,action,target_id,actor_user_id,actor_name,details_json,created_at)
        SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM management_register_attachments WHERE id=?)`)
        .bind(`MAL-${randomHex(24)}`, '\ub300\uc7a5\uad00\ub9ac', '\ucca8\ubd80\ub4f1\ub85d', registerId, auth.user.id, auth.user.name,
          JSON.stringify({ attachmentId: id, fileName, sizeBytes: bytes.length }), now, id),
    ]);
    if (Number(results[0].meta?.changes) !== 1) {
      if (key && env.FILES) await env.FILES.delete(key).catch(() => undefined);
      return json({ ok: false, code: 'ATTACHMENT_STATE_CONFLICT', message: '\uc2e0\uccad \uc0c1\ud0dc \ub610\ub294 \ucca8\ubd80 \ud55c\ub3c4\uac00 \ubcc0\uacbd\ub418\uc5c8\uc2b5\ub2c8\ub2e4.' }, 409);
    }
    return json({ ok: true, id, fileName, sizeBytes: bytes.length, message: '\ucca8\ubd80\ud30c\uc77c\uc774 \ub4f1\ub85d\ub418\uc5c8\uc2b5\ub2c8\ub2e4.' });
  } catch (error) {
    if (key && env.FILES) await env.FILES.delete(key).catch(() => undefined);
    console.error('register attachment transaction failed');
    return json({ ok: false, code: 'ATTACHMENT_SAVE_FAILED' }, 500);
  }
};
export const onRequestGet: PagesFunction = async () => json({ ok: false, code: 'METHOD_NOT_ALLOWED' }, 405);
