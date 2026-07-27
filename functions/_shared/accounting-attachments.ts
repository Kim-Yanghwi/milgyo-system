import {
  clean,
  randomHex,
  type SessionUser,
} from './helpers';
import {
  canViewAllAccounting,
  hasAccountingAccess,
  isAccountingManager,
} from './accounting';

export const ACCOUNTING_ATTACHMENT_REFERENCE_TYPES = [
  'budget',
  'resolution',
  'journal',
  'donation',
  'receipt',
  'asset',
  'card',
  'card_transaction',
  'branch_report',
  'closing',
] as const;

export type AccountingAttachmentReferenceType =
  (typeof ACCOUNTING_ATTACHMENT_REFERENCE_TYPES)[number];

export const ACCOUNTING_ATTACHMENT_FILE_CATEGORIES = [
  'general',
  'evidence',
  'receipt',
  'contract',
  'report',
  'photo',
  'other',
] as const;

export type AccountingAttachmentFileCategory =
  (typeof ACCOUNTING_ATTACHMENT_FILE_CATEGORIES)[number];

export const MAX_ACCOUNTING_ATTACHMENT_BYTES = 4 * 1024 * 1024;
export const MAX_ACCOUNTING_ATTACHMENTS_PER_REFERENCE = 10;

const BLOCKED_EXTENSIONS = /\.(html?|js|mjs|cjs|svg|exe|dll|bat|cmd|com|ps1|sh|php|jsp|asp|aspx|jar|msi|scr|vbs|reg)$/i;

const isAllowedReferenceType = (
  value: string,
): value is AccountingAttachmentReferenceType =>
  (ACCOUNTING_ATTACHMENT_REFERENCE_TYPES as readonly string[]).includes(value);

const isAllowedFileCategory = (
  value: string,
): value is AccountingAttachmentFileCategory =>
  (ACCOUNTING_ATTACHMENT_FILE_CATEGORIES as readonly string[]).includes(value);

export const normalizeAccountingReferenceType = (value: unknown) => {
  const normalized = clean(value, 40).toLowerCase().replace(/-/g, '_');
  return isAllowedReferenceType(normalized) ? normalized : null;
};

export const normalizeAccountingFileCategory = (value: unknown) => {
  const normalized = clean(value, 30).toLowerCase();
  return isAllowedFileCategory(normalized) ? normalized : 'general';
};

