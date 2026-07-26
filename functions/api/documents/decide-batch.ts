import { authenticateSession, clean, ensureTables, json, randomHex } from '../../_shared/helpers';
interface Env { DB: D1Database; }
type DecideBatchPayload = { token?: string; ids?: unknown; action?: string; memo?: string };
const MAX_BATCH = 50;

type LineRow = {
  id: string;
  document_id: string;
  line_order: number;
  line_type: '검토' | '협조' | '결재' | '전결';
  user_id: string;
  status: string;
};

const statusForLineType = (lineType: LineRow['line_type']) => lineType === '검토' ? '검토대기' : lineType === '협조' ? '협조대기' : lineType === '전결' ? '전결대기' : '결재대기';
const completedActionForLine = (lineType: LineRow['line_type']) => lineType === '검토' ? '검토완료' : lineType === '협조' ? '협조완료' : lineType === '전결' ? '전결' : '승인';

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB) return json({ ok: false, message: 'DB가 연결되지 않았습니다.' }, 500);
  let payload: DecideBatchPayload;
  try { payload = await request.json(); } catch { return json({ ok: false, message: '요청 형식이 올바르지 않습니다.' }, 400); }
  await ensureTables(env.DB);
  const auth = await authenticateSession(env.DB, clean(payload.token, 200));
  if (!auth.ok) return json({ ok: false, message: auth.message }, auth.status);
  const me = auth.user;
  const ids = (Array.isArray(payload.ids) ? payload.ids : []).map((v) => clean(v, 60)).filter((v, i, a) => v && a.indexOf(v) === i).slice(0, MAX_BATCH);
  const action = clean(payload.action, 10);
  const memo = clean(payload.memo, 2000);
  if (!ids.length) return json({ ok: false, message: '처리할 문서를 선택해 주세요.' }, 400);
  if (!['승인', '반려'].includes(action)) return json({ ok: false, message: '일괄 처리는 승인 또는 반려만 가능합니다.' }, 400);

  try {
    const placeholders = ids.map(() => '?').join(',');
    const documents = await env.DB.prepare(`
      SELECT id, status, CAST(reviewer_user_id AS TEXT) AS reviewer_user_id, CAST(approver_user_id AS TEXT) AS approver_user_id, approval_track, approval_mode
      FROM documents WHERE id IN (${placeholders})
    `).bind(...ids).all<{
      id: string;
      status: string;
      reviewer_user_id: string | null;
      approver_user_id: string | null;
      approval_track: string;
      approval_mode: string;
    }>();
    const lines = await env.DB.prepare(`
      SELECT id, document_id, line_order, line_type, CAST(user_id AS TEXT) AS user_id, status
      FROM document_approval_lines
      WHERE document_id IN (${placeholders}) AND status IN ('대기','예정')
      ORDER BY document_id, line_order
    `).bind(...ids).all<LineRow>();
    const lineMap = new Map<string, LineRow[]>();
    for (const line of lines.results ?? []) {
      const list = lineMap.get(line.document_id) || [];
      list.push(line);
      lineMap.set(line.document_id, list);
    }

    const now = new Date().toISOString();
    const statements: D1PreparedStatement[] = [];
    const processed: string[] = [];
    const skipped: string[] = [];

    for (const row of documents.results ?? []) {
      const docLines = lineMap.get(row.id) || [];
      // 대기 상태 갱신이 지연되었더라도 가장 앞선 미완료 결재선을 현재 처리자로 간주합니다.
      const currentLine = docLines[0];
      if (currentLine) {
        if (me.role !== 'admin' && currentLine.user_id !== me.id) { skipped.push(row.id); continue; }
        processed.push(row.id);
        if (action === '반려') {
          statements.push(env.DB.prepare(`UPDATE document_approval_lines SET status='반려', acted_at=?, memo=? WHERE id=?`).bind(now, memo || null, currentLine.id));
          statements.push(env.DB.prepare(`UPDATE documents SET status='반려', completed_at=?, updated_at=? WHERE id=?`).bind(now, now, row.id));
          statements.push(env.DB.prepare(`INSERT INTO document_approvals (id, document_id, action, approver_name, approver_role, memo, created_at) VALUES (?, ?, '반려', ?, ?, ?, ?)`)
            .bind(`AP-${randomHex(20)}`, row.id, me.name, `${currentLine.line_type}자`, memo || null, now));
          continue;
        }
        const nextLine = docLines.find((line) => line.status === '예정' && line.line_order > currentLine.line_order);
        const nextStatus = nextLine ? statusForLineType(nextLine.line_type) : '승인';
        const recordedAction = completedActionForLine(currentLine.line_type);
        statements.push(env.DB.prepare(`UPDATE document_approval_lines SET status='완료', acted_at=?, memo=? WHERE id=?`).bind(now, memo || null, currentLine.id));
        if (nextLine) statements.push(env.DB.prepare(`UPDATE document_approval_lines SET status='대기' WHERE id=?`).bind(nextLine.id));
        statements.push(env.DB.prepare(`UPDATE documents SET status=?, completed_at=CASE WHEN ?='승인' THEN ? ELSE NULL END, updated_at=? WHERE id=?`)
          .bind(nextStatus, nextStatus, now, now, row.id));
        statements.push(env.DB.prepare(`INSERT INTO document_approvals (id, document_id, action, approver_name, approver_role, memo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .bind(`AP-${randomHex(20)}`, row.id, recordedAction, me.name, `${currentLine.line_type}자`, memo || null, now));
        continue;
      }

      // 구버전 문서 호환
      let nextStatus = '';
      let recordedAction = action;
      if (row.status === '검토대기' && (me.role === 'admin' || row.reviewer_user_id === me.id)) {
        recordedAction = action === '승인' ? '검토완료' : '반려';
        nextStatus = recordedAction === '검토완료' ? '결재대기' : '반려';
      } else if (['결재대기','전결대기'].includes(row.status) && (me.role === 'admin' || row.approver_user_id === me.id)) {
        recordedAction = action === '반려' ? '반려' : (row.status === '전결대기' || row.approval_mode === '전결' ? '전결' : '승인');
        nextStatus = action === '반려' ? '반려' : '승인';
      } else { skipped.push(row.id); continue; }
      processed.push(row.id);
      statements.push(env.DB.prepare(`UPDATE documents SET status=?, completed_at=CASE WHEN ? IN ('승인','반려') THEN ? ELSE completed_at END, updated_at=? WHERE id=?`)
        .bind(nextStatus, nextStatus, now, now, row.id));
      statements.push(env.DB.prepare(`INSERT INTO document_approvals (id, document_id, action, approver_name, approver_role, memo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind(`AP-${randomHex(20)}`, row.id, recordedAction, me.name, me.position || '처리자', memo || null, now));
    }

    if (!processed.length) return json({ ok: false, message: '현재 계정이 처리할 수 있는 문서가 없습니다.' }, 400);
    await env.DB.batch(statements);
    return json({ ok: true, processed: processed.length, skipped, message: `${processed.length}건을 처리했습니다.${skipped.length ? ` 제외 ${skipped.length}건` : ''}` });
  } catch (error) {
    console.error('batch decide failed', error);
    return json({ ok: false, message: '일괄 처리 중 오류가 발생했습니다.' }, 500);
  }
};
export const onRequestGet: PagesFunction = async () => json({ ok: false, message: 'POST 방식으로 요청해 주세요.' }, 405);
