import { clean, randomHex, type SessionUser } from './helpers';
import { nextSpecialSequence } from './accounting-numbering';

export const OPERATIONS_SCHEMA_VERSION = '2026-08-04.1';

const REQUIRED_OPERATION_TABLES = [
  'accounting_bank_accounts', 'accounting_import_batches', 'accounting_import_transactions',
  'accounting_matching_rules', 'accounting_reconciliation_periods',
  'accounting_budget_change_requests', 'accounting_budget_versions',
  'accounting_vendors', 'accounting_vendor_bank_changes', 'accounting_contracts',
  'accounting_contract_payments', 'accounting_donation_export_batches',
  'accounting_donation_export_items',
];

const schemaReady = new WeakSet<object>();
const schemaPromises = new WeakMap<object, Promise<void>>();

export const ensureAccountingOperationsTables = async (db: D1Database) => {
  const key = db as unknown as object;
  if (schemaReady.has(key)) return;
  let pending = schemaPromises.get(key);
  if (!pending) {
    pending = (async () => {
      const placeholders = REQUIRED_OPERATION_TABLES.map(() => '?').join(',');
      const row = await db.prepare(`SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name IN (${placeholders})`)
        .bind(...REQUIRED_OPERATION_TABLES).first<{ count: number }>();
      if (Number(row?.count || 0) !== REQUIRED_OPERATION_TABLES.length) {
        throw new Error('실무 회계운영 DB 스키마가 준비되지 않았습니다. v38 마이그레이션을 먼저 적용해 주세요.');
      }
      schemaReady.add(key);
    })().catch((error) => { schemaPromises.delete(key); throw error; });
    schemaPromises.set(key, pending);
  }
  await pending;
};

export const validAccountingDate = (value: string) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCFullYear() === Number(match[1]) && date.getUTCMonth() === Number(match[2]) - 1 && date.getUTCDate() === Number(match[3]);
};

export const normalizeBusinessNo = (value: unknown) => clean(value, 30).replace(/[^0-9]/g, '').slice(0, 10);
export const normalizeMatchText = (value: unknown) => clean(value, 300).toLowerCase().replace(/[^0-9a-z가-힣]/g, '');

export const maskBankAccount = (value: unknown) => {
  const digits = clean(value, 80).replace(/[^0-9]/g, '');
  if (!digits) return '';
  if (digits.length <= 6) return `${digits.slice(0, 2)}${'*'.repeat(Math.max(1, digits.length - 3))}${digits.slice(-1)}`;
  return `${digits.slice(0, 3)}-${'*'.repeat(Math.min(8, digits.length - 6))}-${digits.slice(-3)}`;
};

