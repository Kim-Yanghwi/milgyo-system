import { authenticateSession, clean, ensureTables, json, randomHex } from '../../_shared/helpers';
interface Env { DB: D1Database }
type Payload = { token?: string; id?: string; memo?: string };
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB) return json({ ok: false, message: 'DB가 연결되지 않았습니다.' }, 500);
  let payload: Payload;
  try { payload = await request.json(); } catch { return json({ ok: false, message: '요청 형식이 올바르지 않습니다.' }, 400); }
  await ensureTables(env.DB);
  const auth = await authenticateSession(env.DB, clean(payload.token, 200));
  if (!auth.ok) return json({ ok: false, message: auth.message }, auth.status);
  const id = clean(payload.id, 60);
  const memo = clean(payload.memo, 1000);
  const doc = await env.DB.prepare(`SELECT id,status,drafter_user_id FROM documents WHERE id=?`).bind(id).first<{id:string;status:string;drafter_user_id:string|null}>();
  if (!doc) return json({ ok:false, message:'문서를 찾을 수 없습니다.' },404);
  if (!['검토대기','협조대기','결재대기','전결대기'].includes(doc.status)) return json({ ok:false, message:'검토·협조·결재 진행 중인 문서만 회수할 수 있습니다.' },400);
  if (auth.user.role !== 'admin' && doc.drafter_user_id !== auth.user.id) return json({ ok:false, message:'기안자 또는 관리자만 문서를 회수할 수 있습니다.' },403);
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`UPDATE documents SET status='임시저장',submitted_at=NULL,completed_at=NULL,updated_at=? WHERE id=?`).bind(now,id),
    env.DB.prepare(`UPDATE document_approval_lines SET status='예정', acted_at=NULL, memo=NULL WHERE document_id=?`).bind(id),
    env.DB.prepare(`INSERT INTO document_approvals(id,document_id,action,approver_name,approver_role,memo,created_at) VALUES(?,?,'회수',?,?,?,?)`)
      .bind(`AP-${randomHex(20)}`,id,auth.user.name,auth.user.position||'기안자',memo||'기안자 회수',now),
  ]);
  return json({ ok:true, message:'문서를 회수하여 임시저장함으로 이동했습니다.' });
};
export const onRequestGet: PagesFunction = async () => json({ ok:false, message:'POST 방식으로 요청해 주세요.' },405);