export const decodeAccountingAttachmentBase64 = (value: string) => {
  if (!value || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) return null;
  try {
    const binary = atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
};

export const arrayBufferToBase64 = (buffer: ArrayBuffer) => {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
};

export const safeAccountingObjectName = (name: string) =>
  name.replace(/[^0-9A-Za-z._-]+/g, '_').slice(-140) || 'attachment.bin';

export const validateAccountingAttachmentFile = (
  fileName: string,
  bytes: Uint8Array,
) => {
  if (!fileName) return '파일명을 확인해 주세요.';
  if (BLOCKED_EXTENSIONS.test(fileName)) return '보안상 등록할 수 없는 파일 형식입니다.';
  if (!bytes.byteLength) return '비어 있는 파일은 등록할 수 없습니다.';
  if (bytes.byteLength > MAX_ACCOUNTING_ATTACHMENT_BYTES) {
    return '회계 첨부파일은 4MB 이하만 등록할 수 있습니다.';
  }
  return '';
};

type ReferenceAccessMode = 'read' | 'write';
type ReferenceAccessResult = {
  ok: boolean;
  exists: boolean;
  message?: string;
  owner?: boolean;
};

const firstExists = async (db: D1Database, sql: string, id: string) =>
  !!(await db.prepare(sql).bind(id).first<{ id: string | number }>());

const wasCreatedByUser = async (
  db: D1Database,
  entityType: string,
  entityId: string,
  user: SessionUser,
) => {
  const row = await db.prepare(`
    SELECT actor_user_id, actor_name
    FROM accounting_audit_logs
    WHERE entity_type=? AND entity_id=? AND action IN ('create','save','submit')
    ORDER BY created_at ASC
    LIMIT 1
  `).bind(entityType, entityId).first<{ actor_user_id: string | null; actor_name: string | null }>();
  return String(row?.actor_user_id || '') === user.id || String(row?.actor_name || '') === user.name;
};

export const authorizeAccountingReference = async (
  db: D1Database,
  user: SessionUser,
  referenceType: AccountingAttachmentReferenceType,
  referenceId: string,
  mode: ReferenceAccessMode,
): Promise<ReferenceAccessResult> => {
  if (!hasAccountingAccess(user)) {
    return { ok: false, exists: false, message: '종단 회계관리 접속 권한이 없습니다.' };
  }

  const manager = isAccountingManager(user);
  const viewAll = canViewAllAccounting(user);
  const readOnlyAudit = user.role === 'audit';

  if (mode === 'write' && readOnlyAudit) {
    return { ok: false, exists: true, message: '감사 계정은 첨부파일을 열람할 수 있지만 등록·삭제할 수 없습니다.' };
  }

  switch (referenceType) {
    case 'resolution': {
      const row = await db.prepare(`
        SELECT id, created_by_user_id
        FROM accounting_resolutions
        WHERE id=?
      `).bind(referenceId).first<{ id: string; created_by_user_id: string }>();
      if (!row) return { ok: false, exists: false, message: '결의서를 찾을 수 없습니다.' };
      const owner = String(row.created_by_user_id || '') === user.id;
      return {
        ok: mode === 'read' ? viewAll || owner : manager || owner,
        exists: true,
        owner,
        message: '해당 결의서의 첨부파일을 처리할 권한이 없습니다.',
      };
    }

    case 'journal': {
      const exists = await firstExists(db, 'SELECT id FROM accounting_journals WHERE id=?', referenceId);
      return {
        ok: exists && viewAll && (mode === 'read' || manager),
        exists,
        message: exists ? '전표 첨부파일 처리 권한이 없습니다.' : '전표를 찾을 수 없습니다.',
      };
    }

    case 'budget': {
      const exists = await firstExists(db, 'SELECT id FROM accounting_budget_plans WHERE id=?', referenceId);
      return {
        ok: exists && (mode === 'read' || manager),
        exists,
        message: exists ? '예산 첨부파일 등록·삭제 권한이 없습니다.' : '예산자료를 찾을 수 없습니다.',
      };
    }

    case 'donation':
    case 'receipt': {
      const row = await db.prepare(`
        SELECT id, created_by
        FROM accounting_donations
        WHERE id=?
      `).bind(referenceId).first<{ id: string; created_by: string | null }>();
      if (!row) return { ok: false, exists: false, message: '기부·후원 자료를 찾을 수 없습니다.' };
      const owner = String(row.created_by || '') === user.name || await wasCreatedByUser(db, 'donation', referenceId, user);
      return {
        ok: mode === 'read' ? true : manager || owner,
        exists: true,
        owner,
        message: '해당 기부·후원 자료의 첨부파일을 처리할 권한이 없습니다.',
      };
    }

    case 'asset': {
      const exists = await firstExists(db, 'SELECT id FROM accounting_assets WHERE id=?', referenceId);
      return {
        ok: exists && (mode === 'read' || manager),
        exists,
        message: exists ? '자산·비품 첨부파일 등록·삭제 권한이 없습니다.' : '자산·비품 자료를 찾을 수 없습니다.',
      };
    }

    case 'card': {
      const exists = await firstExists(db, 'SELECT id FROM accounting_cards WHERE id=?', referenceId);
      return {
        ok: exists && (mode === 'read' || manager),
        exists,
        message: exists ? '법인카드 첨부파일 등록·삭제 권한이 없습니다.' : '법인카드 자료를 찾을 수 없습니다.',
      };
    }

    case 'card_transaction': {
      const row = await db.prepare(`
        SELECT id, created_by
        FROM accounting_card_transactions
        WHERE id=?
      `).bind(referenceId).first<{ id: string; created_by: string | null }>();
      if (!row) return { ok: false, exists: false, message: '법인카드 사용내역을 찾을 수 없습니다.' };
      const owner = String(row.created_by || '') === user.name || await wasCreatedByUser(db, 'card-transaction', referenceId, user);
      return {
        ok: mode === 'read' ? true : manager || owner,
        exists: true,
        owner,
        message: '해당 카드 사용내역의 첨부파일을 처리할 권한이 없습니다.',
      };
    }

    case 'branch_report': {
      const row = await db.prepare(`
        SELECT id, submitted_by
        FROM accounting_branch_reports
        WHERE id=?
      `).bind(referenceId).first<{ id: string; submitted_by: string | null }>();
      if (!row) return { ok: false, exists: false, message: '사찰·교구 취합자료를 찾을 수 없습니다.' };
      const owner = String(row.submitted_by || '') === user.name || await wasCreatedByUser(db, 'branch-report', referenceId, user);
      return {
        ok: mode === 'read' ? true : manager || owner,
        exists: true,
        owner,
        message: '해당 취합자료의 첨부파일을 처리할 권한이 없습니다.',
      };
    }

    case 'closing': {
      const exists = await firstExists(db, 'SELECT id FROM accounting_closings WHERE id=?', referenceId);
      return {
        ok: exists && (mode === 'read' || manager),
        exists,
        message: exists ? '결산·마감 첨부파일 등록·삭제 권한이 없습니다.' : '결산·마감 자료를 찾을 수 없습니다.',
      };
    }
  }
};

export const accountingAttachmentAuditStatement = (
  db: D1Database,
  action: 'attachment-upload' | 'attachment-delete',
  referenceType: AccountingAttachmentReferenceType,
  referenceId: string,
  user: SessionUser,
  detail: unknown,
  now: string,
) => db.prepare(`
  INSERT INTO accounting_audit_logs
    (id,action,entity_type,entity_id,actor_user_id,actor_name,detail_json,created_at)
  VALUES (?,?,?,?,?,?,?,?)
`).bind(
  `LOG-${randomHex(20)}`,
  action,
  referenceType,
  referenceId,
  user.id,
  user.name,
  JSON.stringify(detail || {}),
  now,
);
