import { authenticateSession, getSessionToken, clean, ensureTables, isValidIsoDate, json, randomHex } from '../../_shared/helpers';
import { inspectMainAttachment, decodeUploadBase64 } from '../../_shared/security/attachments';
import { writeManagementAudit } from '../../_shared/management';
interface Env { DB: D1Database; FILES?: R2Bucket }
type Payload = { registryId?: string; fileName?: string; dataBase64?: string; evidenceType?: string; issuingAuthority?: string; verifiedDate?: string };
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB) return json({ ok: false, message: 'D1 연결이 필요합니다.' }, 503);
  let p: Payload; try { p = await request.json(); } catch { return json({ ok: false, message: '요청 형식이 올바르지 않습니다.' }, 400); }
  await ensureTables(env.DB);
  const auth = await authenticateSession(env.DB, getSessionToken(request));
  if (!auth.ok) return json({ ok: false, code: auth.code, message: auth.message }, auth.status);
  if (auth.user.role !== 'admin') return json({ ok: false, message: '승적 증빙자료 등록 권한이 없습니다.' }, 403);
  const registryId = clean(p.registryId, 80), fileName = clean(p.fileName, 200);
  const bytes = decodeUploadBase64(String(p.dataBase64 || ''));
  if (!registryId || !bytes) return json({ ok: false, message: '파일이 없거나 4MB를 초과합니다.' }, 400);
  const check = inspectMainAttachment(fileName, bytes);
  if (!check.ok) return json({ ok: false, message: check.message }, 400);
  const verifiedDate = clean(p.verifiedDate, 10);
  if (verifiedDate && !isValidIsoDate(verifiedDate)) return json({ ok: false, message: '확인일을 확인해 주세요.' }, 400);
  const registry = await env.DB.prepare('SELECT id FROM monastic_registry WHERE id=?').bind(registryId).first();
  if (!registry) return json({ ok: false, message: '승적원부를 찾을 수 없습니다.' }, 404);
  const id = `MONATT-${randomHex(24)}`;
  const now = new Date().toISOString();
  const evidenceType = clean(p.evidenceType, 100), issuingAuthority = clean(p.issuingAuthority, 160);
  let storage = 'd1', data = String(p.dataBase64), r2Key: string | null = null;
  if (env.FILES) {
    storage = 'r2'; data = '';
    r2Key = `monastic-registry/${registryId}/${id}-${fileName.replace(/[^a-zA-Z0-9.\-_]/g, '_').slice(0, 90)}`;
    await env.FILES.put(r2Key, bytes, { httpMetadata: { contentType: check.mimeType }, customMetadata: { registryId } });
  } else if (bytes.length > 1250 * 1024) {
    return json({ ok: false, message: '1.2MB를 넘는 첨부는 R2(FILES) 연결이 필요합니다.' }, 503);
  }
  try {
    const result = await env.DB.prepare(`INSERT INTO monastic_registry_attachments(id,registry_id,file_name,mime_type,size_bytes,storage_type,data_base64,r2_key,evidence_type,issuing_authority,verified_date,actor_user_id,created_at)
       SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM monastic_registry WHERE id=?) AND (SELECT COUNT(*) FROM monastic_registry_attachments WHERE registry_id=?) < 10`)
      .bind(id, registryId, fileName, check.mimeType, bytes.length, storage, data, r2Key, evidenceType, issuingAuthority, verifiedDate, auth.user.id, now, registryId, registryId).run();
    if (Number(result.meta?.changes) !== 1) {
      if (r2Key && env.FILES) await env.FILES.delete(r2Key);
      return json({ ok: false, message: '증빙자료는 최대 10개까지 등록할 수 있습니다.' }, 409);
    }
    await writeManagementAudit(env.DB, auth.user, '승적원부', '증빙등록', registryId, { attachmentId: id, sizeBytes: bytes.length });
    return json({ ok: true, id, message: '승적원부 증빙자료를 등록했습니다.' });
  } catch (error) {
    if (r2Key && env.FILES) await env.FILES.delete(r2Key).catch(() => undefined);
    throw error;
  }
};
export const onRequestGet: PagesFunction = async () => json({ ok: false, message: 'POST 요청만 지원합니다.' }, 405);
