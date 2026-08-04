import { authenticateSession, clean, ensureTables, json, randomHex } from '../../_shared/helpers';
import { ensureAccountingTables, hasAccountingAccess, isAccountingManager, parseMoney } from '../../_shared/accounting';
import { nextSpecialNumber, validateDimensions } from '../../_shared/accounting-special';
import {
  budgetVersionStatement,
  ensureAccountingOperationsTables,
  getBudgetCommittedAmount,
  getBudgetExecutedAmount,
  getSourceSettlement,
  maskBankAccount,
  nextBudgetVersion,
  nextOperationNumber,
  normalizeBusinessNo,
  normalizeMatchText,
  operationAudit,
  sha256Hex,
  validAccountingDate,
} from '../../_shared/accounting-operations';

interface Env { DB: D1Database; ACCOUNTING_DB: D1Database; }
type Payload = Record<string, unknown> & { token?: string; action?: string };

const validYear = (value: unknown) => {
  const year = Number(value);
  return Number.isInteger(year) && year >= 2000 && year <= 2200 ? year : 0;
};
const listIds = (value: unknown, max = 500) => Array.isArray(value)
  ? [...new Set(value.map((item) => clean(item, 100)).filter(Boolean))].slice(0, max) : [];
const chunks = <T>(items: T[], size: number) => {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
};
const runStatements = async (db: D1Database, statements: D1PreparedStatement[]) => {
  for (const group of chunks(statements, 80)) await db.batch(group);
};

const candidateForTransaction = async (db: D1Database, tx: any) => {
  const transactionText = normalizeMatchText(`${tx.counterparty || ''} ${tx.description || ''}`);
  let candidates: Array<{ type: string; id: string; date: string; name: string; amount: number; approvalNo?: string }> = [];
  if (tx.source_type === 'bank' && tx.direction === 'in') {
    const rows = await db.prepare(`SELECT d.id,d.donation_date AS date,COALESCE(o.name,'익명') AS name,d.amount
      FROM accounting_donations d LEFT JOIN accounting_donors o ON o.id=d.donor_id
      WHERE d.amount=? AND ABS(julianday(d.donation_date)-julianday(?))<=5
      ORDER BY ABS(julianday(d.donation_date)-julianday(?)),d.created_at LIMIT 12`)
      .bind(tx.amount, tx.transaction_date, tx.transaction_date).all<any>();
    candidates = (rows.results || []).map((row: any) => ({ type: 'donation', id: row.id, date: row.date, name: row.name, amount: Number(row.amount) }));
  } else {
    const rows = await db.prepare(`SELECT r.id,r.resolution_date AS date,r.counterparty AS name,r.amount
      FROM accounting_resolutions r
      WHERE r.resolution_type='expense' AND r.amount=?
        AND ABS(julianday(r.resolution_date)-julianday(?))<=7
      ORDER BY ABS(julianday(r.resolution_date)-julianday(?)),r.created_at LIMIT 15`)
      .bind(tx.amount, tx.transaction_date, tx.transaction_date).all<any>();
    candidates = (rows.results || []).map((row: any) => ({ type: 'resolution', id: row.id, date: row.date, name: row.name, amount: Number(row.amount) }));
    if (tx.source_type === 'card') {
      const cardRows = await db.prepare(`SELECT c.id,c.transaction_date AS date,c.merchant AS name,c.amount,c.transaction_no AS approval_no
        FROM accounting_card_transactions c JOIN accounting_import_batches b ON b.source_account_id=c.card_id
        WHERE b.id=? AND c.amount=? AND ABS(julianday(c.transaction_date)-julianday(?))<=3
        ORDER BY ABS(julianday(c.transaction_date)-julianday(?)),c.created_at LIMIT 10`)
        .bind(tx.batch_id, tx.amount, tx.transaction_date, tx.transaction_date).all<any>();
      candidates.unshift(...(cardRows.results || []).map((row: any) => ({ type: 'card_transaction', id: row.id, date: row.date, name: row.name, amount: Number(row.amount), approvalNo: row.approval_no })));
    }
  }
  let best: any = null;
  for (const candidate of candidates) {
    const used = await db.prepare(`SELECT 1 AS yes FROM accounting_import_transactions
      WHERE status='matched' AND matched_type=? AND matched_id=? AND id<>? LIMIT 1`)
      .bind(candidate.type, candidate.id, tx.id).first<{ yes: number }>();
    if (used) continue;
    const days = Math.abs((Date.parse(`${candidate.date}T00:00:00Z`) - Date.parse(`${tx.transaction_date}T00:00:00Z`)) / 86400000);
    const candidateText = normalizeMatchText(candidate.name);
    const nameMatch = !!candidateText && !!transactionText && (candidateText.includes(transactionText) || transactionText.includes(candidateText));
    const approvalMatch = !!tx.approval_no && !!candidate.approvalNo && normalizeMatchText(tx.approval_no) === normalizeMatchText(candidate.approvalNo);
    const score = Math.min(100, 60 + (days === 0 ? 20 : Math.max(0, 15 - days * 3)) + (nameMatch ? 20 : 0) + (approvalMatch ? 20 : 0));
    if (!best || score > best.score) best = { ...candidate, score, reason: `금액 일치 · 날짜 ${days === 0 ? '일치' : `${days}일 차이`}${nameMatch ? ' · 거래처 일치' : ''}${approvalMatch ? ' · 승인번호 일치' : ''}` };
  }
  return best;
};