export const sha256Hex = async (value: string) => {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

export const operationAudit = (
  db: D1Database,
  action: string,
  entityType: string,
  entityId: string,
  user: Pick<SessionUser, 'id' | 'name'>,
  detail: unknown,
  now = new Date().toISOString(),
) => db.prepare(`INSERT INTO accounting_audit_logs
  (id,action,entity_type,entity_id,actor_user_id,actor_name,detail_json,created_at)
  VALUES (?,?,?,?,?,?,?,?)`)
  .bind(`LOG-${randomHex(20)}`, action, entityType, entityId, user.id, user.name, JSON.stringify(detail || {}), now);

export const nextOperationNumber = async (
  db: D1Database,
  type: 'import' | 'budget-change' | 'vendor' | 'contract' | 'donation-export',
  year?: number,
) => {
  const y = year || new Date(Date.now() + 9 * 60 * 60 * 1000).getUTCFullYear();
  const meta = {
    import: ['가져오기', `operation-import:${y}`, 5],
    'budget-change': ['예산변경', `operation-budget:${y}`, 5],
    vendor: ['거래처', `operation-vendor:${y}`, 5],
    contract: ['계약', `operation-contract:${y}`, 5],
    'donation-export': ['기부금일괄', `operation-donation-export:${y}`, 5],
  } as const;
  const [prefix, key, digits] = meta[type];
  const seq = await nextSpecialSequence(db, key);
  return `${prefix}-${y}-${String(seq).padStart(digits, '0')}`;
};

export const getSourceSettlement = async (db: D1Database, sourceType: string, sourceAccountId: string) => {
  if (sourceType === 'bank') {
    const row = await db.prepare(`SELECT id,settlement_account_code,book_type_code,entity_id,fund_id
      FROM accounting_bank_accounts WHERE id=? AND active=1`).bind(sourceAccountId).first<any>();
    if (!row) throw new Error('가져오기 대상 계좌를 찾을 수 없습니다.');
    return row;
  }
  if (sourceType === 'card') {
    const row = await db.prepare(`SELECT id,settlement_account_code,book_type_code,entity_id,'' AS fund_id
      FROM accounting_cards WHERE id=? AND active=1`).bind(sourceAccountId).first<any>();
    if (!row) throw new Error('가져오기 대상 법인카드를 찾을 수 없습니다.');
    return row;
  }
  throw new Error('가져오기 자료 유형을 확인해 주세요.');
};

export const getBudgetCommittedAmount = async (db: D1Database, budget: any) => {
  const row = await db.prepare(`SELECT COALESCE(SUM(
      CASE WHEN c.contract_amount > COALESCE(p.paid_amount,0)
        THEN c.contract_amount-COALESCE(p.paid_amount,0) ELSE 0 END
    ),0) AS amount
    FROM accounting_contracts c
    LEFT JOIN (
      SELECT contract_id,SUM(CASE WHEN status='paid' THEN amount ELSE 0 END) AS paid_amount
      FROM accounting_contract_payments GROUP BY contract_id
    ) p ON p.contract_id=c.id
    WHERE c.status IN ('active','approved') AND c.account_code=? AND c.department=? AND c.project=?
      AND c.book_type_code=? AND c.entity_id=? AND c.fund_id=?
      AND substr(c.contract_date,1,4)=?`)
    .bind(budget.account_code, budget.department || '', budget.project || '', budget.book_type_code || 'general', budget.entity_id || 'ENTITY-HQ', budget.fund_id || '', String(budget.fiscal_year))
    .first<{ amount: number }>();
  return Number(row?.amount || 0);
};

export const getBudgetExecutedAmount = async (db: D1Database, budget: any) => {
  const row = await db.prepare(`SELECT COALESCE(SUM(debit_total-credit_total),0) AS amount
    FROM accounting_monthly_summary WHERE fiscal_year=? AND account_code=? AND department=? AND project=?
      AND book_type_code=? AND entity_id=? AND fund_id=?`)
    .bind(budget.fiscal_year, budget.account_code, budget.department || '', budget.project || '', budget.book_type_code || 'general', budget.entity_id || 'ENTITY-HQ', budget.fund_id || '')
    .first<{ amount: number }>();
  return Number(row?.amount || 0);
};

export const nextBudgetVersion = async (db: D1Database, budgetId: string) => {
  const row = await db.prepare(`SELECT COALESCE(MAX(version_no),0)+1 AS version_no FROM accounting_budget_versions WHERE budget_id=?`)
    .bind(budgetId).first<{ version_no: number }>();
  return Number(row?.version_no || 1);
};

export const budgetVersionStatement = (
  db: D1Database,
  budget: any,
  versionNo: number,
  snapshotType: string,
  changeRequestId: string | null,
  effectiveBy: string,
  now: string,
) => db.prepare(`INSERT INTO accounting_budget_versions
  (id,budget_id,version_no,snapshot_type,original_amount,supplementary_amount,transfer_in,transfer_out,memo,change_request_id,effective_by,effective_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
  .bind(`BVER-${randomHex(20)}`, budget.id, versionNo, snapshotType, Number(budget.original_amount || 0), Number(budget.supplementary_amount || 0), Number(budget.transfer_in || 0), Number(budget.transfer_out || 0), budget.memo || null, changeRequestId, effectiveBy, now);

export const getReconciliationBlockers = async (db: D1Database, year: number, month: number) => {
  const prefix = `${year}-${String(month).padStart(2, '0')}`;
  const [unmatched, incomplete] = await db.batch([
    db.prepare(`SELECT COUNT(*) AS count FROM accounting_import_transactions
      WHERE substr(transaction_date,1,7)=? AND status NOT IN ('matched','ignored')`).bind(prefix),
    db.prepare(`SELECT COUNT(*) AS count FROM (
      SELECT DISTINCT t.source_type,b.source_account_id
      FROM accounting_import_transactions t JOIN accounting_import_batches b ON b.id=t.batch_id
      WHERE substr(t.transaction_date,1,7)=?
    ) s LEFT JOIN accounting_reconciliation_periods r
      ON r.fiscal_year=? AND r.period_month=? AND r.source_type=s.source_type
      AND r.source_account_id=s.source_account_id AND r.status='completed'
      WHERE r.id IS NULL`).bind(prefix, year, month),
  ]);
  return {
    unmatched: Number((unmatched.results?.[0] as any)?.count || 0),
    incomplete: Number((incomplete.results?.[0] as any)?.count || 0),
  };
};
