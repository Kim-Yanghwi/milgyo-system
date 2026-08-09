import { authenticateSession, clean, ensureTables, json } from '../../_shared/helpers';
import { ensureAccountingTables, hasAccountingAccess, isAccountingManager } from '../../_shared/accounting';
import {
  getAccountingAttachmentPolicy,
  assertAccountingAttachmentRetentionElapsed,
  retryAccountingAttachmentOperation,
  runAccountingAttachmentIntegrityScan,
  saveAccountingAttachmentPolicy,
} from '../../_shared/accounting-attachment-ops';
import { getTestResetPreview, resetAllTestData, TEST_RESET_CONFIRMATION } from '../../_shared/test-data-reset';
import { assertAccountingR2Key } from '../../_shared/r2-scope-guard';

interface Env {
  DB: D1Database;
  ACCOUNTING_DB: D1Database;
  FILES?: R2Bucket;
  ACCOUNTING_FILES?: R2Bucket;
}

type Payload = Record<string, unknown> & { token?: string; action?: string };

const listIssues = async (db: D1Database, status: string) => {
  const allowed = ['open', 'ignored', 'resolved'];
  const selected = allowed.includes(status) ? status : 'open';
  const rows = await db.prepare(`
    SELECT id,issue_type,attachment_id,object_key,reference_type,reference_id,status,
           details_json,detected_at,last_seen_at,resolved_at,resolved_by,resolution_action
    FROM accounting_attachment_integrity_issues
    WHERE status=? ORDER BY last_seen_at DESC LIMIT 500
  `).bind(selected).all<any>();
  return (rows.results || []).map((row) => ({
    ...row,
    details: (() => { try { return JSON.parse(row.details_json || '{}'); } catch { return {}; } })(),
  }));
};