const applyMatchingSuggestion = async (db: D1Database, tx: any, user: any, now: string) => {
  const best = await candidateForTransaction(db, tx);
  if (best && best.score >= 70) {
    if (best.score >= 95) {
      await db.batch([
        db.prepare(`UPDATE accounting_import_transactions SET status='matched',suggested_type=?,suggested_id=?,suggested_score=?,suggested_reason=?,matched_type=?,matched_id=?,matched_by=?,matched_at=?,updated_at=? WHERE id=?`)
          .bind(best.type, best.id, best.score, best.reason, best.type, best.id, '자동대사', now, now, tx.id),
        operationAudit(db, 'auto-match', 'import-transaction', tx.id, user, { matchedType: best.type, matchedId: best.id, score: best.score }, now),
      ]);
      return 'matched';
    }
    await db.prepare(`UPDATE accounting_import_transactions SET status='suggested',suggested_type=?,suggested_id=?,suggested_score=?,suggested_reason=?,updated_at=? WHERE id=?`)
      .bind(best.type, best.id, best.score, best.reason, now, tx.id).run();
    return 'suggested';
  }
  return 'unmatched';
};

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
  const db = env.ACCOUNTING_DB;
  const me = auth.user;
  const manager = isAccountingManager(me);
  const action = clean(payload.action, 60);
  if (me.role === 'audit') return json({ ok: false, message: '감사 계정은 실무 회계자료를 변경할 수 없습니다.' }, 403);

  try {
    if (action === 'save-bank-account') {
      if (!manager) return json({ ok: false, message: '계좌 등록 권한이 없습니다.' }, 403);
      const id = clean(payload.id, 80) || `BANK-${randomHex(20)}`;
      const code = clean(payload.accountCode, 40).replace(/[^0-9A-Za-z가-힣_-]/g, '');
      const bankName = clean(payload.bankName, 80), alias = clean(payload.accountAlias, 100);
      const settlement = clean(payload.settlementAccountCode, 20) || '1120';
      if (!code || !bankName || !alias) return json({ ok: false, message: '계좌 코드·은행·계좌명을 입력해 주세요.' }, 400);
      const dimensions = await validateDimensions(db, payload);
      const account = await db.prepare(`SELECT code FROM accounting_accounts WHERE code=? AND account_type='asset' AND active=1`).bind(settlement).first();
      if (!account) return json({ ok: false, message: '입출금 자산 계정과목을 확인해 주세요.' }, 400);
      const now = new Date().toISOString();
      await db.batch([
        db.prepare(`INSERT INTO accounting_bank_accounts
          (id,account_code,bank_name,account_alias,masked_number,settlement_account_code,book_type_code,entity_id,fund_id,active,created_by,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,1,?,?,?)
          ON CONFLICT(id) DO UPDATE SET account_code=excluded.account_code,bank_name=excluded.bank_name,account_alias=excluded.account_alias,
          masked_number=excluded.masked_number,settlement_account_code=excluded.settlement_account_code,book_type_code=excluded.book_type_code,
          entity_id=excluded.entity_id,fund_id=excluded.fund_id,active=1,updated_at=excluded.updated_at`)
          .bind(id, code, bankName, alias, maskBankAccount(payload.accountNumber), settlement, dimensions.bookTypeCode, dimensions.entityId, dimensions.fundId, me.name, now, now),
        operationAudit(db, 'save', 'bank-account', id, me, { code, bankName, alias, settlement, ...dimensions }, now),
      ]);
      return json({ ok: true, id, message: '대사 대상 계좌를 저장했습니다.' });
    }

    if (action === 'save-matching-rule') {
      if (!manager) return json({ ok: false, message: '자동분류 규칙 관리 권한이 없습니다.' }, 403);
      const id = clean(payload.id, 80) || `RULE-${randomHex(20)}`;
      const name = clean(payload.name, 100), keyword = clean(payload.keyword, 100), accountCode = clean(payload.accountCode, 20);
      const sourceType = clean(payload.sourceType, 20) || 'all', direction = clean(payload.direction, 20) || 'all';
      if (!name || !keyword || !accountCode || !['all', 'bank', 'card'].includes(sourceType) || !['all', 'in', 'out'].includes(direction)) return json({ ok: false, message: '자동분류 규칙을 정확히 입력해 주세요.' }, 400);
      const account = await db.prepare(`SELECT code FROM accounting_accounts WHERE code=? AND active=1`).bind(accountCode).first();
      if (!account) return json({ ok: false, message: '계정과목을 확인해 주세요.' }, 400);
      const now = new Date().toISOString();
      await db.batch([
        db.prepare(`INSERT INTO accounting_matching_rules (id,name,source_type,direction,keyword,account_code,counterparty_alias,priority,active,created_by,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,1,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,source_type=excluded.source_type,direction=excluded.direction,
          keyword=excluded.keyword,account_code=excluded.account_code,counterparty_alias=excluded.counterparty_alias,priority=excluded.priority,active=1,updated_at=excluded.updated_at`)
          .bind(id, name, sourceType, direction, keyword, accountCode, clean(payload.counterpartyAlias, 120) || null, Math.max(1, Math.min(999, Number(payload.priority || 100))), me.name, now, now),
        operationAudit(db, 'save', 'matching-rule', id, me, { name, sourceType, direction, keyword, accountCode }, now),
      ]);
      return json({ ok: true, id, message: '자동분류 규칙을 저장했습니다.' });
    }

    if (action === 'import-transactions') {
      if (!manager) return json({ ok: false, message: '거래내역 가져오기 권한이 없습니다.' }, 403);
      const sourceType = clean(payload.sourceType, 20), sourceAccountId = clean(payload.sourceAccountId, 80);
      if (!['bank', 'card'].includes(sourceType)) return json({ ok: false, message: '통장 또는 법인카드 자료 유형을 선택해 주세요.' }, 400);
      await getSourceSettlement(db, sourceType, sourceAccountId);
      const rows = Array.isArray(payload.rows) ? (payload.rows as Array<Record<string, unknown>>).slice(0, 1000) : [];
      if (!rows.length) return json({ ok: false, message: '가져올 거래내역이 없습니다.' }, 400);
      const year = validYear(String(rows[0]?.transactionDate || '').slice(0, 4)) || new Date().getUTCFullYear();
      const batchNo = await nextOperationNumber(db, 'import', year), batchId = `IMB-${randomHex(24)}`, now = new Date().toISOString();
      const rules = await db.prepare(`SELECT * FROM accounting_matching_rules WHERE active=1 AND source_type IN ('all',?) ORDER BY priority,id`).bind(sourceType).all<any>();
      const statements: D1PreparedStatement[] = [];
      let imported = 0, duplicates = 0, invalid = 0;
      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index];
        const date = clean(row.transactionDate, 10), direction = clean(row.direction, 10), amount = Math.abs(parseMoney(row.amount));
        if (!validAccountingDate(date) || !['in', 'out'].includes(direction) || amount <= 0) { invalid += 1; continue; }
        const description = clean(row.description, 300), counterparty = clean(row.counterparty, 160), approvalNo = clean(row.approvalNo, 100);
        const externalKey = await sha256Hex([sourceType, sourceAccountId, date, direction, amount, approvalNo, counterparty, description, clean(row.sequence, 30) || String(index + 1), clean(row.balance, 40)].join('|'));
        const exists = await db.prepare(`SELECT id FROM accounting_import_transactions WHERE external_key=?`).bind(externalKey).first();
        if (exists) { duplicates += 1; continue; }
        const text = normalizeMatchText(`${counterparty} ${description}`);
        const rule = (rules.results || []).find((item: any) => (item.direction === 'all' || item.direction === direction) && text.includes(normalizeMatchText(item.keyword)));
        const id = `IMT-${randomHex(24)}`;
        statements.push(db.prepare(`INSERT INTO accounting_import_transactions
          (id,batch_id,source_type,external_key,transaction_date,posted_date,direction,description,counterparty,amount,tax_amount,balance,approval_no,original_json,classification_account_code,status,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .bind(id, batchId, sourceType, externalKey, date, clean(row.postedDate, 10) || null, direction, description, counterparty, amount, Math.abs(parseMoney(row.taxAmount)), row.balance === '' || row.balance == null ? null : parseMoney(row.balance), approvalNo || null, JSON.stringify(row), rule?.account_code || null, 'unmatched', now, now));
        imported += 1;
      }
      await db.prepare(`INSERT INTO accounting_import_batches
        (id,batch_no,source_type,source_account_id,period_start,period_end,statement_balance,original_filename,total_rows,imported_rows,duplicate_rows,status,created_by,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(batchId, batchNo, sourceType, sourceAccountId, clean(payload.periodStart, 10) || null, clean(payload.periodEnd, 10) || null, payload.statementBalance === '' || payload.statementBalance == null ? null : parseMoney(payload.statementBalance), clean(payload.filename, 200) || null, rows.length, imported, duplicates, 'imported', me.name, now, now).run();
      await runStatements(db, statements);
      await db.batch([operationAudit(db, 'import', 'import-batch', batchId, me, { batchNo, sourceType, sourceAccountId, total: rows.length, imported, duplicates, invalid }, now)]);
      return json({ ok: true, id: batchId, batchNo, imported, duplicates, invalid, message: `${imported}건을 가져왔습니다. 중복 ${duplicates}건, 형식오류 ${invalid}건은 제외했습니다.` });
    }

    if (action === 'auto-match') {
      if (!manager) return json({ ok: false, message: '자동대사 실행 권한이 없습니다.' }, 403);
      const batchId = clean(payload.batchId, 80);
      const rows = await db.prepare(`SELECT * FROM accounting_import_transactions WHERE status IN ('unmatched','suggested') ${batchId ? 'AND batch_id=?' : ''} ORDER BY transaction_date,id LIMIT 250`)
        .bind(...(batchId ? [batchId] : [])).all<any>();
      const counts = { matched: 0, suggested: 0, unmatched: 0 };
      const now = new Date().toISOString();
      for (const row of rows.results || []) counts[await applyMatchingSuggestion(db, row, me, now) as keyof typeof counts] += 1;
      if (batchId) await db.prepare(`UPDATE accounting_import_batches SET status=?,updated_at=? WHERE id=?`).bind(counts.unmatched || counts.suggested ? 'reconciling' : 'reconciled', now, batchId).run();
      return json({ ok: true, ...counts, processed: (rows.results || []).length, message: `자동확정 ${counts.matched}건, 확인필요 ${counts.suggested}건, 미매칭 ${counts.unmatched}건입니다.` });
    }

    if (action === 'confirm-match' || action === 'unmatch' || action === 'ignore-transaction') {
      if (!manager) return json({ ok: false, message: '대사 처리 권한이 없습니다.' }, 403);
      const id = clean(payload.id, 80), now = new Date().toISOString();
      const tx = await db.prepare(`SELECT * FROM accounting_import_transactions WHERE id=?`).bind(id).first<any>();
      if (!tx) return json({ ok: false, message: '거래내역을 찾을 수 없습니다.' }, 404);
      if (action === 'confirm-match') {
        const type = clean(payload.matchType, 40) || tx.suggested_type, matchId = clean(payload.matchId, 100) || tx.suggested_id;
        if (!type || !matchId || !['donation', 'resolution', 'card_transaction', 'journal'].includes(type)) return json({ ok: false, message: '연결할 회계자료를 선택해 주세요.' }, 400);
        const duplicate = await db.prepare(`SELECT id FROM accounting_import_transactions WHERE status='matched' AND matched_type=? AND matched_id=? AND id<>?`).bind(type, matchId, id).first();
        if (duplicate) return json({ ok: false, message: '선택한 회계자료는 다른 거래와 이미 대사되었습니다.' }, 409);
        await db.batch([
          db.prepare(`UPDATE accounting_import_transactions SET status='matched',matched_type=?,matched_id=?,matched_by=?,matched_at=?,updated_at=? WHERE id=?`).bind(type, matchId, me.name, now, now, id),
          operationAudit(db, 'match', 'import-transaction', id, me, { type, matchId }, now),
        ]);
        return json({ ok: true, message: '거래와 회계자료를 대사했습니다.' });
      }
      if (action === 'ignore-transaction') {
        const reason = clean(payload.reason, 300);
        if (!reason) return json({ ok: false, message: '대사 제외 사유를 입력해 주세요.' }, 400);
        await db.batch([
          db.prepare(`UPDATE accounting_import_transactions SET status='ignored',suggested_reason=?,matched_type=NULL,matched_id=NULL,matched_by=?,matched_at=?,updated_at=? WHERE id=?`).bind(`제외: ${reason}`, me.name, now, now, id),
          operationAudit(db, 'ignore', 'import-transaction', id, me, { reason }, now),
        ]);
        return json({ ok: true, message: '대사 제외 사유를 기록했습니다.' });
      }
      await db.batch([
        db.prepare(`UPDATE accounting_import_transactions SET status='unmatched',matched_type=NULL,matched_id=NULL,matched_by=NULL,matched_at=NULL,updated_at=? WHERE id=?`).bind(now, id),
        operationAudit(db, 'unmatch', 'import-transaction', id, me, {}, now),
      ]);
      return json({ ok: true, message: '대사 연결을 해제했습니다.' });
    }

    if (action === 'complete-reconciliation') {
      if (!manager) return json({ ok: false, message: '월 대사 확정 권한이 없습니다.' }, 403);
      const year = validYear(payload.year), month = Number(payload.month), sourceType = clean(payload.sourceType, 20), sourceAccountId = clean(payload.sourceAccountId, 80);
      if (!year || month < 1 || month > 12 || !['bank', 'card'].includes(sourceType)) return json({ ok: false, message: '대사 연월과 자료 유형을 확인해 주세요.' }, 400);
      const source = await getSourceSettlement(db, sourceType, sourceAccountId), prefix = `${year}-${String(month).padStart(2, '0')}`;
      const [counts, book] = await db.batch([
        db.prepare(`SELECT COUNT(*) AS total,SUM(CASE WHEN t.status NOT IN ('matched','ignored') THEN 1 ELSE 0 END) AS unmatched
          FROM accounting_import_transactions t JOIN accounting_import_batches b ON b.id=t.batch_id
          WHERE b.source_account_id=? AND t.source_type=? AND substr(t.transaction_date,1,7)=?`).bind(sourceAccountId, sourceType, prefix),
        db.prepare(`SELECT COALESCE(SUM(CASE WHEN a.normal_side='debit' THEN l.debit-l.credit ELSE l.credit-l.debit END),0) AS balance
          FROM accounting_journal_lines l JOIN accounting_journals j ON j.id=l.journal_id JOIN accounting_accounts a ON a.code=l.account_code
          LEFT JOIN accounting_journal_line_dimensions d ON d.journal_line_id=l.id
          WHERE j.status IN ('posted','reversed') AND j.journal_date<=? AND l.account_code=?
            AND COALESCE(d.book_type_code,'general')=? AND COALESCE(d.entity_id,'ENTITY-HQ')=? AND COALESCE(d.fund_id,'')=?`)
          .bind(`${prefix}-31`, source.settlement_account_code, source.book_type_code || 'general', source.entity_id || 'ENTITY-HQ', source.fund_id || ''),
      ]);
      const total = Number((counts.results?.[0] as any)?.total || 0), unmatched = Number((counts.results?.[0] as any)?.unmatched || 0);
      if (!total) return json({ ok: false, message: '해당 월에 가져온 거래내역이 없습니다.' }, 400);
      const bookBalance = Number((book.results?.[0] as any)?.balance || 0);
      const statementBalance = payload.statementBalance === '' || payload.statementBalance == null ? null : parseMoney(payload.statementBalance);
      if (sourceType === 'bank' && statementBalance == null) return json({ ok: false, message: '통장 월말잔액을 입력해 주세요.' }, 400);
      const difference = sourceType === 'bank' ? Number(statementBalance) - bookBalance : 0;
      const completed = unmatched === 0 && difference === 0;
      const id = `RECON-${year}-${String(month).padStart(2, '0')}-${sourceType}-${sourceAccountId}`, now = new Date().toISOString();
      await db.batch([
        db.prepare(`INSERT INTO accounting_reconciliation_periods
          (id,fiscal_year,period_month,source_type,source_account_id,settlement_account_code,statement_balance,book_balance,difference_amount,transaction_count,unmatched_count,status,completed_by,completed_at,memo,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(fiscal_year,period_month,source_type,source_account_id)
          DO UPDATE SET settlement_account_code=excluded.settlement_account_code,statement_balance=excluded.statement_balance,book_balance=excluded.book_balance,
          difference_amount=excluded.difference_amount,transaction_count=excluded.transaction_count,unmatched_count=excluded.unmatched_count,status=excluded.status,
          completed_by=excluded.completed_by,completed_at=excluded.completed_at,memo=excluded.memo,updated_at=excluded.updated_at`)
          .bind(id, year, month, sourceType, sourceAccountId, source.settlement_account_code, statementBalance, bookBalance, difference, total, unmatched, completed ? 'completed' : 'open', completed ? me.name : null, completed ? now : null, clean(payload.memo, 500) || null, now, now),
        operationAudit(db, completed ? 'complete' : 'check', 'reconciliation', id, me, { year, month, sourceType, sourceAccountId, total, unmatched, statementBalance, bookBalance, difference }, now),
      ]);
      return json({ ok: true, completed, total, unmatched, statementBalance, bookBalance, difference, message: completed ? '월 대사를 완료했습니다.' : unmatched ? `미대사 ${unmatched}건이 남아 있어 확정하지 않았습니다.` : `장부와 통장잔액이 ${Math.abs(difference).toLocaleString('ko-KR')}원 차이납니다.` });
    }

    if (action === 'create-budget-change') {
      const year = validYear(payload.year), type = clean(payload.changeType, 40), targetId = clean(payload.targetBudgetId, 100), sourceId = clean(payload.sourceBudgetId, 100);
      const amount = Math.abs(parseMoney(payload.amount)), reason = clean(payload.reason, 1000);
      if (!year || !['supplementary', 'transfer', 'reduction', 'over_budget_exception'].includes(type) || !targetId || !amount || !reason) return json({ ok: false, message: '예산 변경 유형·대상·금액·사유를 입력해 주세요.' }, 400);
      if (type === 'transfer' && (!sourceId || sourceId === targetId)) return json({ ok: false, message: '전용·이체의 재원 예산과 대상 예산을 다르게 선택해 주세요.' }, 400);
      const target = await db.prepare(`SELECT id FROM accounting_budget_plans WHERE id=? AND fiscal_year=?`).bind(targetId, year).first();
      const source = type === 'transfer' ? await db.prepare(`SELECT id FROM accounting_budget_plans WHERE id=? AND fiscal_year=?`).bind(sourceId, year).first() : true;
      if (!target || !source) return json({ ok: false, message: '변경 대상 예산을 찾을 수 없습니다.' }, 404);
      const requestNo = await nextOperationNumber(db, 'budget-change', year), id = `BCR-${randomHex(24)}`, now = new Date().toISOString();
      await db.batch([
        db.prepare(`INSERT INTO accounting_budget_change_requests
          (id,request_no,fiscal_year,change_type,target_budget_id,source_budget_id,requested_amount,reason,valid_until,status,requested_by_user_id,requested_by_name,requested_at,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,'pending',?,?,?,?,?)`)
          .bind(id, requestNo, year, type, targetId, sourceId || null, amount, reason, clean(payload.validUntil, 10) || null, me.id, me.name, now, now, now),
        operationAudit(db, 'request', 'budget-change', id, me, { requestNo, year, type, targetId, sourceId, amount, reason }, now),
      ]);
      return json({ ok: true, id, requestNo, message: '예산 변경 승인을 요청했습니다.' });
    }

    if (action === 'decide-budget-change') {
      if (!manager) return json({ ok: false, message: '예산 변경 승인 권한이 없습니다.' }, 403);
      const id = clean(payload.id, 100), decision = clean(payload.decision, 20), memo = clean(payload.memo, 1000), now = new Date().toISOString();
      if (!['approve', 'reject'].includes(decision)) return json({ ok: false, message: '승인 또는 반려를 선택해 주세요.' }, 400);
      const requestRow = await db.prepare(`SELECT * FROM accounting_budget_change_requests WHERE id=? AND status='pending'`).bind(id).first<any>();
      if (!requestRow) return json({ ok: false, message: '처리할 예산 변경요청을 찾을 수 없습니다.' }, 404);
      if (String(requestRow.requested_by_user_id) === String(me.id) && me.role !== 'admin') return json({ ok: false, message: '요청자 본인은 예산 변경을 승인할 수 없습니다.' }, 403);
      if (decision === 'reject') {
        await db.batch([
          db.prepare(`UPDATE accounting_budget_change_requests SET status='rejected',reviewed_by_user_id=?,reviewed_by_name=?,reviewed_at=?,review_memo=?,updated_at=? WHERE id=?`).bind(me.id, me.name, now, memo || null, now, id),
          operationAudit(db, 'reject', 'budget-change', id, me, { memo }, now),
        ]);
        return json({ ok: true, message: '예산 변경요청을 반려했습니다.' });
      }
      const target = await db.prepare(`SELECT * FROM accounting_budget_plans WHERE id=?`).bind(requestRow.target_budget_id).first<any>();
      if (!target) return json({ ok: false, message: '대상 예산을 찾을 수 없습니다.' }, 404);
      const amount = Number(requestRow.requested_amount || 0), statements: D1PreparedStatement[] = [];
      if (requestRow.change_type === 'supplementary') target.supplementary_amount = Number(target.supplementary_amount || 0) + amount;
      if (requestRow.change_type === 'reduction') {
        target.supplementary_amount = Number(target.supplementary_amount || 0) - amount;
        const executed = await getBudgetExecutedAmount(db, target), committed = await getBudgetCommittedAmount(db, target);
        const revised = Number(target.original_amount || 0) + target.supplementary_amount + Number(target.transfer_in || 0) - Number(target.transfer_out || 0);
        if (target.supplementary_amount < 0 || revised < executed + committed) return json({ ok: false, message: '감액 후 예산이 집행액과 약정액보다 작아 승인할 수 없습니다.' }, 400);
      }
      if (requestRow.change_type === 'transfer') {
        const source = await db.prepare(`SELECT * FROM accounting_budget_plans WHERE id=?`).bind(requestRow.source_budget_id).first<any>();
        if (!source) return json({ ok: false, message: '전용·이체 재원 예산을 찾을 수 없습니다.' }, 404);
        const executed = await getBudgetExecutedAmount(db, source), committed = await getBudgetCommittedAmount(db, source);
        const available = Number(source.original_amount || 0) + Number(source.supplementary_amount || 0) + Number(source.transfer_in || 0) - Number(source.transfer_out || 0) - executed - committed;
        if (available < amount) return json({ ok: false, message: `재원 예산의 가용액(${available.toLocaleString('ko-KR')}원)이 부족합니다.` }, 400);
        source.transfer_out = Number(source.transfer_out || 0) + amount;
        target.transfer_in = Number(target.transfer_in || 0) + amount;
        statements.push(
          db.prepare(`UPDATE accounting_budget_plans SET transfer_out=?,updated_at=? WHERE id=?`).bind(source.transfer_out, now, source.id),
          budgetVersionStatement(db, source, await nextBudgetVersion(db, source.id), 'approved_transfer_out', id, me.name, now),
        );
      }
      if (requestRow.change_type !== 'over_budget_exception') {
        statements.push(
          db.prepare(`UPDATE accounting_budget_plans SET supplementary_amount=?,transfer_in=?,transfer_out=?,updated_at=? WHERE id=?`).bind(target.supplementary_amount, target.transfer_in, target.transfer_out, now, target.id),
          budgetVersionStatement(db, target, await nextBudgetVersion(db, target.id), `approved_${requestRow.change_type}`, id, me.name, now),
        );
      }
      statements.push(
        db.prepare(`UPDATE accounting_budget_change_requests SET status='approved',reviewed_by_user_id=?,reviewed_by_name=?,reviewed_at=?,review_memo=?,updated_at=? WHERE id=?`).bind(me.id, me.name, now, memo || null, now, id),
        operationAudit(db, 'approve', 'budget-change', id, me, { type: requestRow.change_type, amount, memo }, now),
      );
      await db.batch(statements);
      return json({ ok: true, message: requestRow.change_type === 'over_budget_exception' ? '초과집행 예외를 승인했습니다.' : '예산 변경을 승인하고 새 버전을 확정했습니다.' });
    }

    if (action === 'save-vendor') {
      if (!manager) return json({ ok: false, message: '거래처 관리 권한이 없습니다.' }, 403);
      const id = clean(payload.id, 80) || `VND-${randomHex(20)}`, name = clean(payload.name, 160), businessNo = normalizeBusinessNo(payload.businessNo);
      if (!name) return json({ ok: false, message: '거래처명을 입력해 주세요.' }, 400);
      if (businessNo && businessNo.length !== 10) return json({ ok: false, message: '사업자등록번호·고유번호는 숫자 10자리로 입력해 주세요.' }, 400);
      const duplicate = businessNo ? await db.prepare(`SELECT id FROM accounting_vendors WHERE business_no=? AND id<>?`).bind(businessNo, id).first() : null;
      if (duplicate) return json({ ok: false, message: '같은 사업자등록번호·고유번호의 거래처가 이미 등록되어 있습니다.' }, 409);
      const existing = await db.prepare(`SELECT * FROM accounting_vendors WHERE id=?`).bind(id).first<any>();
      const accountRaw = clean(payload.bankAccountNumber, 80).replace(/[^0-9]/g, '');
      const fingerprint = accountRaw ? await sha256Hex(accountRaw) : existing?.bank_account_fingerprint || null;
      if (existing && accountRaw && existing.bank_account_fingerprint && fingerprint !== existing.bank_account_fingerprint) return json({ ok: false, message: '등록된 계좌의 변경은 별도 계좌변경 승인을 이용해 주세요.', bankChangeRequired: true }, 409);
      const vendorCode = existing?.vendor_code || await nextOperationNumber(db, 'vendor'), now = new Date().toISOString();
      await db.batch([
        db.prepare(`INSERT INTO accounting_vendors
          (id,vendor_code,name,business_no,representative,contact_name,phone,email,address,bank_name,bank_account_masked,bank_account_fingerprint,bank_account_holder,conflict_checked_at,conflict_note,active,created_by,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,business_no=excluded.business_no,
          representative=excluded.representative,contact_name=excluded.contact_name,phone=excluded.phone,email=excluded.email,address=excluded.address,
          bank_name=CASE WHEN accounting_vendors.bank_account_fingerprint IS NULL THEN excluded.bank_name ELSE accounting_vendors.bank_name END,
          bank_account_masked=CASE WHEN accounting_vendors.bank_account_fingerprint IS NULL THEN excluded.bank_account_masked ELSE accounting_vendors.bank_account_masked END,
          bank_account_fingerprint=COALESCE(accounting_vendors.bank_account_fingerprint,excluded.bank_account_fingerprint),
          bank_account_holder=CASE WHEN accounting_vendors.bank_account_fingerprint IS NULL THEN excluded.bank_account_holder ELSE accounting_vendors.bank_account_holder END,
          conflict_checked_at=excluded.conflict_checked_at,conflict_note=excluded.conflict_note,active=1,updated_at=excluded.updated_at`)
          .bind(id, vendorCode, name, businessNo || null, clean(payload.representative, 100) || null, clean(payload.contactName, 100) || null, clean(payload.phone, 60) || null, clean(payload.email, 160) || null, clean(payload.address, 300) || null, clean(payload.bankName, 80) || existing?.bank_name || null, accountRaw ? maskBankAccount(accountRaw) : existing?.bank_account_masked || null, fingerprint, clean(payload.bankAccountHolder, 100) || existing?.bank_account_holder || null, payload.conflictChecked === true ? now : existing?.conflict_checked_at || null, clean(payload.conflictNote, 500) || null, me.name, now, now),
        operationAudit(db, 'save', 'vendor', id, me, { vendorCode, name, businessNo, bankChanged: !!accountRaw, conflictChecked: payload.conflictChecked === true }, now),
      ]);
      return json({ ok: true, id, vendorCode, message: '거래처를 저장했습니다.' });
    }

    if (action === 'request-vendor-bank-change') {
      const vendorId = clean(payload.vendorId, 80), bankName = clean(payload.bankName, 80), accountRaw = clean(payload.bankAccountNumber, 80).replace(/[^0-9]/g, ''), holder = clean(payload.bankAccountHolder, 100), reason = clean(payload.reason, 500);
      const vendor = await db.prepare(`SELECT * FROM accounting_vendors WHERE id=? AND active=1`).bind(vendorId).first<any>();
      if (!vendor) return json({ ok: false, message: '거래처를 찾을 수 없습니다.' }, 404);
      if (!bankName || accountRaw.length < 7 || !holder || !reason) return json({ ok: false, message: '변경 계좌·예금주·사유를 정확히 입력해 주세요.' }, 400);
      const fingerprint = await sha256Hex(accountRaw);
      if (fingerprint === vendor.bank_account_fingerprint) return json({ ok: false, message: '현재 등록 계좌와 동일합니다.' }, 400);
      const pending = await db.prepare(`SELECT id FROM accounting_vendor_bank_changes WHERE vendor_id=? AND status='pending'`).bind(vendorId).first();
      if (pending) return json({ ok: false, message: '이미 승인 대기 중인 계좌변경 요청이 있습니다.' }, 409);
      const id = `VBC-${randomHex(24)}`, now = new Date().toISOString();
      await db.batch([
        db.prepare(`INSERT INTO accounting_vendor_bank_changes
          (id,vendor_id,old_bank_name,old_account_masked,new_bank_name,new_account_masked,new_account_fingerprint,new_account_holder,reason,status,requested_by_user_id,requested_by_name,requested_at,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,'pending',?,?,?,?,?)`)
          .bind(id, vendorId, vendor.bank_name || null, vendor.bank_account_masked || null, bankName, maskBankAccount(accountRaw), fingerprint, holder, reason, me.id, me.name, now, now, now),
        operationAudit(db, 'request', 'vendor-bank-change', id, me, { vendorId, bankName, masked: maskBankAccount(accountRaw), reason }, now),
      ]);
      return json({ ok: true, id, message: '거래처 계좌변경 승인을 요청했습니다.' });
    }

    if (action === 'decide-vendor-bank-change') {
      if (!manager) return json({ ok: false, message: '거래처 계좌변경 승인 권한이 없습니다.' }, 403);
      const id = clean(payload.id, 80), decision = clean(payload.decision, 20), memo = clean(payload.memo, 500), now = new Date().toISOString();
      const row = await db.prepare(`SELECT * FROM accounting_vendor_bank_changes WHERE id=? AND status='pending'`).bind(id).first<any>();
      if (!row || !['approve', 'reject'].includes(decision)) return json({ ok: false, message: '처리할 계좌변경 요청을 찾을 수 없습니다.' }, 404);
      if (String(row.requested_by_user_id) === String(me.id) && me.role !== 'admin') return json({ ok: false, message: '요청자 본인은 계좌변경을 승인할 수 없습니다.' }, 403);
      const statements = [
        db.prepare(`UPDATE accounting_vendor_bank_changes SET status=?,reviewed_by_user_id=?,reviewed_by_name=?,reviewed_at=?,review_memo=?,updated_at=? WHERE id=?`).bind(decision === 'approve' ? 'approved' : 'rejected', me.id, me.name, now, memo || null, now, id),
        operationAudit(db, decision, 'vendor-bank-change', id, me, { vendorId: row.vendor_id, memo }, now),
      ];
      if (decision === 'approve') statements.unshift(db.prepare(`UPDATE accounting_vendors SET bank_name=?,bank_account_masked=?,bank_account_fingerprint=?,bank_account_holder=?,updated_at=? WHERE id=?`).bind(row.new_bank_name, row.new_account_masked, row.new_account_fingerprint, row.new_account_holder, now, row.vendor_id));
      await db.batch(statements);
      return json({ ok: true, message: decision === 'approve' ? '거래처 계좌변경을 승인했습니다.' : '거래처 계좌변경을 반려했습니다.' });
    }

    if (action === 'save-contract') {
      if (!manager) return json({ ok: false, message: '계약 관리 권한이 없습니다.' }, 403);
      const id = clean(payload.id, 80) || `CTR-${randomHex(24)}`, vendorId = clean(payload.vendorId, 80), title = clean(payload.title, 200), amount = Math.abs(parseMoney(payload.amount));
      const contractDate = clean(payload.contractDate, 10), startDate = clean(payload.startDate, 10), endDate = clean(payload.endDate, 10), procurement = clean(payload.procurementMethod, 30) || 'competitive';
      if (!vendorId || !title || !amount || ![contractDate, startDate, endDate].every(validAccountingDate) || startDate > endDate) return json({ ok: false, message: '거래처·계약명·금액·계약기간을 정확히 입력해 주세요.' }, 400);
      if (!['competitive', 'limited', 'sole_source'].includes(procurement)) return json({ ok: false, message: '계약방법을 확인해 주세요.' }, 400);
      const soleReason = clean(payload.soleSourceReason, 1000);
      if (procurement === 'sole_source' && !soleReason) return json({ ok: false, message: '수의계약 사유를 입력해 주세요.' }, 400);
      if (payload.conflictChecked !== true) return json({ ok: false, message: '이해충돌·특수관계인 확인을 완료해 주세요.' }, 400);
      const vendor = await db.prepare(`SELECT id FROM accounting_vendors WHERE id=? AND active=1`).bind(vendorId).first();
      const accountCode = clean(payload.accountCode, 20), account = await db.prepare(`SELECT code FROM accounting_accounts WHERE code=? AND account_type='expense' AND active=1`).bind(accountCode).first();
      if (!vendor || !account) return json({ ok: false, message: '거래처 또는 지출 계정과목을 확인해 주세요.' }, 400);
      const dimensions = await validateDimensions(db, payload), existing = await db.prepare(`SELECT contract_no FROM accounting_contracts WHERE id=?`).bind(id).first<any>();
      const contractNo = existing?.contract_no || await nextOperationNumber(db, 'contract', Number(contractDate.slice(0, 4))), now = new Date().toISOString();
      await db.batch([
        db.prepare(`INSERT INTO accounting_contracts
          (id,contract_no,vendor_id,title,contract_type,procurement_method,contract_amount,contract_date,start_date,end_date,renewal_notice_days,department,project,account_code,book_type_code,entity_id,fund_id,sole_source_reason,multi_quote_checked,conflict_checked,conflict_note,inspection_required,status,memo,created_by,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET vendor_id=excluded.vendor_id,title=excluded.title,
          contract_type=excluded.contract_type,procurement_method=excluded.procurement_method,contract_amount=excluded.contract_amount,contract_date=excluded.contract_date,
          start_date=excluded.start_date,end_date=excluded.end_date,renewal_notice_days=excluded.renewal_notice_days,department=excluded.department,
          project=excluded.project,account_code=excluded.account_code,book_type_code=excluded.book_type_code,entity_id=excluded.entity_id,fund_id=excluded.fund_id,
          sole_source_reason=excluded.sole_source_reason,multi_quote_checked=excluded.multi_quote_checked,conflict_checked=excluded.conflict_checked,
          conflict_note=excluded.conflict_note,inspection_required=excluded.inspection_required,status=excluded.status,memo=excluded.memo,updated_at=excluded.updated_at`)
          .bind(id, contractNo, vendorId, title, clean(payload.contractType, 30) || 'service', procurement, amount, contractDate, startDate, endDate, Math.max(1, Math.min(365, Number(payload.renewalNoticeDays || 30))), clean(payload.department, 80), clean(payload.project, 100), accountCode, dimensions.bookTypeCode, dimensions.entityId, dimensions.fundId, soleReason || null, payload.multiQuoteChecked === true ? 1 : 0, 1, clean(payload.conflictNote, 500) || null, payload.inspectionRequired === false ? 0 : 1, clean(payload.status, 30) || 'active', clean(payload.memo, 1000) || null, me.name, now, now),
        operationAudit(db, 'save', 'contract', id, me, { contractNo, vendorId, title, amount, procurement, ...dimensions }, now),
      ]);
      return json({ ok: true, id, contractNo, message: '계약을 저장하고 예산 약정액에 반영했습니다.' });
    }

    if (action === 'save-contract-payment') {
      if (!manager) return json({ ok: false, message: '계약 지급일정 관리 권한이 없습니다.' }, 403);
      const contractId = clean(payload.contractId, 80), id = clean(payload.id, 80) || `CTP-${randomHex(24)}`, amount = Math.abs(parseMoney(payload.amount));
      const contract = await db.prepare(`SELECT * FROM accounting_contracts WHERE id=?`).bind(contractId).first<any>();
      if (!contract || !amount) return json({ ok: false, message: '계약과 지급금액을 확인해 주세요.' }, 400);
      const existingTotal = await db.prepare(`SELECT COALESCE(SUM(amount),0) AS amount FROM accounting_contract_payments WHERE contract_id=? AND id<>?`).bind(contractId, id).first<{ amount: number }>();
      if (Number(existingTotal?.amount || 0) + amount > Number(contract.contract_amount || 0)) return json({ ok: false, message: '지급일정 합계가 계약금액을 초과합니다.' }, 400);
      const current = await db.prepare(`SELECT payment_seq FROM accounting_contract_payments WHERE id=?`).bind(id).first<any>();
      const seqRow = current || await db.prepare(`SELECT COALESCE(MAX(payment_seq),0)+1 AS payment_seq FROM accounting_contract_payments WHERE contract_id=?`).bind(contractId).first<any>();
      const now = new Date().toISOString();
      await db.batch([
        db.prepare(`INSERT INTO accounting_contract_payments
          (id,contract_id,payment_seq,payment_name,due_date,amount,inspection_date,invoice_date,status,memo,created_by,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,'scheduled',?,?,?,?) ON CONFLICT(id) DO UPDATE SET payment_name=excluded.payment_name,due_date=excluded.due_date,
          amount=excluded.amount,inspection_date=excluded.inspection_date,invoice_date=excluded.invoice_date,memo=excluded.memo,updated_at=excluded.updated_at`)
          .bind(id, contractId, Number(seqRow?.payment_seq || 1), clean(payload.paymentName, 120) || `${Number(seqRow?.payment_seq || 1)}회차`, clean(payload.dueDate, 10) || null, amount, clean(payload.inspectionDate, 10) || null, clean(payload.invoiceDate, 10) || null, clean(payload.memo, 500) || null, me.name, now, now),
        operationAudit(db, 'save', 'contract-payment', id, me, { contractId, amount, dueDate: payload.dueDate }, now),
      ]);
      return json({ ok: true, id, message: '계약 지급일정을 저장했습니다.' });
    }

    if (action === 'link-contract-payment') {
      if (!manager) return json({ ok: false, message: '계약 지급 연결 권한이 없습니다.' }, 403);
      const paymentId = clean(payload.paymentId, 80), resolutionId = clean(payload.resolutionId, 100), now = new Date().toISOString();
      const [payment, resolution] = await Promise.all([
        db.prepare(`SELECT p.*,c.vendor_id,c.contract_amount FROM accounting_contract_payments p JOIN accounting_contracts c ON c.id=p.contract_id WHERE p.id=?`).bind(paymentId).first<any>(),
        db.prepare(`SELECT * FROM accounting_resolutions WHERE id=? AND resolution_type='expense'`).bind(resolutionId).first<any>(),
      ]);
      if (!payment || !resolution) return json({ ok: false, message: '지급일정 또는 지출결의서를 찾을 수 없습니다.' }, 404);
      if (Number(payment.amount) !== Number(resolution.amount)) return json({ ok: false, message: '지급일정과 지출결의서의 금액이 일치하지 않습니다.' }, 400);
      const paid = !!resolution.journal_id;
      await db.batch([
        db.prepare(`UPDATE accounting_contract_payments SET resolution_id=?,journal_id=?,status=?,paid_at=?,updated_at=? WHERE id=?`).bind(resolution.id, resolution.journal_id || null, paid ? 'paid' : 'linked', paid ? now : null, now, paymentId),
        db.prepare(`UPDATE accounting_resolutions SET vendor_id=?,contract_id=?,updated_at=? WHERE id=?`).bind(payment.vendor_id, payment.contract_id, now, resolution.id),
        operationAudit(db, 'link', 'contract-payment', paymentId, me, { resolutionId, journalId: resolution.journal_id || null, paid }, now),
      ]);
      const totals = await db.prepare(`SELECT c.contract_amount,COALESCE(SUM(CASE WHEN p.status='paid' THEN p.amount ELSE 0 END),0) AS paid
        FROM accounting_contracts c LEFT JOIN accounting_contract_payments p ON p.contract_id=c.id WHERE c.id=? GROUP BY c.id`).bind(payment.contract_id).first<any>();
      if (Number(totals?.paid || 0) >= Number(totals?.contract_amount || 0)) await db.prepare(`UPDATE accounting_contracts SET status='completed',updated_at=? WHERE id=?`).bind(now, payment.contract_id).run();
      return json({ ok: true, message: paid ? '지급일정·지출결의·전표를 연결했습니다.' : '지급일정과 결재 중인 지출결의를 연결했습니다.' });
    }

    if (action === 'create-donation-export') {
      if (!manager) return json({ ok: false, message: '전자기부금영수증 일괄처리 권한이 없습니다.' }, 403);
      const ids = listIds(payload.donationIds), year = validYear(payload.year);
      if (!year || !ids.length) return json({ ok: false, message: '일괄처리할 기부내역을 선택해 주세요.' }, 400);
      const rows = await db.prepare(`SELECT d.id,d.donation_no FROM accounting_donations d WHERE d.fiscal_year=? AND d.donor_id IS NOT NULL
        AND d.receipt_status NOT IN ('issued') AND d.id IN (${ids.map(() => '?').join(',')}) ORDER BY d.donation_date,d.id`).bind(year, ...ids).all<any>();
      if (!(rows.results || []).length) return json({ ok: false, message: '일괄발급 대상 기부내역이 없습니다.' }, 400);
      const exportNo = await nextOperationNumber(db, 'donation-export', year), id = `DEX-${randomHex(24)}`, now = new Date().toISOString();
      const statements: D1PreparedStatement[] = [db.prepare(`INSERT INTO accounting_donation_export_batches
        (id,export_no,fiscal_year,export_type,status,item_count,created_by,created_at,updated_at) VALUES (?,?,?,'hometax_workbook','created',?,?,?,?)`)
        .bind(id, exportNo, year, (rows.results || []).length, me.name, now, now)];
      for (const row of rows.results || []) statements.push(db.prepare(`INSERT INTO accounting_donation_export_items
        (id,batch_id,donation_id,donation_no,export_status,created_at,updated_at) VALUES (?,?,?,?,'exported',?,?)`)
        .bind(`DEXI-${randomHex(20)}`, id, row.id, row.donation_no, now, now));
      statements.push(operationAudit(db, 'create', 'donation-export', id, me, { exportNo, year, itemCount: (rows.results || []).length }, now));
      await db.batch(statements);
      return json({ ok: true, id, exportNo, itemCount: (rows.results || []).length, message: '홈택스 작업파일 생성 이력을 등록했습니다.' });
    }

    if (action === 'apply-donation-results') {
      if (!manager) return json({ ok: false, message: '전자기부금영수증 결과 반영 권한이 없습니다.' }, 403);
      const batchId = clean(payload.batchId, 80), filename = clean(payload.filename, 200), resultRows = Array.isArray(payload.rows) ? (payload.rows as Array<Record<string, unknown>>).slice(0, 500) : [];
      const batch = await db.prepare(`SELECT * FROM accounting_donation_export_batches WHERE id=?`).bind(batchId).first<any>();
      if (!batch || !resultRows.length) return json({ ok: false, message: '결과를 반영할 일괄처리 건과 파일을 확인해 주세요.' }, 400);
      const now = new Date().toISOString(), statements: D1PreparedStatement[] = [];
      let success = 0, errors = 0, cancelled = 0, skipped = 0;
      for (const item of resultRows) {
        const donationNo = clean(item.donationNo, 80), rawStatus = normalizeMatchText(item.status), externalNo = clean(item.externalReceiptNo, 100), message = clean(item.message, 500);
        const exportItem = await db.prepare(`SELECT i.*,d.fiscal_year,d.receipt_no FROM accounting_donation_export_items i JOIN accounting_donations d ON d.id=i.donation_id WHERE i.batch_id=? AND i.donation_no=?`).bind(batchId, donationNo).first<any>();
        if (!exportItem) { skipped += 1; continue; }
        const isCancel = /취소|cancel/.test(rawStatus), isSuccess = /정상|성공|발급|완료|success|issued/.test(rawStatus) && !/오류|실패|error/.test(rawStatus);
        if (isCancel) {
          statements.push(
            db.prepare(`UPDATE accounting_donations SET receipt_status='cancelled',receipt_cancelled_at=?,updated_at=? WHERE id=?`).bind(now, now, exportItem.donation_id),
            db.prepare(`UPDATE accounting_donation_export_items SET export_status='cancelled',external_receipt_no=?,result_code=?,result_message=?,processed_at=?,updated_at=? WHERE id=?`).bind(externalNo || null, clean(item.status, 80), message || null, now, now, exportItem.id),
          );
          cancelled += 1;
        } else if (isSuccess) {
          const receiptNo = externalNo || exportItem.receipt_no || await nextSpecialNumber(db, 'receipt', Number(exportItem.fiscal_year));
          statements.push(
            db.prepare(`UPDATE accounting_donations SET receipt_requested=1,receipt_status='issued',receipt_no=?,receipt_issued_at=?,receipt_cancelled_at=NULL,updated_at=? WHERE id=?`).bind(receiptNo, now, now, exportItem.donation_id),
            db.prepare(`UPDATE accounting_donation_export_items SET export_status='issued',external_receipt_no=?,result_code=?,result_message=?,processed_at=?,updated_at=? WHERE id=?`).bind(externalNo || receiptNo, clean(item.status, 80), message || null, now, now, exportItem.id),
          );
          success += 1;
        } else {
          statements.push(
            db.prepare(`UPDATE accounting_donations SET receipt_requested=1,receipt_status='error',updated_at=? WHERE id=?`).bind(now, exportItem.donation_id),
            db.prepare(`UPDATE accounting_donation_export_items SET export_status='error',external_receipt_no=?,result_code=?,result_message=?,processed_at=?,updated_at=? WHERE id=?`).bind(externalNo || null, clean(item.status, 80) || 'error', message || '처리 오류', now, now, exportItem.id),
          );
          errors += 1;
        }
      }
      statements.push(
        db.prepare(`UPDATE accounting_donation_export_batches SET status=?,success_count=?,error_count=?,original_result_filename=?,processed_by=?,processed_at=?,updated_at=? WHERE id=?`).bind(errors ? 'processed_with_errors' : 'processed', success + cancelled, errors, filename || null, me.name, now, now, batchId),
        operationAudit(db, 'apply-results', 'donation-export', batchId, me, { success, errors, cancelled, skipped, filename }, now),
      );
      await runStatements(db, statements);
      return json({ ok: true, success, errors, cancelled, skipped, message: `발급 ${success}건, 취소 ${cancelled}건, 오류 ${errors}건을 반영했습니다.${skipped ? ` 미확인 ${skipped}건은 제외했습니다.` : ''}` });
    }

    return json({ ok: false, message: '지원하지 않는 실무 회계처리입니다.' }, 400);
  } catch (error) {
    console.error('accounting operations action failed', action, error);
    return json({ ok: false, message: error instanceof Error ? error.message : '실무 회계처리 중 오류가 발생했습니다.' }, 500);
  }
};

export const onRequestGet: PagesFunction = async () => json({ ok: false, message: 'POST 방식으로 요청해 주세요.' }, 405);
