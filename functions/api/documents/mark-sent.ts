import {
  authenticateSession,
  clean,
  ensureTables,
  json,
  makeReceivedNumber,
  randomHex,
} from '../../_shared/helpers';

interface Env { DB: D1Database; }
type Payload = { token?: string; id?: string; sentMethod?: string };

const todayKst = () => {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB) return json({ ok: false, message: 'DB가 연결되지 않았습니다.' }, 500);
  let payload: Payload;
  try { payload = await request.json(); } catch {
    return json({ ok: false, message: '요청 형식이 올바르지 않습니다.' }, 400);
  }

  try {
    await ensureTables(env.DB);
    const auth = await authenticateSession(env.DB, clean(payload.token, 200));
    if (!auth.ok) return json({ ok: false, message: auth.message }, auth.status);

    const id = clean(payload.id, 60);
    const sentMethod = clean(payload.sentMethod, 80);
    if (!id || !sentMethod) return json({ ok: false, message: '문서번호와 발송방법을 입력해 주세요.' }, 400);

    const doc = await env.DB.prepare(`
      SELECT id, doc_type, status, title, recipient, department, CAST(drafter_user_id AS TEXT) AS drafter_user_id
      FROM documents WHERE id = ?
    `).bind(id).first<{
      id: string;
      doc_type: string;
      status: string;
      title: string;
      recipient: string | null;
      department: string | null;
      drafter_user_id: string | null;
    }>();
    if (!doc) return json({ ok: false, message: '해당 문서를 찾을 수 없습니다.' }, 404);
    if (doc.doc_type !== '발송' || doc.status !== '승인') {
      return json({ ok: false, message: '승인된 발송문서만 발송완료 처리할 수 있습니다.' }, 400);
    }
    if (auth.user.role !== 'admin' && doc.drafter_user_id !== auth.user.id) {
      return json({ ok: false, message: '기안자 또는 관리자만 발송완료 처리할 수 있습니다.' }, 403);
    }
    if (!clean(doc.recipient, 120)) {
      return json({ ok: false, message: '수신처가 없는 문서입니다. 문서를 수정한 뒤 다시 처리해 주세요.' }, 400);
    }

    const linked = await env.DB.prepare(`SELECT registry_id FROM document_dispatch_links WHERE document_id = ?`)
      .bind(id).first<{ registry_id: string }>();
    if (linked) return json({ ok: false, message: `이미 외부발송대장에 등록된 문서입니다. (${linked.registry_id})` }, 400);

    const now = new Date();
    const nowIso = now.toISOString();
    const registryId = await makeReceivedNumber(env.DB, now, '외부발송');
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO received_documents
          (id, direction, title, counterparty, source_system, external_doc_number, memo, department,
           related_document_id, handled_by, handled_by_user_id, received_at, created_at, updated_at)
        VALUES (?, '외부발송', ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        registryId,
        doc.title,
        doc.recipient,
        sentMethod,
        `${doc.id} 승인문서 외부발송 등록`,
        doc.department || auth.user.department || null,
        doc.id,
        auth.user.name,
        auth.user.id,
        todayKst(),
        nowIso,
        nowIso,
      ),
      env.DB.prepare(`INSERT INTO document_dispatch_links (document_id, registry_id, created_at) VALUES (?, ?, ?)`)
        .bind(doc.id, registryId, nowIso),
      env.DB.prepare(`
        UPDATE documents
        SET status = '발송완료', sent_method = ?, sent_at = ?, completed_at = ?, updated_at = ?
        WHERE id = ? AND status = '승인'
      `).bind(sentMethod, nowIso, nowIso, nowIso, id),
      env.DB.prepare(`
        INSERT INTO document_approvals
          (id, document_id, action, approver_name, approver_role, memo, created_at)
        VALUES (?, ?, '발송완료', ?, ?, ?, ?)
      `).bind(
        `AP-${randomHex(20)}`,
        id,
        auth.user.name,
        auth.user.position || '담당자',
        `접수·발송대장 ${registryId} 등록 · 발송방법: ${sentMethod}`,
        nowIso,
      ),
    ]);

    return json({ ok: true, registryId, message: '외부발송대장에 등록하고 발송완료 처리했습니다.' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('document mark-sent failed', error);
    if (/document_dispatch_links\.document_id/i.test(message)) {
      return json({ ok: false, message: '이미 외부발송대장에 등록된 문서입니다.' }, 400);
    }
    return json({ ok: false, message: '발송완료 처리 중 오류가 발생했습니다.' }, 500);
  }
};

export const onRequestGet: PagesFunction = async () =>
  json({ ok: false, message: 'POST 방식으로 요청해 주세요.' }, 405);