const listOperations = async (db: D1Database, status: string) => {
  const selected = ['failed', 'succeeded'].includes(status) ? status : 'failed';
  const rows = await db.prepare(`
    SELECT id,operation_type,attachment_id,object_key,reference_type,reference_id,status,
           attempts,last_error,created_at,updated_at,last_attempt_at,completed_at
    FROM accounting_attachment_operations
    WHERE status=? ORDER BY updated_at DESC LIMIT 300
  `).bind(selected).all();
  return rows.results || [];
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB || !env.ACCOUNTING_DB) return json({ ok: false, message: '전자문서 DB 또는 회계 전용 DB가 연결되지 않았습니다.' }, 500);
  let payload: Payload;
  try { payload = await request.json(); }
  catch { return json({ ok: false, message: '요청 형식이 올바르지 않습니다.' }, 400); }

  await ensureTables(env.DB);
  const auth = await authenticateSession(env.DB, clean(payload.token, 200));
  if ('message' in auth) return json({ ok: false, message: auth.message }, auth.status);
  if (!hasAccountingAccess(auth.user)) return json({ ok: false, message: '회계 권한이 없습니다.' }, 403);
  await ensureAccountingTables(env.ACCOUNTING_DB);

  const action = clean(payload.action, 60);
  const manager = isAccountingManager(auth.user);
  const readOnlyAudit = auth.user.role === 'audit';

  try {
    if (action === 'policy') {
      const policy = await getAccountingAttachmentPolicy(env.ACCOUNTING_DB);
      return json({ ok: true, policy, permissions: { manager, audit: readOnlyAudit } });
    }

    if (action === 'save-policy') {
      if (!manager || readOnlyAudit) return json({ ok: false, message: '첨부파일 운영정책 변경 권한이 없습니다.' }, 403);
      const policy = await saveAccountingAttachmentPolicy(env.ACCOUNTING_DB, payload, auth.user);
      return json({ ok: true, policy, message: '첨부파일 운영정책을 저장했습니다.' });
    }

    if (action === 'issues') {
      if (!manager && !readOnlyAudit) return json({ ok: false, message: '무결성 점검목록 조회 권한이 없습니다.' }, 403);
      return json({ ok: true, rows: await listIssues(env.ACCOUNTING_DB, clean(payload.status, 20)) });
    }

    if (action === 'operations') {
      if (!manager && !readOnlyAudit) return json({ ok: false, message: '첨부파일 오류목록 조회 권한이 없습니다.' }, 403);
      return json({ ok: true, rows: await listOperations(env.ACCOUNTING_DB, clean(payload.status, 20)) });
    }

    if (action === 'scan-integrity') {
      if (!manager || readOnlyAudit) return json({ ok: false, message: '첨부파일 무결성 점검 실행 권한이 없습니다.' }, 403);
      if (!env.ACCOUNTING_FILES) return json({ ok: false, message: '회계 첨부파일 저장소가 연결되지 않았습니다.' }, 503);
      const mode = payload.mode === 'd1' ? 'd1' : 'full';
      const result = await runAccountingAttachmentIntegrityScan(env.ACCOUNTING_DB, env.ACCOUNTING_FILES, mode);
      return json({ ok: true, result, message: mode === 'full' ? 'D1·R2 전체 무결성 점검을 완료했습니다.' : 'D1 기준 R2 존재 여부 점검을 완료했습니다.' });
    }

    if (action === 'resolve-issue') {
      if (!manager || readOnlyAudit) return json({ ok: false, message: '무결성 문제 처리 권한이 없습니다.' }, 403);
      if (!env.ACCOUNTING_FILES) return json({ ok: false, message: '회계 첨부파일 저장소가 연결되지 않았습니다.' }, 503);
      const issueId = clean(payload.issueId, 80);
      const resolution = clean(payload.resolution, 40);
      const issue = await env.ACCOUNTING_DB.prepare(`SELECT * FROM accounting_attachment_integrity_issues WHERE id=?`).bind(issueId).first<any>();
      if (!issue) return json({ ok: false, message: '점검항목을 찾을 수 없습니다.' }, 404);
      const now = new Date().toISOString();

      if (resolution === 'delete-r2') {
        if (issue.issue_type !== 'R2_ONLY') return json({ ok: false, message: 'R2 단독 파일에만 사용할 수 있는 처리입니다.' }, 400);
        if (issue.attachment_id) {
          const attachment = await env.ACCOUNTING_DB.prepare(`SELECT retention_until FROM accounting_attachments WHERE id=?`)
            .bind(issue.attachment_id).first<{ retention_until: string | null }>();
          if (attachment) assertAccountingAttachmentRetentionElapsed(attachment.retention_until,now);
        }
        await env.ACCOUNTING_FILES.delete(assertAccountingR2Key(issue.object_key, '회계 무결성 점검 R2 삭제'));
      } else if (resolution === 'mark-d1-deleted') {
        if (issue.issue_type !== 'D1_ONLY' || !issue.attachment_id) return json({ ok: false, message: 'D1 단독 메타정보에만 사용할 수 있는 처리입니다.' }, 400);
        await env.ACCOUNTING_DB.prepare(`
          UPDATE accounting_attachments
          SET deleted_at=COALESCE(deleted_at,?),deleted_by=?,delete_reason='무결성 점검: R2 객체 없음',
              delete_status='deleted',delete_error=NULL,last_checked_at=?
          WHERE id=?
        `).bind(now, auth.user.id, now, issue.attachment_id).run();
      } else if (resolution !== 'ignore') {
        return json({ ok: false, message: '처리방법을 확인해 주세요.' }, 400);
      }

      await env.ACCOUNTING_DB.prepare(`
        UPDATE accounting_attachment_integrity_issues
        SET status=?,resolved_at=?,resolved_by=?,resolution_action=? WHERE id=?
      `).bind(resolution === 'ignore' ? 'ignored' : 'resolved', now, auth.user.name, resolution, issueId).run();
      return json({ ok: true, message: resolution === 'ignore' ? '예외 항목으로 승인했습니다.' : '무결성 문제를 처리했습니다.' });
    }

    if (action === 'retry-operation') {
      if (!manager || readOnlyAudit) return json({ ok: false, message: '첨부파일 오류 재처리 권한이 없습니다.' }, 403);
      if (!env.ACCOUNTING_FILES) return json({ ok: false, message: '회계 첨부파일 저장소가 연결되지 않았습니다.' }, 503);
      const operationId = clean(payload.operationId, 80);
      await retryAccountingAttachmentOperation(env.ACCOUNTING_DB, env.ACCOUNTING_FILES, operationId);
      return json({ ok: true, message: '첨부파일 작업을 재처리했습니다.' });
    }

    if (action === 'test-reset-preview') {
      if (auth.user.role !== 'admin' || readOnlyAudit) return json({ ok: false, message: '테스트자료 초기화는 최고관리자만 실행할 수 있습니다.' }, 403);
      const preview = await getTestResetPreview(env);
      return json({ ok: true, preview, confirmationText: TEST_RESET_CONFIRMATION });
    }

    if (action === 'test-reset-execute') {
      if (auth.user.role !== 'admin' || readOnlyAudit) return json({ ok: false, message: '테스트자료 초기화는 최고관리자만 실행할 수 있습니다.' }, 403);
      if (payload.backupConfirmed !== true) return json({ ok: false, message: '초기화 전 백업 완료 확인이 필요합니다.' }, 400);
      if (clean(payload.confirmation, 100) !== TEST_RESET_CONFIRMATION) return json({ ok: false, message: `확인문구를 정확히 입력해 주세요: ${TEST_RESET_CONFIRMATION}` }, 400);
      const result = await resetAllTestData(env, auth.user);
      return json({ ok: true, result, message: result.message });
    }

    return json({ ok: false, message: '지원하지 않는 첨부파일 관리 요청입니다.' }, 400);
  } catch (error) {
    console.error('accounting attachment admin failed', action, error);
    return json({ ok: false, message: error instanceof Error ? error.message : '첨부파일 관리 중 오류가 발생했습니다.' }, 500);
  }
};

export const onRequestGet: PagesFunction = async () => json({ ok: false, message: 'POST 방식으로 요청해 주세요.' }, 405);
