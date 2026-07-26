import { authenticateSession, clean, ensureTables, json, randomHex } from '../../_shared/helpers';
interface Env { DB: D1Database; }
type DecidePayload = { token?: string; id?: string; action?: string; memo?: string };
const VALID_ACTIONS = ['승인', '반려', '검토완료', '협조완료', '전결'];

type ApprovalLine = {
  id: string;
  document_id: string;
  line_order: number;
  line_type: '검토' | '협조' | '결재' | '전결';
  user_id: string;
  user_name: string;
  user_position: string | null;
  status: string;
};

const statusForLineType = (lineType: ApprovalLine['line_type']) => {
  if (lineType === '검토') return '검토대기';
  if (lineType === '협조') return '협조대기';
  if (lineType === '전결') return '전결대기';
  return '결재대기';
};

const completedActionForLine = (lineType: ApprovalLine['line_type']) => {
  if (lineType === '검토') return '검토완료';
  if (lineType === '협조') return '협조완료';
  if (lineType === '전결') return '전결';
  return '승인';
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB) return json({ ok: false, message: 'DB가 연결되지 않았습니다.' }, 500);
  let payload: DecidePayload;
  try { payload = await request.json(); } catch { return json({ ok: false, message: '요청 형식이 올바르지 않습니다.' }, 400); }
  await ensureTables(env.DB);
  const auth = await authenticateSession(env.DB, clean(payload.token, 200));
  if (!auth.ok) return json({ ok: false, message: auth.message }, auth.status);
  const me = auth.user;
  const id = clean(payload.id, 60);
  const action = clean(payload.action, 20);
  const memo = clean(payload.memo, 2000);
  if (!id) return json({ ok: false, message: '문서번호가 필요합니다.' }, 400);
  if (!VALID_ACTIONS.includes(action)) return json({ ok: false, message: '처리 구분이 올바르지 않습니다.' }, 400);

  try {
    const document = await env.DB.prepare(`
      SELECT id, status, approval_track, approval_mode, CAST(reviewer_user_id AS TEXT) AS reviewer_user_id, CAST(approver_user_id AS TEXT) AS approver_user_id FROM documents WHERE id = ?
    `).bind(id).first<{
      id: string;
      status: string;
      approval_track: string;
      approval_mode: string;
      reviewer_user_id: string | null;
      approver_user_id: string | null;
    }>();
    if (!document) return json({ ok: false, message: '해당 문서를 찾을 수 없습니다.' }, 404);

    const currentLine = await env.DB.prepare(`
      SELECT id, document_id, line_order, line_type, CAST(user_id AS TEXT) AS user_id, user_name, user_position, status
      FROM document_approval_lines current_line
      WHERE current_line.document_id = ?
        AND current_line.status IN ('대기','예정')
        AND NOT EXISTS (
          SELECT 1 FROM document_approval_lines previous_line
          WHERE previous_line.document_id = current_line.document_id
            AND previous_line.line_order < current_line.line_order
            AND previous_line.status <> '완료'
        )
      ORDER BY current_line.line_order ASC LIMIT 1
    `).bind(id).first<ApprovalLine>();

    if (currentLine) {
      if (me.role !== 'admin' && currentLine.user_id !== me.id) {
        return json({ ok: false, message: `지정된 ${currentLine.line_type}자만 처리할 수 있습니다.` }, 403);
      }
      if (action === '반려') {
        const now = new Date().toISOString();
        await env.DB.batch([
          env.DB.prepare(`UPDATE document_approval_lines SET status='반려', acted_at=?, memo=? WHERE id=?`)
            .bind(now, memo || null, currentLine.id),
          env.DB.prepare(`UPDATE documents SET status='반려', completed_at=?, updated_at=? WHERE id=?`)
            .bind(now, now, id),
          env.DB.prepare(`INSERT INTO document_approvals (id, document_id, action, approver_name, approver_role, memo, created_at) VALUES (?, ?, '반려', ?, ?, ?, ?)`)
            .bind(`AP-${randomHex(20)}`, id, me.name, `${currentLine.line_type}자`, memo || null, now),
        ]);
        return json({ ok: true, status: '반려', action: '반려', message: '문서가 반려 처리되었습니다.' });
      }

      const recordedAction = completedActionForLine(currentLine.line_type);
      const now = new Date().toISOString();
      const nextLine = await env.DB.prepare(`
        SELECT id, document_id, line_order, line_type, user_id, user_name, user_position, status
        FROM document_approval_lines
        WHERE document_id = ? AND line_order > ? AND status = '예정'
        ORDER BY line_order ASC LIMIT 1
      `).bind(id, currentLine.line_order).first<ApprovalLine>();
      const nextStatus = nextLine ? statusForLineType(nextLine.line_type) : '승인';
      const statements: D1PreparedStatement[] = [
        env.DB.prepare(`UPDATE document_approval_lines SET status='완료', acted_at=?, memo=? WHERE id=?`)
          .bind(now, memo || null, currentLine.id),
        env.DB.prepare(`UPDATE documents SET status=?, completed_at=CASE WHEN ?='승인' THEN ? ELSE NULL END, updated_at=? WHERE id=?`)
          .bind(nextStatus, nextStatus, now, now, id),
        env.DB.prepare(`INSERT INTO document_approvals (id, document_id, action, approver_name, approver_role, memo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .bind(`AP-${randomHex(20)}`, id, recordedAction, me.name, `${currentLine.line_type}자`, memo || null, now),
      ];
      if (nextLine) statements.push(env.DB.prepare(`UPDATE document_approval_lines SET status='대기' WHERE id=?`).bind(nextLine.id));
      await env.DB.batch(statements);
      const message = nextLine
        ? `${recordedAction} 처리되어 다음 ${nextLine.line_type}자에게 전달되었습니다.`
        : currentLine.line_type === '전결' ? '문서가 전결 처리되었습니다.' : '문서가 최종 승인되었습니다.';
      return json({ ok: true, status: nextStatus, action: recordedAction, message });
    }

    // 구버전 문서 호환: 결재선 테이블이 없는 기존 진행문서는 기존 단일 결재 방식으로 처리합니다.
    let newStatus = '';
    let recordedAction = action;
    if (document.status === '검토대기') {
      if (me.role !== 'admin' && document.reviewer_user_id !== me.id) return json({ ok: false, message: '지정된 검토자만 처리할 수 있습니다.' }, 403);
      if (action === '승인') recordedAction = '검토완료';
      if (!['검토완료', '반려'].includes(recordedAction)) return json({ ok: false, message: '검토 단계에서는 검토완료 또는 반려만 가능합니다.' }, 400);
      newStatus = recordedAction === '반려' ? '반려' : '결재대기';
    } else if (document.status === '결재대기' || document.status === '전결대기') {
      if (me.role !== 'admin' && document.approver_user_id !== me.id) return json({ ok: false, message: '지정된 최종 처리자만 처리할 수 있습니다.' }, 403);
      if (action === '반려') {
        recordedAction = '반려';
        newStatus = '반려';
      } else {
        recordedAction = document.status === '전결대기' || document.approval_mode === '전결' ? '전결' : '승인';
        newStatus = '승인';
      }
    } else {
      return json({ ok: false, message: `이미 "${document.status}" 상태로 처리된 문서입니다.` }, 400);
    }

    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(`UPDATE documents SET status = ?, completed_at = CASE WHEN ? IN ('승인','반려') THEN ? ELSE completed_at END, updated_at = ? WHERE id = ?`)
        .bind(newStatus, newStatus, now, now, id),
      env.DB.prepare(`
        INSERT INTO document_approvals (id, document_id, action, approver_name, approver_role, memo, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(`AP-${randomHex(20)}`, id, recordedAction, me.name, me.position || '처리자', memo || null, now),
    ]);
    return json({ ok: true, status: newStatus, action: recordedAction, message: recordedAction === '검토완료' ? '검토가 완료되어 최종 결재자에게 전달되었습니다.' : `문서가 ${recordedAction} 처리되었습니다.` });
  } catch (error) {
    console.error('document decide failed', error);
    return json({ ok: false, message: '결재 처리 중 오류가 발생했습니다.' }, 500);
  }
};
export const onRequestGet: PagesFunction = async () => json({ ok: false, message: 'POST 방식으로 요청해 주세요.' }, 405);
