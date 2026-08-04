import { authenticateSession, clean, ensureTables, json } from '../../_shared/helpers';
import { canViewAllAccounting, ensureAccountingTables, hasAccountingAccess, isAccountingManager } from '../../_shared/accounting';
import { getDimensionMaster } from '../../_shared/accounting-special';
import {
  ensureAccountingOperationsTables,
  getBudgetCommittedAmount,
  getBudgetExecutedAmount,
} from '../../_shared/accounting-operations';

interface Env { DB: D1Database; ACCOUNTING_DB: D1Database; }
type Payload = Record<string, unknown> & { token?: string; action?: string };
const currentYear = () => new Date(Date.now() + 9 * 60 * 60 * 1000).getUTCFullYear();
const toYear = (value: unknown) => {
  const year = Number(value || currentYear());
  return Number.isInteger(year) && year >= 2000 && year <= 2200 ? year : currentYear();
};
const toLimit = (value: unknown, fallback = 200) => Math.max(10, Math.min(500, Number(value || fallback) || fallback));

const referenceLabelSql = (prefix: 'suggested' | 'matched') => `CASE
  WHEN t.${prefix}_type='donation' THEN (SELECT d.donation_no||' · '||COALESCE(o.name,'익명') FROM accounting_donations d LEFT JOIN accounting_donors o ON o.id=d.donor_id WHERE d.id=t.${prefix}_id)
  WHEN t.${prefix}_type='resolution' THEN (SELECT r.resolution_no||' · '||r.counterparty FROM accounting_resolutions r WHERE r.id=t.${prefix}_id)
  WHEN t.${prefix}_type='card_transaction' THEN (SELECT c.transaction_no||' · '||c.merchant FROM accounting_card_transactions c WHERE c.id=t.${prefix}_id)
  WHEN t.${prefix}_type='journal' THEN (SELECT j.journal_no||' · '||j.description FROM accounting_journals j WHERE j.id=t.${prefix}_id)
  ELSE NULL END`;

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB || !env.ACCOUNTING_DB) return json({ ok: false, message: '전자문서 DB 또는 회계 전용 DB가 연결되지 않았습니다.' }, 500);
  let payload: Payload;
  try { payload = await request.json(); } catch { return json({ ok: false, message: '요청 형식이 올바르지 않습니다.' }, 400); }
  await ensureTables(env.DB);
  const auth = await authenticateSession(env.DB, clean(payload.token, 200));
  if (!auth.ok) return json({ ok: false, message: auth.message }, auth.status);
  if (!hasAccountingAccess(auth.user)) return json({ ok: false, message: '회계관리 접속 권한이 없습니다.' }, 403);
  await ensureAccountingTables(env.ACCOUNTING_DB);
  await ensureAccountingOperationsTables(env.ACCOUNTING_DB);
  const db = env.ACCOUNTING_DB, me = auth.user, action = clean(payload.action, 60) || 'init', year = toYear(payload.year);
  const manager = isAccountingManager(me), canViewAll = canViewAllAccounting(me), limit = toLimit(payload.limit);

  try {
    if (action === 'init') {
      const [dimensions, accounts, banks, cards, rules, summary, pendingChanges, expiringContracts, exportErrors] = await Promise.all([
        getDimensionMaster(db),
        db.prepare(`SELECT code,name,account_type,normal_side FROM accounting_accounts WHERE active=1 ORDER BY code`).all(),
        db.prepare(`SELECT b.*,a.name AS settlement_account_name,bt.name AS book_type_name,e.name AS entity_name,f.name AS fund_name
          FROM accounting_bank_accounts b LEFT JOIN accounting_accounts a ON a.code=b.settlement_account_code
          LEFT JOIN accounting_book_types bt ON bt.code=b.book_type_code LEFT JOIN accounting_entities e ON e.id=b.entity_id
          LEFT JOIN accounting_funds f ON f.id=b.fund_id WHERE b.active=1 ORDER BY b.account_code`).all(),
        db.prepare(`SELECT c.*,bt.name AS book_type_name,e.name AS entity_name FROM accounting_cards c
          LEFT JOIN accounting_book_types bt ON bt.code=c.book_type_code LEFT JOIN accounting_entities e ON e.id=c.entity_id
          WHERE c.active=1 ORDER BY c.card_code`).all(),
        db.prepare(`SELECT r.*,a.name AS account_name FROM accounting_matching_rules r LEFT JOIN accounting_accounts a ON a.code=r.account_code WHERE r.active=1 ORDER BY r.priority,r.name`).all(),
        db.prepare(`SELECT
          (SELECT COUNT(*) FROM accounting_import_transactions WHERE status='unmatched') AS unmatched,
          (SELECT COUNT(*) FROM accounting_import_transactions WHERE status='suggested') AS suggested,
          (SELECT COUNT(*) FROM accounting_import_transactions WHERE status='matched') AS matched,
          (SELECT COUNT(*) FROM accounting_reconciliation_periods WHERE status='completed' AND fiscal_year=?) AS reconciled_periods,
          (SELECT COUNT(*) FROM accounting_budget_change_requests WHERE status='pending' AND fiscal_year=?) AS pending_budget_changes,
          (SELECT COUNT(*) FROM accounting_vendor_bank_changes WHERE status='pending') AS pending_bank_changes`).bind(year, year).first(),
        db.prepare(`SELECT COUNT(*) AS count FROM accounting_budget_change_requests WHERE status='pending' AND fiscal_year=?`).bind(year).first(),
        db.prepare(`SELECT COUNT(*) AS count FROM accounting_contracts WHERE status='active' AND date(end_date)<=date('now','+45 days')`).first(),
        db.prepare(`SELECT COALESCE(SUM(error_count),0) AS count FROM accounting_donation_export_batches WHERE fiscal_year=? AND status='processed_with_errors'`).bind(year).first(),
      ]);
      return json({ ok: true, me, year, permissions: { manager, canViewAll, audit: me.role === 'audit' }, ...dimensions, accounts: accounts.results || [], bankAccounts: banks.results || [], cards: cards.results || [], rules: rules.results || [], summary: summary || {}, alerts: { pendingBudgetChanges: Number((pendingChanges as any)?.count || 0), expiringContracts: Number((expiringContracts as any)?.count || 0), donationErrors: Number((exportErrors as any)?.count || 0) } });
    }

    if (action === 'transactions') {
      const conditions = ['1=1'], values: unknown[] = [];
      const status = clean(payload.status, 30), sourceType = clean(payload.sourceType, 20), batchId = clean(payload.batchId, 80), q = clean(payload.query, 120);
      if (status) { conditions.push('t.status=?'); values.push(status); }
      if (sourceType) { conditions.push('t.source_type=?'); values.push(sourceType); }
      if (batchId) { conditions.push('t.batch_id=?'); values.push(batchId); }
      if (q) { conditions.push('(t.description LIKE ? OR t.counterparty LIKE ? OR t.approval_no LIKE ?)'); values.push(`%${q}%`, `%${q}%`, `%${q}%`); }
      const rows = await db.prepare(`SELECT t.*,b.batch_no,b.source_account_id,
        CASE WHEN t.source_type='bank' THEN ba.account_alias ELSE c.card_label END AS source_name,
        a.name AS classification_account_name,${referenceLabelSql('suggested')} AS suggested_label,${referenceLabelSql('matched')} AS matched_label
        FROM accounting_import_transactions t JOIN accounting_import_batches b ON b.id=t.batch_id
        LEFT JOIN accounting_bank_accounts ba ON t.source_type='bank' AND ba.id=b.source_account_id
        LEFT JOIN accounting_cards c ON t.source_type='card' AND c.id=b.source_account_id
        LEFT JOIN accounting_accounts a ON a.code=t.classification_account_code
        WHERE ${conditions.join(' AND ')} ORDER BY t.transaction_date DESC,t.created_at DESC,t.id DESC LIMIT ${limit}`)
        .bind(...values).all();
      const batches = await db.prepare(`SELECT b.*,CASE WHEN b.source_type='bank' THEN ba.account_alias ELSE c.card_label END AS source_name
        FROM accounting_import_batches b LEFT JOIN accounting_bank_accounts ba ON b.source_type='bank' AND ba.id=b.source_account_id
        LEFT JOIN accounting_cards c ON b.source_type='card' AND c.id=b.source_account_id ORDER BY b.created_at DESC LIMIT 100`).all();
      return json({ ok: true, rows: rows.results || [], batches: batches.results || [], limit });
    }

    if (action === 'match-candidates') {
      const id = clean(payload.id, 80), tx = await db.prepare(`SELECT * FROM accounting_import_transactions WHERE id=?`).bind(id).first<any>();
      if (!tx) return json({ ok: false, message: '거래내역을 찾을 수 없습니다.' }, 404);
      const amount = Number(tx.amount || 0), date = tx.transaction_date;
      const [donations, resolutions, cards, journals] = await db.batch([
        db.prepare(`SELECT 'donation' AS match_type,d.id,d.donation_no AS reference_no,d.donation_date AS reference_date,COALESCE(o.name,'익명') AS name,d.amount
          FROM accounting_donations d LEFT JOIN accounting_donors o ON o.id=d.donor_id
          WHERE d.amount=? AND ABS(julianday(d.donation_date)-julianday(?))<=14 ORDER BY ABS(julianday(d.donation_date)-julianday(?)),d.created_at LIMIT 20`).bind(amount, date, date),
        db.prepare(`SELECT 'resolution' AS match_type,r.id,r.resolution_no AS reference_no,r.resolution_date AS reference_date,r.counterparty AS name,r.amount
          FROM accounting_resolutions r WHERE r.amount=? AND ABS(julianday(r.resolution_date)-julianday(?))<=14
          ORDER BY ABS(julianday(r.resolution_date)-julianday(?)),r.created_at LIMIT 30`).bind(amount, date, date),
        db.prepare(`SELECT 'card_transaction' AS match_type,c.id,c.transaction_no AS reference_no,c.transaction_date AS reference_date,c.merchant AS name,c.amount
          FROM accounting_card_transactions c WHERE c.amount=? AND ABS(julianday(c.transaction_date)-julianday(?))<=14
          ORDER BY ABS(julianday(c.transaction_date)-julianday(?)),c.created_at LIMIT 20`).bind(amount, date, date),
        db.prepare(`SELECT 'journal' AS match_type,j.id,j.journal_no AS reference_no,j.journal_date AS reference_date,j.description AS name,
          MAX(l.debit,l.credit) AS amount FROM accounting_journals j JOIN accounting_journal_lines l ON l.journal_id=j.id
          WHERE MAX(l.debit,l.credit)=? AND ABS(julianday(j.journal_date)-julianday(?))<=14
          GROUP BY j.id ORDER BY ABS(julianday(j.journal_date)-julianday(?)),j.created_at LIMIT 20`).bind(amount, date, date),
      ]);
      return json({ ok: true, transaction: tx, rows: [...(donations.results || []), ...(resolutions.results || []), ...(cards.results || []), ...(journals.results || [])] });
    }

    if (action === 'reconciliations') {
      const rows = await db.prepare(`SELECT r.*,CASE WHEN r.source_type='bank' THEN ba.account_alias ELSE c.card_label END AS source_name,
        a.name AS settlement_account_name FROM accounting_reconciliation_periods r
        LEFT JOIN accounting_bank_accounts ba ON r.source_type='bank' AND ba.id=r.source_account_id
        LEFT JOIN accounting_cards c ON r.source_type='card' AND c.id=r.source_account_id
        LEFT JOIN accounting_accounts a ON a.code=r.settlement_account_code WHERE r.fiscal_year=?
        ORDER BY r.period_month DESC,r.source_type,r.source_account_id`).bind(year).all();
      return json({ ok: true, rows: rows.results || [] });
    }

    if (action === 'budgets') {
      const result = await db.prepare(`SELECT b.*,a.name AS account_name,bt.name AS book_type_name,e.name AS entity_name,f.name AS fund_name
        FROM accounting_budget_plans b JOIN accounting_accounts a ON a.code=b.account_code
        LEFT JOIN accounting_book_types bt ON bt.code=b.book_type_code LEFT JOIN accounting_entities e ON e.id=b.entity_id
        LEFT JOIN accounting_funds f ON f.id=b.fund_id WHERE b.fiscal_year=? ORDER BY b.department,b.project,b.account_code`).bind(year).all<any>();
      const rows = [];
      for (const budget of result.results || []) {
        const executed = await getBudgetExecutedAmount(db, budget), committed = await getBudgetCommittedAmount(db, budget);
        const revised = Number(budget.original_amount || 0) + Number(budget.supplementary_amount || 0) + Number(budget.transfer_in || 0) - Number(budget.transfer_out || 0);
        rows.push({ ...budget, revised_amount: revised, executed_amount: executed, committed_amount: committed, available_amount: revised - executed - committed });
      }
      const changes = await db.prepare(`SELECT c.*,t.department AS target_department,t.project AS target_project,t.account_code AS target_account_code,ta.name AS target_account_name,
        s.department AS source_department,s.project AS source_project,s.account_code AS source_account_code,sa.name AS source_account_name
        FROM accounting_budget_change_requests c JOIN accounting_budget_plans t ON t.id=c.target_budget_id
        JOIN accounting_accounts ta ON ta.code=t.account_code LEFT JOIN accounting_budget_plans s ON s.id=c.source_budget_id
        LEFT JOIN accounting_accounts sa ON sa.code=s.account_code WHERE c.fiscal_year=? ORDER BY c.requested_at DESC`).bind(year).all();
      return json({ ok: true, rows, changes: changes.results || [] });
    }

    if (action === 'budget-versions') {
      const budgetId = clean(payload.budgetId, 100);
      const rows = await db.prepare(`SELECT v.*,c.request_no,c.reason FROM accounting_budget_versions v
        LEFT JOIN accounting_budget_change_requests c ON c.id=v.change_request_id WHERE v.budget_id=? ORDER BY v.version_no DESC`).bind(budgetId).all();
      return json({ ok: true, rows: rows.results || [] });
    }

    if (action === 'vendors') {
      const q = clean(payload.query, 120), conditions = ['v.active=1'], values: unknown[] = [];
      if (q) { conditions.push('(v.name LIKE ? OR v.vendor_code LIKE ? OR v.business_no LIKE ?)'); values.push(`%${q}%`, `%${q}%`, `%${q}%`); }
      const rows = await db.prepare(`SELECT v.*,
        (SELECT COUNT(*) FROM accounting_contracts c WHERE c.vendor_id=v.id AND c.status IN ('active','approved')) AS active_contracts,
        (SELECT COUNT(*) FROM accounting_vendor_bank_changes b WHERE b.vendor_id=v.id AND b.status='pending') AS pending_bank_changes
        FROM accounting_vendors v WHERE ${conditions.join(' AND ')} ORDER BY v.name LIMIT ${limit}`).bind(...values).all();
      const bankChanges = await db.prepare(`SELECT b.*,v.vendor_code,v.name AS vendor_name FROM accounting_vendor_bank_changes b
        JOIN accounting_vendors v ON v.id=b.vendor_id ORDER BY CASE b.status WHEN 'pending' THEN 0 ELSE 1 END,b.requested_at DESC LIMIT 100`).all();
      return json({ ok: true, rows: rows.results || [], bankChanges: bankChanges.results || [] });
    }

    if (action === 'contracts') {
      const q = clean(payload.query, 120), status = clean(payload.status, 30), conditions = ['substr(c.contract_date,1,4)=?'], values: unknown[] = [String(year)];
      if (status) { conditions.push('c.status=?'); values.push(status); }
      if (q) { conditions.push('(c.title LIKE ? OR c.contract_no LIKE ? OR v.name LIKE ?)'); values.push(`%${q}%`, `%${q}%`, `%${q}%`); }
      const rows = await db.prepare(`SELECT c.*,v.vendor_code,v.name AS vendor_name,a.name AS account_name,bt.name AS book_type_name,e.name AS entity_name,f.name AS fund_name,
        COALESCE(p.scheduled_amount,0) AS scheduled_amount,COALESCE(p.paid_amount,0) AS paid_amount,COALESCE(p.payment_count,0) AS payment_count,
        CAST(julianday(c.end_date)-julianday(date('now')) AS INTEGER) AS days_to_end
        FROM accounting_contracts c JOIN accounting_vendors v ON v.id=c.vendor_id JOIN accounting_accounts a ON a.code=c.account_code
        LEFT JOIN accounting_book_types bt ON bt.code=c.book_type_code LEFT JOIN accounting_entities e ON e.id=c.entity_id LEFT JOIN accounting_funds f ON f.id=c.fund_id
        LEFT JOIN (SELECT contract_id,SUM(amount) AS scheduled_amount,SUM(CASE WHEN status='paid' THEN amount ELSE 0 END) AS paid_amount,COUNT(*) AS payment_count FROM accounting_contract_payments GROUP BY contract_id) p ON p.contract_id=c.id
        WHERE ${conditions.join(' AND ')} ORDER BY CASE c.status WHEN 'active' THEN 0 ELSE 1 END,c.end_date,c.contract_no LIMIT ${limit}`).bind(...values).all();
      return json({ ok: true, rows: rows.results || [] });
    }

    if (action === 'contract-detail') {
      const id = clean(payload.id, 80);
      const contract = await db.prepare(`SELECT c.*,v.name AS vendor_name,v.business_no,v.bank_name,v.bank_account_masked,v.bank_account_holder,a.name AS account_name
        FROM accounting_contracts c JOIN accounting_vendors v ON v.id=c.vendor_id JOIN accounting_accounts a ON a.code=c.account_code WHERE c.id=?`).bind(id).first<any>();
      if (!contract) return json({ ok: false, message: '계약을 찾을 수 없습니다.' }, 404);
      const [payments, resolutions] = await db.batch([
        db.prepare(`SELECT p.*,r.resolution_no,r.title AS resolution_title,j.journal_no FROM accounting_contract_payments p
          LEFT JOIN accounting_resolutions r ON r.id=p.resolution_id LEFT JOIN accounting_journals j ON j.id=p.journal_id WHERE p.contract_id=? ORDER BY p.payment_seq`).bind(id),
        db.prepare(`SELECT r.id,r.resolution_no,r.resolution_date,r.title,r.counterparty,r.amount,r.status,r.journal_id,j.journal_no
          FROM accounting_resolutions r LEFT JOIN accounting_journals j ON j.id=r.journal_id
          WHERE r.resolution_type='expense' AND r.fiscal_year=? AND (r.contract_id IS NULL OR r.contract_id=?)
          ORDER BY r.resolution_date DESC,r.created_at DESC LIMIT 150`).bind(Number(contract.contract_date.slice(0, 4)), id),
      ]);
      return json({ ok: true, contract, payments: payments.results || [], resolutions: resolutions.results || [] });
    }

    if (action === 'donation-export-candidates') {
      const rows = await db.prepare(`SELECT d.id,d.donation_no,d.donation_date,d.amount,d.receipt_status,d.receipt_no,d.receipt_donation_code,d.receipt_description,
        d.receipt_org_name,d.receipt_org_registration_no,d.receipt_org_address,o.donor_type,o.name AS donor_name,o.identifier_masked,o.phone,o.email,o.address AS donor_address,
        e.name AS entity_name,e.registration_no AS entity_registration_no
        FROM accounting_donations d JOIN accounting_donors o ON o.id=d.donor_id LEFT JOIN accounting_entities e ON e.id=d.entity_id
        WHERE d.fiscal_year=? AND d.receipt_status NOT IN ('issued') ORDER BY d.donation_date,d.donation_no LIMIT 500`).bind(year).all();
      const batches = await db.prepare(`SELECT * FROM accounting_donation_export_batches WHERE fiscal_year=? ORDER BY created_at DESC LIMIT 100`).bind(year).all();
      return json({ ok: true, rows: rows.results || [], batches: batches.results || [] });
    }

    if (action === 'donation-export-detail') {
      const id = clean(payload.id, 80);
      const batch = await db.prepare(`SELECT * FROM accounting_donation_export_batches WHERE id=?`).bind(id).first<any>();
      if (!batch) return json({ ok: false, message: '일괄처리 이력을 찾을 수 없습니다.' }, 404);
      const rows = await db.prepare(`SELECT i.*,d.donation_date,d.amount,d.receipt_status,d.receipt_no,d.receipt_donation_code,d.receipt_description,
        d.receipt_org_name,d.receipt_org_registration_no,d.receipt_org_address,o.donor_type,o.name AS donor_name,o.identifier_masked,o.phone,o.email,o.address AS donor_address,
        e.name AS entity_name,e.registration_no AS entity_registration_no
        FROM accounting_donation_export_items i JOIN accounting_donations d ON d.id=i.donation_id
        JOIN accounting_donors o ON o.id=d.donor_id LEFT JOIN accounting_entities e ON e.id=d.entity_id
        WHERE i.batch_id=? ORDER BY d.donation_date,d.donation_no`).bind(id).all();
      return json({ ok: true, batch, rows: rows.results || [] });
    }

    return json({ ok: false, message: '지원하지 않는 실무 회계조회입니다.' }, 400);
  } catch (error) {
    console.error('accounting operations query failed', action, error);
    return json({ ok: false, message: error instanceof Error ? error.message : '실무 회계자료 조회 중 오류가 발생했습니다.' }, 500);
  }
};

export const onRequestGet: PagesFunction = async () => json({ ok: false, message: 'POST 방식으로 요청해 주세요.' }, 405);
