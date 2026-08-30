import { authenticateSession, clean, ensureTables, json, randomHex, normalizeDepartmentValue } from '../../_shared/helpers';
import { ensureAccountingTables, hasAccountingAccess, isAccountingManager, parseMoney } from '../../_shared/accounting';
import { validateDimensions } from '../../_shared/accounting-dimensions';
import { nextSpecialNumber, reserveSpecialNumberBlock } from '../../_shared/accounting-numbering';
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
  for (const group of chunks(statements, 40)) await db.batch(group);
};
const JSON_SQL_PAYLOAD_MAX_BYTES = 1_200_000;
const jsonPayloadChunks = <T>(items: T[], maxItems = 120) => {
  const encoder = new TextEncoder(), result: string[] = []; let current: T[] = [];
  for (const item of items) {
    const candidate=[...current,item], serialized=JSON.stringify(candidate);
    if(current.length && (candidate.length>maxItems || encoder.encode(serialized).byteLength>JSON_SQL_PAYLOAD_MAX_BYTES)){result.push(JSON.stringify(current));current=[item]}else current=candidate;
  }
  if(current.length)result.push(JSON.stringify(current)); return result;
};

const matchTargetForTransaction = async (db: D1Database, tx: any, type: string, targetId: string) => {
  const context = await db.prepare(`SELECT b.source_account_id,
      COALESCE(NULLIF(ba.book_type_code,''),NULLIF(c.book_type_code,''),'general') AS book_type_code,
      COALESCE(NULLIF(ba.entity_id,''),NULLIF(c.entity_id,''),'ENTITY-HQ') AS entity_id,
      COALESCE(ba.fund_id,'') AS fund_id,
      COALESCE(ba.settlement_account_code,c.settlement_account_code,'') AS settlement_account_code
    FROM accounting_import_batches b
    LEFT JOIN accounting_bank_accounts ba ON b.source_type='bank' AND ba.id=b.source_account_id
    LEFT JOIN accounting_cards c ON b.source_type='card' AND c.id=b.source_account_id
    WHERE b.id=?`).bind(tx.batch_id).first<any>();
  if (!context) return null;
  let target: any = null;
  if (type === 'donation') target = await db.prepare(`SELECT d.id,d.donation_date AS target_date,d.amount,'in' AS direction,
      d.book_type_code,d.entity_id,d.fund_id,d.status,NULL AS card_id
    FROM accounting_donations d WHERE d.id=? AND d.status IN ('registered','posted')`).bind(targetId).first<any>();
  if (type === 'resolution') target = await db.prepare(`SELECT r.id,r.resolution_date AS target_date,r.amount,
      CASE WHEN r.resolution_type='income' THEN 'in' ELSE 'out' END AS direction,
      COALESCE(NULLIF(d.book_type_code,''),'general') AS book_type_code,
      COALESCE(NULLIF(d.entity_id,''),'ENTITY-HQ') AS entity_id,COALESCE(d.fund_id,'') AS fund_id,
      r.status,NULL AS card_id FROM accounting_resolutions r
    LEFT JOIN accounting_resolution_dimensions d ON d.resolution_id=r.id
    WHERE r.id=? AND r.status IN ('approved','posted')`).bind(targetId).first<any>();
  if (type === 'card_transaction') target = await db.prepare(`SELECT id,transaction_date AS target_date,amount,'out' AS direction,
      book_type_code,entity_id,fund_id,status,card_id FROM accounting_card_transactions
    WHERE id=? AND status IN ('unmatched','posted')`).bind(targetId).first<any>();
  if (type === 'journal') target = await db.prepare(`SELECT j.id,j.journal_date AS target_date,
      COALESCE(SUM(CASE WHEN l.account_code=? THEN CASE WHEN ?='in' THEN l.debit ELSE l.credit END ELSE 0 END),0) AS amount,
      ? AS direction,COALESCE(MAX(NULLIF(d.book_type_code,'')),'general') AS book_type_code,
      COALESCE(MAX(NULLIF(d.entity_id,'')),'ENTITY-HQ') AS entity_id,COALESCE(MAX(d.fund_id),'') AS fund_id,
      j.status,NULL AS card_id FROM accounting_journals j JOIN accounting_journal_lines l ON l.journal_id=j.id
      LEFT JOIN accounting_journal_line_dimensions d ON d.journal_line_id=l.id
      WHERE j.id=? AND j.status='posted' AND j.source_type<>'reversal' GROUP BY j.id
      HAVING COUNT(DISTINCT COALESCE(NULLIF(d.book_type_code,''),'general'))=1
        AND COUNT(DISTINCT COALESCE(NULLIF(d.entity_id,''),'ENTITY-HQ'))=1
        AND COUNT(DISTINCT COALESCE(d.fund_id,''))=1`)
    .bind(context.settlement_account_code, tx.direction, tx.direction, targetId).first<any>();
  if (!target || Number(target.amount || 0) !== Number(tx.amount || 0) || target.direction !== tx.direction) return null;
  if (String(target.book_type_code || 'general') !== String(context.book_type_code || 'general')
    || String(target.entity_id || 'ENTITY-HQ') !== String(context.entity_id || 'ENTITY-HQ')
    || String(target.fund_id || '') !== String(context.fund_id || '')) return null;
  if (type === 'card_transaction' && (tx.source_type !== 'card' || String(target.card_id) !== String(context.source_account_id))) return null;
  return target;
};

type ImportCandidateRow = {
  sourceIndex: number;
  row: Record<string, unknown>;
  date: string;
  postedDate: string;
  direction: string;
  amount: number;
  description: string;
  counterparty: string;
  approvalNo: string;
  externalKey: string;
};

type AutoMatchCandidate = {
  type: 'donation' | 'resolution' | 'card_transaction'; id: string; date: string; name: string; amount: number;
  approval_no?: string | null; created_at?: string | null;
};
type AutoMatchCandidateRow = AutoMatchCandidate & { tx_id: string };

// Set-based candidate loading keeps the 250-row path well below D1's per-invocation query budget.
const loadAutoMatchCandidateMap = async (db: D1Database, transactions: any[]) => {
  const map = new Map<string, AutoMatchCandidate[]>(); if (!transactions.length) return map;
  const ids = JSON.stringify(transactions.map((row:any)=>String(row.id)));
  const cte = `WITH selected AS (
    SELECT t.id AS tx_id,t.source_type,t.transaction_date,t.direction,t.amount,b.source_account_id,
      COALESCE(NULLIF(ba.book_type_code,''),NULLIF(c.book_type_code,''),'general') AS book_type_code,
      COALESCE(NULLIF(ba.entity_id,''),NULLIF(c.entity_id,''),'ENTITY-HQ') AS entity_id,COALESCE(ba.fund_id,'') AS fund_id
    FROM accounting_import_transactions t JOIN accounting_import_batches b ON b.id=t.batch_id
    LEFT JOIN accounting_bank_accounts ba ON b.source_type='bank' AND ba.id=b.source_account_id
    LEFT JOIN accounting_cards c ON b.source_type='card' AND c.id=b.source_account_id
    WHERE t.id IN (SELECT CAST(value AS TEXT) FROM json_each(?)) )`;
  const statements=[
    db.prepare(`${cte}, ranked AS (SELECT s.tx_id,'donation' AS type,d.id,d.donation_date AS date,COALESCE(o.name,'익명') AS name,d.amount,NULL AS approval_no,d.created_at,ROW_NUMBER() OVER(PARTITION BY s.tx_id ORDER BY ABS(julianday(d.donation_date)-julianday(s.transaction_date)),d.created_at,d.id) rn FROM selected s JOIN accounting_donations d ON s.source_type='bank' AND s.direction='in' AND d.status IN ('registered','posted') AND d.amount=s.amount AND d.donation_date BETWEEN date(s.transaction_date,'-5 day') AND date(s.transaction_date,'+5 day') AND COALESCE(NULLIF(d.book_type_code,''),'general')=s.book_type_code AND COALESCE(NULLIF(d.entity_id,''),'ENTITY-HQ')=s.entity_id AND COALESCE(d.fund_id,'')=s.fund_id LEFT JOIN accounting_donors o ON o.id=d.donor_id) SELECT tx_id,type,id,date,name,amount,approval_no,created_at FROM ranked WHERE rn<=12`).bind(ids),
    db.prepare(`${cte}, ranked AS (SELECT s.tx_id,'card_transaction' AS type,c.id,c.transaction_date AS date,c.merchant AS name,c.amount,c.transaction_no AS approval_no,c.created_at,ROW_NUMBER() OVER(PARTITION BY s.tx_id ORDER BY ABS(julianday(c.transaction_date)-julianday(s.transaction_date)),c.created_at,c.id) rn FROM selected s JOIN accounting_card_transactions c ON s.source_type='card' AND s.direction='out' AND c.card_id=s.source_account_id AND c.status IN ('unmatched','posted') AND c.amount=s.amount AND c.transaction_date BETWEEN date(s.transaction_date,'-3 day') AND date(s.transaction_date,'+3 day') AND COALESCE(NULLIF(c.book_type_code,''),'general')=s.book_type_code AND COALESCE(NULLIF(c.entity_id,''),'ENTITY-HQ')=s.entity_id AND COALESCE(c.fund_id,'')=s.fund_id) SELECT tx_id,type,id,date,name,amount,approval_no,created_at FROM ranked WHERE rn<=10`).bind(ids),
    db.prepare(`${cte}, ranked AS (SELECT s.tx_id,'resolution' AS type,r.id,r.resolution_date AS date,r.counterparty AS name,r.amount,NULL AS approval_no,r.created_at,ROW_NUMBER() OVER(PARTITION BY s.tx_id ORDER BY ABS(julianday(r.resolution_date)-julianday(s.transaction_date)),r.created_at,r.id) rn FROM selected s JOIN accounting_resolutions r ON s.direction='out' AND r.resolution_type='expense' AND r.status IN ('approved','posted') AND r.amount=s.amount AND r.resolution_date BETWEEN date(s.transaction_date,'-7 day') AND date(s.transaction_date,'+7 day') LEFT JOIN accounting_resolution_dimensions d ON d.resolution_id=r.id WHERE COALESCE(NULLIF(d.book_type_code,''),'general')=s.book_type_code AND COALESCE(NULLIF(d.entity_id,''),'ENTITY-HQ')=s.entity_id AND COALESCE(d.fund_id,'')=s.fund_id) SELECT tx_id,type,id,date,name,amount,approval_no,created_at FROM ranked WHERE rn<=15`).bind(ids),
  ];
  const results=await db.batch(statements); for(const result of results)for(const row of (result.results||[]) as AutoMatchCandidateRow[]){const list=map.get(String(row.tx_id))||[];list.push({type:row.type,id:row.id,date:row.date,name:row.name,amount:row.amount,approval_no:row.approval_no,created_at:row.created_at});map.set(String(row.tx_id),list)} return map;
};
const loadMatchedTargetKeys = async (db:D1Database,candidates:AutoMatchCandidate[])=>{
  const used=new Set<string>(), byType=new Map<string,Set<string>>(); for(const c of candidates){const set=byType.get(c.type)||new Set<string>();set.add(c.id);byType.set(c.type,set)}
  const statements:D1PreparedStatement[]=[];for(const [type,ids] of byType)statements.push(db.prepare(`SELECT matched_type,matched_id FROM accounting_import_transactions WHERE status='matched' AND matched_type=? AND matched_id IN (SELECT CAST(value AS TEXT) FROM json_each(?))`).bind(type,JSON.stringify([...ids])));
  if(!statements.length)return used;for(const result of await db.batch(statements))for(const row of (result.results||[]) as any[])used.add(`${String(row.matched_type||'')}:${String(row.matched_id||'')}`);return used;
};
const bulkInsertImportTransactions=async(db:D1Database,rows:Array<Record<string,unknown>>)=>{
  if(!rows.length)return;const statements=jsonPayloadChunks(rows,100).map(payload=>db.prepare(`INSERT INTO accounting_import_transactions (id,batch_id,source_type,external_key,transaction_date,posted_date,direction,description,counterparty,amount,tax_amount,balance,approval_no,original_json,classification_account_code,status,created_at,updated_at)
    SELECT json_extract(value,'$.id'),json_extract(value,'$.batchId'),json_extract(value,'$.sourceType'),json_extract(value,'$.externalKey'),json_extract(value,'$.date'),NULLIF(json_extract(value,'$.postedDate'),''),json_extract(value,'$.direction'),COALESCE(json_extract(value,'$.description'),''),COALESCE(json_extract(value,'$.counterparty'),''),CAST(json_extract(value,'$.amount') AS INTEGER),CAST(COALESCE(json_extract(value,'$.taxAmount'),0) AS INTEGER),CASE WHEN json_type(value,'$.balance')='null' THEN NULL ELSE CAST(json_extract(value,'$.balance') AS INTEGER) END,NULLIF(json_extract(value,'$.approvalNo'),''),COALESCE(json_extract(value,'$.originalJson'),'{}'),NULLIF(json_extract(value,'$.classificationAccountCode'),''),'unmatched',json_extract(value,'$.now'),json_extract(value,'$.now') FROM json_each(?) WHERE 1=1 ON CONFLICT(external_key) DO NOTHING`).bind(payload));await db.batch(statements);
};
type AutoMatchUpdate={id:string;type:string;targetId:string;score:number;reason:string};
const applyAutoMatchUpdates=async(db:D1Database,matched:AutoMatchUpdate[],suggested:AutoMatchUpdate[],resetIds:string[],me:{id:string;name:string},now:string)=>{
  const statements:D1PreparedStatement[]=[];
  if(matched.length){const payload=JSON.stringify(matched);statements.push(db.prepare(`WITH u AS (SELECT json_extract(value,'$.id') id,json_extract(value,'$.type') type,json_extract(value,'$.targetId') target_id,CAST(json_extract(value,'$.score') AS INTEGER) score,json_extract(value,'$.reason') reason FROM json_each(?)) UPDATE accounting_import_transactions SET status='matched',suggested_type=(SELECT type FROM u WHERE u.id=accounting_import_transactions.id),suggested_id=(SELECT target_id FROM u WHERE u.id=accounting_import_transactions.id),suggested_score=(SELECT score FROM u WHERE u.id=accounting_import_transactions.id),suggested_reason=(SELECT reason FROM u WHERE u.id=accounting_import_transactions.id),matched_type=(SELECT type FROM u WHERE u.id=accounting_import_transactions.id),matched_id=(SELECT target_id FROM u WHERE u.id=accounting_import_transactions.id),matched_by='자동대사',matched_at=?,updated_at=? WHERE id IN (SELECT id FROM u) AND status IN ('unmatched','suggested')`).bind(payload,now,now));}
  if(suggested.length){const payload=JSON.stringify(suggested);statements.push(db.prepare(`WITH u AS (SELECT json_extract(value,'$.id') id,json_extract(value,'$.type') type,json_extract(value,'$.targetId') target_id,CAST(json_extract(value,'$.score') AS INTEGER) score,json_extract(value,'$.reason') reason FROM json_each(?)) UPDATE accounting_import_transactions SET status='suggested',suggested_type=(SELECT type FROM u WHERE u.id=accounting_import_transactions.id),suggested_id=(SELECT target_id FROM u WHERE u.id=accounting_import_transactions.id),suggested_score=(SELECT score FROM u WHERE u.id=accounting_import_transactions.id),suggested_reason=(SELECT reason FROM u WHERE u.id=accounting_import_transactions.id),updated_at=? WHERE id IN (SELECT id FROM u) AND status IN ('unmatched','suggested')`).bind(payload,now));}
  if(resetIds.length)statements.push(db.prepare(`UPDATE accounting_import_transactions SET status='unmatched',suggested_type=NULL,suggested_id=NULL,suggested_score=NULL,suggested_reason=NULL,updated_at=? WHERE id IN (SELECT CAST(value AS TEXT) FROM json_each(?)) AND status='suggested'`).bind(now,JSON.stringify(resetIds)));
  if(statements.length)await db.batch(statements);
};

const scoreAutoMatchCandidate = (tx: any, candidate: AutoMatchCandidate) => {
  const days = Math.abs((Date.parse(`${candidate.date}T00:00:00Z`) - Date.parse(`${tx.transaction_date}T00:00:00Z`)) / 86400000);
  const transactionText = normalizeMatchText(`${tx.counterparty || ''} ${tx.description || ''}`);
  const candidateText = normalizeMatchText(candidate.name);
  const nameMatch = !!candidateText && !!transactionText && (candidateText.includes(transactionText) || transactionText.includes(candidateText));
  const approvalMatch = !!tx.approval_no && !!candidate.approval_no && normalizeMatchText(tx.approval_no) === normalizeMatchText(candidate.approval_no);
  const score = Math.min(100, 60 + (days === 0 ? 20 : Math.max(0, 15 - days * 3)) + (nameMatch ? 20 : 0) + (approvalMatch ? 20 : 0));
  return {
    ...candidate,
    score,
    reason: `금액 일치 · 날짜 ${days === 0 ? '일치' : `${days}일 차이`}${nameMatch ? ' · 거래처 일치' : ''}${approvalMatch ? ' · 승인번호 일치' : ''}`,
  };
};

const chooseAutoMatchCandidate = (tx: any, candidates: AutoMatchCandidate[], unavailable: Set<string>) => {
  let best: ReturnType<typeof scoreAutoMatchCandidate> | null = null;
  for (const candidate of candidates) {
    if (unavailable.has(`${candidate.type}:${candidate.id}`)) continue;
    const scored = scoreAutoMatchCandidate(tx, candidate);
    if (!best || scored.score > best.score) best = scored;
  }
  return best;
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
      const periodStart = clean(payload.periodStart, 10), periodEnd = clean(payload.periodEnd, 10);
      if ((periodStart && !validAccountingDate(periodStart)) || (periodEnd && !validAccountingDate(periodEnd))
        || (periodStart && periodEnd && periodStart > periodEnd)) {
        return json({ ok: false, message: '가져오기 대상기간의 날짜와 선후관계를 확인해 주세요.' }, 400);
      }
      const rawRows=Array.isArray(payload.rows)?payload.rows as Array<Record<string,unknown>>:[];
      if(rawRows.length>1000)return json({ok:false,message:'거래내역은 한 번에 최대 1,000건까지 가져올 수 있습니다. 파일을 나누어 처리해 주세요.'},400);
      const rows=rawRows;
      if (!rows.length) return json({ ok: false, message: '가져올 거래내역이 없습니다.' }, 400);
      const year = validYear(String(rows[0]?.transactionDate || '').slice(0, 4)) || new Date(Date.now()+9*60*60*1000).getUTCFullYear();
      const batchNo = await nextOperationNumber(db, 'import', year), batchId = `IMB-${randomHex(24)}`, now = new Date().toISOString();
      const rules = await db.prepare(`SELECT * FROM accounting_matching_rules WHERE active=1 AND source_type IN ('all',?) ORDER BY priority,id`).bind(sourceType).all<any>();
      const normalized: Omit<ImportCandidateRow, 'externalKey'>[] = [];
      let duplicates = 0, invalid = 0;
      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index];
        const date = clean(row.transactionDate, 10), postedDate = clean(row.postedDate, 10), direction = clean(row.direction, 10), amount = Math.abs(parseMoney(row.amount));
        if (!validAccountingDate(date) || (postedDate && !validAccountingDate(postedDate))
          || !['in', 'out'].includes(direction) || amount <= 0
          || (periodStart && date < periodStart) || (periodEnd && date > periodEnd)) { invalid += 1; continue; }
        normalized.push({
          sourceIndex: index,
          row,
          date,
          postedDate,
          direction,
          amount,
          description: clean(row.description, 300),
          counterparty: clean(row.counterparty, 160),
          approvalNo: clean(row.approvalNo, 100),
        });
      }
      const prepared: ImportCandidateRow[] = [];
      for (const group of chunks(normalized, 50)) {
        const hashed = await Promise.all(group.map(async (item) => ({
          ...item,
          externalKey: await sha256Hex([
            sourceType, sourceAccountId, item.date, item.direction, item.amount, item.approvalNo,
            item.counterparty, item.description, clean(item.row.sequence, 30) || String(item.sourceIndex + 1), clean(item.row.balance, 40),
          ].join('|')),
        })));
        prepared.push(...hashed);
      }
      const seenInputKeys = new Set<string>();
      const insertRows: Array<Record<string, unknown>> = [];
      for (const item of prepared) {
        if (seenInputKeys.has(item.externalKey)) { duplicates += 1; continue; }
        seenInputKeys.add(item.externalKey);
        const text = normalizeMatchText(`${item.counterparty} ${item.description}`);
        const rule = (rules.results || []).find((candidate: any) => (candidate.direction === 'all' || candidate.direction === item.direction)
          && text.includes(normalizeMatchText(candidate.keyword)));
        insertRows.push({ id:`IMT-${randomHex(24)}`, batchId, sourceType, externalKey:item.externalKey, date:item.date, postedDate:item.postedDate,
          direction:item.direction, description:item.description, counterparty:item.counterparty, amount:item.amount,
          taxAmount:Math.abs(parseMoney(item.row.taxAmount)), balance:item.row.balance === '' || item.row.balance == null ? null : parseMoney(item.row.balance),
          approvalNo:item.approvalNo, originalJson:JSON.stringify(item.row), classificationAccountCode:rule?.account_code || '', now });
      }
      await db.prepare(`INSERT INTO accounting_import_batches
        (id,batch_no,source_type,source_account_id,period_start,period_end,statement_balance,original_filename,total_rows,imported_rows,duplicate_rows,status,created_by,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(batchId,batchNo,sourceType,sourceAccountId,periodStart||null,periodEnd||null,
          payload.statementBalance === '' || payload.statementBalance == null ? null : parseMoney(payload.statementBalance), clean(payload.filename,200)||null,
          rows.length,0,duplicates,'processing',me.name,now,now).run();
      try {
        await bulkInsertImportTransactions(db, insertRows);
        const insertedRow=await db.prepare(`SELECT COUNT(*) AS count FROM accounting_import_transactions WHERE batch_id=?`).bind(batchId).first<{count:number}>();
        const imported=Number(insertedRow?.count||0); duplicates += Math.max(0, insertRows.length-imported);
        await db.batch([
          db.prepare(`UPDATE accounting_import_batches SET imported_rows=?,duplicate_rows=?,status='imported',updated_at=? WHERE id=?`).bind(imported,duplicates,now,batchId),
          operationAudit(db,'import','import-batch',batchId,me,{batchNo,sourceType,sourceAccountId,total:rows.length,imported,duplicates,invalid},now),
        ]);
        return json({ok:true,id:batchId,batchNo,imported,duplicates,invalid,message:`${imported}건을 가져왔습니다. 중복 ${duplicates}건, 형식오류 ${invalid}건은 제외했습니다.`});
      } catch(error) {
        await db.batch([db.prepare(`DELETE FROM accounting_import_transactions WHERE batch_id=?`).bind(batchId),db.prepare(`DELETE FROM accounting_import_batches WHERE id=?`).bind(batchId)]).catch(()=>undefined);
        throw error;
      }
    }

    if (action === 'auto-match') {
      if (!manager) return json({ ok: false, message: '자동대사 실행 권한이 없습니다.' }, 403);
      const batchId=clean(payload.batchId,80);
      const rows=await db.prepare(`SELECT * FROM accounting_import_transactions WHERE status IN ('unmatched','suggested') ${batchId?'AND batch_id=?':''} ORDER BY transaction_date,id LIMIT 250`).bind(...(batchId?[batchId]:[])).all<any>();
      const transactions=rows.results||[], now=new Date().toISOString();
      if(transactions.length){
        const candidateMap=await loadAutoMatchCandidateMap(db,transactions), allCandidates=[...candidateMap.values()].flat(), unavailable=await loadMatchedTargetKeys(db,allCandidates);
        const matched:AutoMatchUpdate[]=[],suggested:AutoMatchUpdate[]=[],resetIds:string[]=[];
        for(const tx of transactions){const best=chooseAutoMatchCandidate(tx,candidateMap.get(String(tx.id))||[],unavailable);if(best&&best.score>=95){unavailable.add(`${best.type}:${best.id}`);matched.push({id:String(tx.id),type:best.type,targetId:best.id,score:best.score,reason:best.reason})}else if(best&&best.score>=70){suggested.push({id:String(tx.id),type:best.type,targetId:best.id,score:best.score,reason:best.reason})}else if(String(tx.status||'')==='suggested'||tx.suggested_type||tx.suggested_id||tx.suggested_score)resetIds.push(String(tx.id))}
        await applyAutoMatchUpdates(db,matched,suggested,resetIds,me,now);
      }
      const counts={matched:0,suggested:0,unmatched:0};
      if(transactions.length){const counted=await db.prepare(`SELECT status,COUNT(*) AS count FROM accounting_import_transactions WHERE id IN (SELECT CAST(value AS TEXT) FROM json_each(?)) GROUP BY status`).bind(JSON.stringify(transactions.map((r:any)=>String(r.id)))).all<any>();for(const row of counted.results||[]){const status=String(row.status||'');if(status==='matched')counts.matched+=Number(row.count||0);else if(status==='suggested')counts.suggested+=Number(row.count||0);else if(status==='unmatched')counts.unmatched+=Number(row.count||0)}}
      if(batchId){const pending=await db.prepare(`SELECT COUNT(*) AS count FROM accounting_import_transactions WHERE batch_id=? AND status IN ('unmatched','suggested')`).bind(batchId).first<{count:number}>();await db.prepare(`UPDATE accounting_import_batches SET status=?,updated_at=? WHERE id=?`).bind(Number(pending?.count||0)?'reconciling':'reconciled',now,batchId).run()}
      return json({ok:true,...counts,processed:transactions.length,message:`자동확정 ${counts.matched}건, 확인필요 ${counts.suggested}건, 미매칭 ${counts.unmatched}건입니다.`});
    }

    if (action === 'confirm-match' || action === 'unmatch' || action === 'ignore-transaction') {
      if (!manager) return json({ ok: false, message: '대사 처리 권한이 없습니다.' }, 403);
      const id = clean(payload.id, 80), now = new Date().toISOString();
      const tx = await db.prepare(`SELECT * FROM accounting_import_transactions WHERE id=?`).bind(id).first<any>();
      if (!tx) return json({ ok: false, message: '거래내역을 찾을 수 없습니다.' }, 404);
      if (action === 'confirm-match') {
        const type = clean(payload.matchType, 40) || tx.suggested_type, matchId = clean(payload.matchId, 100) || tx.suggested_id;
        if (!type || !matchId || !['donation', 'resolution', 'card_transaction', 'journal'].includes(type)) return json({ ok: false, message: '연결할 회계자료를 선택해 주세요.' }, 400);
        if (!['unmatched', 'suggested'].includes(String(tx.status || ''))) return json({ ok: false, message: '미대사 또는 추천 상태인 거래만 새로 연결할 수 있습니다.' }, 409);
        const target = await matchTargetForTransaction(db, tx, type, matchId);
        if (!target) return json({ ok: false, message: '대상 자료의 금액·입출금 방향·회계구분·회계조직·재원 또는 카드가 거래내역과 일치하지 않습니다.' }, 400);
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
      const validUntil = clean(payload.validUntil, 10);
      if (validUntil && (!validAccountingDate(validUntil) || Number(validUntil.slice(0, 4)) !== year)) return json({ ok: false, message: '예외승인 유효일은 해당 회계연도의 올바른 날짜여야 합니다.' }, 400);
      if (type === 'transfer' && (!sourceId || sourceId === targetId)) return json({ ok: false, message: '전용·이체의 재원 예산과 대상 예산을 다르게 선택해 주세요.' }, 400);
      const target = await db.prepare(`SELECT id FROM accounting_budget_plans WHERE id=? AND fiscal_year=?`).bind(targetId, year).first();
      const source = type === 'transfer' ? await db.prepare(`SELECT id FROM accounting_budget_plans WHERE id=? AND fiscal_year=?`).bind(sourceId, year).first() : true;
      if (!target || !source) return json({ ok: false, message: '변경 대상 예산을 찾을 수 없습니다.' }, 404);
      const requestNo = await nextOperationNumber(db, 'budget-change', year), id = `BCR-${randomHex(24)}`, now = new Date().toISOString();
      await db.batch([
        db.prepare(`INSERT INTO accounting_budget_change_requests
          (id,request_no,fiscal_year,change_type,target_budget_id,source_budget_id,requested_amount,reason,valid_until,status,requested_by_user_id,requested_by_name,requested_at,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,'pending',?,?,?,?,?)`)
          .bind(id, requestNo, year, type, targetId, sourceId || null, amount, reason, validUntil || null, me.id, me.name, now, now, now),
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
        const claimed = await db.prepare(`UPDATE accounting_budget_change_requests SET status='processing',processing_by_user_id=?,processing_at=?,updated_at=? WHERE id=? AND status='pending' RETURNING id`).bind(me.id, now, now, id).first();
        if (!claimed) return json({ ok: false, message: '다른 승인자가 먼저 처리 중이거나 완료했습니다.' }, 409);
        try {
          await db.batch([
            db.prepare(`UPDATE accounting_budget_change_requests SET status='rejected',reviewed_by_user_id=?,reviewed_by_name=?,reviewed_at=?,review_memo=?,processing_by_user_id=NULL,processing_at=NULL,updated_at=? WHERE id=? AND status='processing' AND processing_by_user_id=?`).bind(me.id, me.name, now, memo || null, now, id, me.id),
            operationAudit(db, 'reject', 'budget-change', id, me, { memo }, now),
          ]);
        } catch (error) {
          await db.prepare(`UPDATE accounting_budget_change_requests SET status='pending',processing_by_user_id=NULL,processing_at=NULL,updated_at=? WHERE id=? AND status='processing' AND processing_by_user_id=?`).bind(new Date().toISOString(), id, me.id).run().catch(() => undefined);
          throw error;
        }
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
          db.prepare(`UPDATE accounting_budget_plans SET transfer_out=transfer_out+?,updated_at=? WHERE id=?`).bind(amount, now, source.id),
          budgetVersionStatement(db, source, await nextBudgetVersion(db, source.id), 'approved_transfer_out', id, me.name, now),
        );
      }
      if (requestRow.change_type !== 'over_budget_exception') {
        const targetUpdate = requestRow.change_type === 'supplementary'
          ? db.prepare(`UPDATE accounting_budget_plans SET supplementary_amount=supplementary_amount+?,updated_at=? WHERE id=?`).bind(amount, now, target.id)
          : requestRow.change_type === 'reduction'
            ? db.prepare(`UPDATE accounting_budget_plans SET supplementary_amount=supplementary_amount-?,updated_at=? WHERE id=?`).bind(amount, now, target.id)
            : db.prepare(`UPDATE accounting_budget_plans SET transfer_in=transfer_in+?,updated_at=? WHERE id=?`).bind(amount, now, target.id);
        statements.push(
          targetUpdate,
          budgetVersionStatement(db, target, await nextBudgetVersion(db, target.id), `approved_${requestRow.change_type}`, id, me.name, now),
        );
      }
      const claimed = await db.prepare(`UPDATE accounting_budget_change_requests SET status='processing',processing_by_user_id=?,processing_at=?,updated_at=? WHERE id=? AND status='pending' RETURNING id`).bind(me.id, now, now, id).first();
      if (!claimed) return json({ ok: false, message: '다른 승인자가 먼저 처리 중이거나 완료했습니다.' }, 409);
      statements.push(
        db.prepare(`UPDATE accounting_budget_change_requests SET status='approved',reviewed_by_user_id=?,reviewed_by_name=?,reviewed_at=?,review_memo=?,processing_by_user_id=NULL,processing_at=NULL,updated_at=? WHERE id=? AND status='processing' AND processing_by_user_id=?`).bind(me.id, me.name, now, memo || null, now, id, me.id),
        operationAudit(db, 'approve', 'budget-change', id, me, { type: requestRow.change_type, amount, memo }, now),
      );
      try {
        await db.batch(statements);
      } catch (error) {
        await db.prepare(`UPDATE accounting_budget_change_requests SET status='pending',processing_by_user_id=NULL,processing_at=NULL,updated_at=? WHERE id=? AND status='processing' AND processing_by_user_id=?`).bind(new Date().toISOString(), id, me.id).run().catch(() => undefined);
        throw error;
      }
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
      if (!['approve', 'reject'].includes(decision)) return json({ ok: false, message: '승인 또는 반려를 선택해 주세요.' }, 400);
      const row = await db.prepare(`SELECT * FROM accounting_vendor_bank_changes WHERE id=? AND status='pending'`).bind(id).first<any>();
      if (!row) return json({ ok: false, message: '처리할 계좌변경 요청을 찾을 수 없습니다.' }, 404);
      if (String(row.requested_by_user_id) === String(me.id) && me.role !== 'admin') return json({ ok: false, message: '요청자 본인은 계좌변경을 승인할 수 없습니다.' }, 403);
      const claimed = await db.prepare(`UPDATE accounting_vendor_bank_changes SET status='processing',processing_by_user_id=?,processing_at=?,updated_at=?
        WHERE id=? AND status='pending' RETURNING *`).bind(me.id, now, now, id).first<any>();
      if (!claimed) return json({ ok: false, message: '다른 승인자가 먼저 처리 중이거나 완료했습니다.' }, 409);
      try {
        const statements = [
          db.prepare(`UPDATE accounting_vendor_bank_changes SET status=?,reviewed_by_user_id=?,reviewed_by_name=?,reviewed_at=?,review_memo=?,processing_by_user_id=NULL,processing_at=NULL,updated_at=? WHERE id=? AND status='processing' AND processing_by_user_id=?`).bind(decision === 'approve' ? 'approved' : 'rejected', me.id, me.name, now, memo || null, now, id, me.id),
          operationAudit(db, decision, 'vendor-bank-change', id, me, { vendorId: claimed.vendor_id, memo }, now),
        ];
        if (decision === 'approve') statements.unshift(db.prepare(`UPDATE accounting_vendors SET bank_name=?,bank_account_masked=?,bank_account_fingerprint=?,bank_account_holder=?,updated_at=? WHERE id=?`).bind(claimed.new_bank_name, claimed.new_account_masked, claimed.new_account_fingerprint, claimed.new_account_holder, now, claimed.vendor_id));
        await db.batch(statements);
      } catch (error) {
        await db.prepare(`UPDATE accounting_vendor_bank_changes SET status='pending',processing_by_user_id=NULL,processing_at=NULL,updated_at=? WHERE id=? AND status='processing' AND processing_by_user_id=?`).bind(new Date().toISOString(), id, me.id).run().catch(() => undefined);
        throw error;
      }
      return json({ ok: true, message: decision === 'approve' ? '거래처 계좌변경을 승인했습니다.' : '거래처 계좌변경을 반려했습니다.' });
    }

    if (action === 'save-contract') {
      if (!manager) return json({ ok: false, message: '계약 관리 권한이 없습니다.' }, 403);
      const id = clean(payload.id, 80) || `CTR-${randomHex(24)}`, vendorId = clean(payload.vendorId, 80), title = clean(payload.title, 200), amount = Math.abs(parseMoney(payload.amount));
      const contractDate = clean(payload.contractDate, 10), startDate = clean(payload.startDate, 10), endDate = clean(payload.endDate, 10), procurement = clean(payload.procurementMethod, 30) || 'competitive';
      if (!vendorId || !title || !amount || ![contractDate, startDate, endDate].every(validAccountingDate) || contractDate > startDate || startDate > endDate) return json({ ok: false, message: '거래처·계약명·금액과 계약일≤시작일≤종료일을 확인해 주세요.' }, 400);
      if (!['competitive', 'limited', 'sole_source'].includes(procurement)) return json({ ok: false, message: '계약방법을 확인해 주세요.' }, 400);
      const soleReason = clean(payload.soleSourceReason, 1000);
      if (procurement === 'sole_source' && !soleReason) return json({ ok: false, message: '수의계약 사유를 입력해 주세요.' }, 400);
      if (payload.conflictChecked !== true) return json({ ok: false, message: '이해충돌·특수관계인 확인을 완료해 주세요.' }, 400);
      const vendor = await db.prepare(`SELECT id FROM accounting_vendors WHERE id=? AND active=1`).bind(vendorId).first();
      const accountCode = clean(payload.accountCode, 20), account = await db.prepare(`SELECT code FROM accounting_accounts WHERE code=? AND account_type='expense' AND active=1`).bind(accountCode).first();
      if (!vendor || !account) return json({ ok: false, message: '거래처 또는 지출 계정과목을 확인해 주세요.' }, 400);
      const dimensions = await validateDimensions(db, payload), existing = await db.prepare(`SELECT c.*,
        (SELECT COUNT(*) FROM accounting_contract_payments p WHERE p.contract_id=c.id AND (p.resolution_id IS NOT NULL OR p.journal_id IS NOT NULL OR p.status IN ('linked','paid'))) AS linked_payments
        FROM accounting_contracts c WHERE c.id=?`).bind(id).first<any>();
      if (existing?.status === 'completed') return json({ ok: false, message: '지급 완료된 계약은 수정할 수 없습니다.' }, 409);
      if (Number(existing?.linked_payments || 0) > 0 && (existing.vendor_id !== vendorId || Number(existing.contract_amount) !== amount
        || existing.account_code !== accountCode || existing.book_type_code !== dimensions.bookTypeCode
        || existing.entity_id !== dimensions.entityId || existing.fund_id !== dimensions.fundId)) {
        return json({ ok: false, message: '결의·전표와 연결된 지급일정이 있는 계약은 거래처·금액·계정·회계차원을 변경할 수 없습니다.' }, 409);
      }
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
          .bind(id, contractNo, vendorId, title, clean(payload.contractType, 30) || 'service', procurement, amount, contractDate, startDate, endDate, Math.max(1, Math.min(365, Number(payload.renewalNoticeDays || 30))), normalizeDepartmentValue(payload.department, me.position || ''), clean(payload.project, 100), accountCode, dimensions.bookTypeCode, dimensions.entityId, dimensions.fundId, soleReason || null, payload.multiQuoteChecked === true ? 1 : 0, 1, clean(payload.conflictNote, 500) || null, payload.inspectionRequired === false ? 0 : 1, existing?.status || 'active', clean(payload.memo, 1000) || null, me.name, now, now),
        operationAudit(db, 'save', 'contract', id, me, { contractNo, vendorId, title, amount, procurement, ...dimensions }, now),
      ]);
      return json({ ok: true, id, contractNo, message: '계약을 저장하고 예산 약정액에 반영했습니다.' });
    }

    if (action === 'save-contract-payment') {
      if (!manager) return json({ ok: false, message: '계약 지급일정 관리 권한이 없습니다.' }, 403);
      const contractId = clean(payload.contractId, 80), id = clean(payload.id, 80) || `CTP-${randomHex(24)}`, amount = Math.abs(parseMoney(payload.amount));
      const contract = await db.prepare(`SELECT * FROM accounting_contracts WHERE id=?`).bind(contractId).first<any>();
      if (!contract || !amount) return json({ ok: false, message: '계약과 지급금액을 확인해 주세요.' }, 400);
      if (!['active', 'approved'].includes(String(contract.status || ''))) return json({ ok: false, message: '진행 중인 계약에만 지급일정을 추가할 수 있습니다.' }, 409);
      const currentPayment = await db.prepare(`SELECT * FROM accounting_contract_payments WHERE id=?`).bind(id).first<any>();
      if (currentPayment && (currentPayment.resolution_id || currentPayment.journal_id || ['linked','paid'].includes(currentPayment.status))) return json({ ok: false, message: '결의·전표와 연결된 지급일정은 수정할 수 없습니다.' }, 409);
      const dueDate = clean(payload.dueDate, 10), inspectionDate = clean(payload.inspectionDate, 10), invoiceDate = clean(payload.invoiceDate, 10);
      if ((dueDate && !validAccountingDate(dueDate)) || (inspectionDate && !validAccountingDate(inspectionDate))
        || (invoiceDate && !validAccountingDate(invoiceDate))) return json({ ok: false, message: '지급·검수·청구일자를 확인해 주세요.' }, 400);
      if ([dueDate, inspectionDate, invoiceDate].filter(Boolean).some((date) => date < contract.contract_date)
        || (inspectionDate && invoiceDate && inspectionDate > invoiceDate)
        || (invoiceDate && dueDate && invoiceDate > dueDate)
        || (inspectionDate && dueDate && inspectionDate > dueDate)) {
        return json({ ok: false, message: '지급일정은 계약일 이후이며 검수일≤청구일≤지급예정일 순서여야 합니다.' }, 400);
      }
      const existingTotal = await db.prepare(`SELECT COALESCE(SUM(amount),0) AS amount FROM accounting_contract_payments WHERE contract_id=? AND id<>?`).bind(contractId, id).first<{ amount: number }>();
      if (Number(existingTotal?.amount || 0) + amount > Number(contract.contract_amount || 0)) return json({ ok: false, message: '지급일정 합계가 계약금액을 초과합니다.' }, 400);
      const seqRow = currentPayment || await db.prepare(`SELECT COALESCE(MAX(payment_seq),0)+1 AS payment_seq FROM accounting_contract_payments WHERE contract_id=?`).bind(contractId).first<any>();
      const now = new Date().toISOString();
      await db.batch([
        db.prepare(`INSERT INTO accounting_contract_payments
          (id,contract_id,payment_seq,payment_name,due_date,amount,inspection_date,invoice_date,status,memo,created_by,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,'scheduled',?,?,?,?) ON CONFLICT(id) DO UPDATE SET payment_name=excluded.payment_name,due_date=excluded.due_date,
          amount=excluded.amount,inspection_date=excluded.inspection_date,invoice_date=excluded.invoice_date,memo=excluded.memo,updated_at=excluded.updated_at`)
          .bind(id, contractId, Number(seqRow?.payment_seq || 1), clean(payload.paymentName, 120) || `${Number(seqRow?.payment_seq || 1)}회차`, dueDate || null, amount, inspectionDate || null, invoiceDate || null, clean(payload.memo, 500) || null, me.name, now, now),
        operationAudit(db, 'save', 'contract-payment', id, me, { contractId, amount, dueDate: payload.dueDate }, now),
      ]);
      return json({ ok: true, id, message: '계약 지급일정을 저장했습니다.' });
    }

    if (action === 'link-contract-payment') {
      if (!manager) return json({ ok: false, message: '계약 지급 연결 권한이 없습니다.' }, 403);
      const paymentId = clean(payload.paymentId, 80), resolutionId = clean(payload.resolutionId, 100), now = new Date().toISOString();
      const [payment, resolution] = await Promise.all([
        db.prepare(`SELECT p.*,c.vendor_id,c.contract_amount,c.account_code,c.book_type_code,c.entity_id,c.fund_id,c.department,c.project,c.status AS contract_status FROM accounting_contract_payments p JOIN accounting_contracts c ON c.id=p.contract_id WHERE p.id=?`).bind(paymentId).first<any>(),
        db.prepare(`SELECT r.*,COALESCE(d.book_type_code,'general') AS dimension_book_type_code,COALESCE(d.entity_id,'ENTITY-HQ') AS dimension_entity_id,COALESCE(d.fund_id,'') AS dimension_fund_id FROM accounting_resolutions r LEFT JOIN accounting_resolution_dimensions d ON d.resolution_id=r.id WHERE r.id=? AND r.resolution_type='expense'`).bind(resolutionId).first<any>(),
      ]);
      if (!payment || !resolution) return json({ ok: false, message: '지급일정 또는 지출결의서를 찾을 수 없습니다.' }, 404);
      if (payment.resolution_id || payment.journal_id || !['scheduled'].includes(String(payment.status || ''))) return json({ ok: false, message: '이미 다른 결의·전표와 연결되었거나 지급 완료된 일정입니다.' }, 409);
      if (!['active','approved'].includes(String(payment.contract_status || '')) || ['cancelled','rejected'].includes(String(resolution.status || ''))) return json({ ok: false, message: '종료된 계약이나 취소·반려된 지출결의에는 연결할 수 없습니다.' }, 409);
      if (Number(payment.amount) !== Number(resolution.amount)) return json({ ok: false, message: '지급일정과 지출결의서의 금액이 일치하지 않습니다.' }, 400);
      if ((resolution.vendor_id && resolution.vendor_id !== payment.vendor_id) || (resolution.contract_id && resolution.contract_id !== payment.contract_id)
        || resolution.account_code !== payment.account_code || resolution.dimension_book_type_code !== payment.book_type_code
        || resolution.dimension_entity_id !== payment.entity_id || resolution.dimension_fund_id !== payment.fund_id
        || String(resolution.department || '') !== String(payment.department || '') || String(resolution.project || '') !== String(payment.project || '')) {
        return json({ ok: false, message: '계약·거래처·계정과목·담당부서·사업·회계차원이 지출결의와 일치해야 합니다.' }, 400);
      }
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
      const ids=listIds(payload.donationIds,501),year=validYear(payload.year);if(ids.length>500)return json({ok:false,message:'한 번에 최대 500건까지 처리할 수 있습니다.'},400);if(!year||!ids.length)return json({ok:false,message:'일괄처리할 기부내역을 선택해 주세요.'},400);
      const rows=await db.prepare(`SELECT d.id,d.donation_no FROM accounting_donations d WHERE d.fiscal_year=? AND d.donor_id IS NOT NULL AND d.status<>'cancelled' AND d.receipt_status IN ('not_requested','requested','error') AND d.id IN (SELECT CAST(value AS TEXT) FROM json_each(?)) ORDER BY d.donation_date,d.id`).bind(year,JSON.stringify(ids)).all<any>();
      if(!(rows.results||[]).length)return json({ok:false,message:'일괄발급 대상 기부내역이 없습니다.'},400);
      const exportNo=await nextOperationNumber(db,'donation-export',year),id=`DEX-${randomHex(24)}`,now=new Date().toISOString(),items=(rows.results||[]).map((r:any)=>({id:`DEXI-${randomHex(20)}`,donationId:r.id,donationNo:r.donation_no}));
      await db.batch([
        db.prepare(`INSERT INTO accounting_donation_export_batches (id,export_no,fiscal_year,export_type,status,item_count,created_by,created_at,updated_at) VALUES (?,?,?,'hometax_workbook','created',?,?,?,?)`).bind(id,exportNo,year,items.length,me.name,now,now),
        db.prepare(`INSERT INTO accounting_donation_export_items (id,batch_id,donation_id,donation_no,export_status,created_at,updated_at) SELECT json_extract(value,'$.id'),?,json_extract(value,'$.donationId'),json_extract(value,'$.donationNo'),'exported',?,? FROM json_each(?)`).bind(id,now,now,JSON.stringify(items)),
        operationAudit(db,'create','donation-export',id,me,{exportNo,year,itemCount:items.length},now),
      ]);
      return json({ok:true,id,exportNo,itemCount:items.length,message:'홈택스 작업파일 생성 이력을 등록했습니다.'});
    }

    if (action === 'apply-donation-results') {
      if (!manager) return json({ ok: false, message: '전자기부금영수증 결과 반영 권한이 없습니다.' }, 403);
      const rows=Array.isArray(payload.rows)?payload.rows as Array<Record<string,unknown>>:[];if(rows.length>500)return json({ok:false,message:'결과파일은 한 번에 최대 500건까지 반영할 수 있습니다.'},400);
      const batchId=clean(payload.batchId,80),filename=clean(payload.filename,200);if(!batchId||!rows.length)return json({ok:false,message:'결과를 반영할 일괄처리 건과 파일을 확인해 주세요.'},400);
      const normalized=rows.map(x=>({donationNo:clean(x.donationNo,80),rawStatus:normalizeMatchText(x.status),statusLabel:clean(x.status,80),externalNo:clean(x.externalReceiptNo,100),message:clean(x.message,500)}));
      const seen=new Set<string>();for(const x of normalized){if(!x.donationNo)continue;if(seen.has(x.donationNo))return json({ok:false,message:`결과파일에 기부번호 ${x.donationNo}가 중복되어 있습니다.`},400);seen.add(x.donationNo)}
      const now=new Date().toISOString(),staleBefore=new Date(Date.now()-10*60*1000).toISOString();
      const batch=await db.prepare(`UPDATE accounting_donation_export_batches SET status='processing_results',updated_at=? WHERE id=? AND (status IN ('created','processed_with_errors') OR (status='processing_results' AND updated_at<?)) RETURNING *`).bind(now,batchId,staleBefore).first<any>();
      if(!batch){const current=await db.prepare(`SELECT status FROM accounting_donation_export_batches WHERE id=?`).bind(batchId).first<{status:string}>();return json({ok:false,message:!current?'결과를 반영할 일괄처리 건을 찾을 수 없습니다.':current.status==='processing_results'?'같은 일괄처리 건의 결과가 이미 반영 중입니다.':'이미 결과 반영이 완료된 일괄처리 건입니다.'},current?409:404)}
      const previous=String(batch.status||'created');
      try{
        const nos=normalized.map(x=>x.donationNo).filter(Boolean);const found=await db.prepare(`SELECT i.*,d.fiscal_year,d.receipt_no,d.receipt_status,d.status AS donation_status FROM accounting_donation_export_items i JOIN accounting_donations d ON d.id=i.donation_id WHERE i.batch_id=? AND i.donation_no IN (SELECT CAST(value AS TEXT) FROM json_each(?)) AND i.export_status IN ('exported','error') AND d.status<>'cancelled'`).bind(batchId,JSON.stringify(nos)).all<any>();
        const byNo=new Map<string,any>();for(const r of found.results||[])byNo.set(String(r.donation_no||''),r);
        type U={itemId:string;donationId:string;receiptNo:string;externalNo:string;resultCode:string;resultMessage:string;year:number};const success:U[]=[],cancel:U[]=[],errorRows:U[]=[],needs=new Map<number,U[]>();let skipped=0;
        for(const x of normalized){const r=byNo.get(x.donationNo);if(!r){skipped++;continue}const isCancel=/취소|cancel/.test(x.rawStatus),isSuccess=/정상|성공|발급|완료|success|issued/.test(x.rawStatus)&&!/오류|실패|error/.test(x.rawStatus);const u:U={itemId:String(r.id),donationId:String(r.donation_id),receiptNo:'',externalNo:x.externalNo,resultCode:x.statusLabel||(isSuccess?'success':isCancel?'cancelled':'error'),resultMessage:x.message||'',year:Number(r.fiscal_year||batch.fiscal_year||0)};
          if(isCancel){cancel.push(u);continue}if(isSuccess){u.receiptNo=x.externalNo||clean(r.receipt_no,100);if(u.receiptNo){u.externalNo=u.externalNo||u.receiptNo;success.push(u)}else{const a=needs.get(u.year)||[];a.push(u);needs.set(u.year,a)}}else errorRows.push(u)}
        for(const [year,list] of needs){const nums=await reserveSpecialNumberBlock(db,'receipt',list.length,year);list.forEach((u,i)=>{u.receiptNo=nums[i];u.externalNo=nums[i];success.push(u)})}
        const statements:D1PreparedStatement[]=[];
        if(success.length){const j=JSON.stringify(success);statements.push(db.prepare(`WITH u AS (SELECT json_extract(value,'$.donationId') donation_id,json_extract(value,'$.receiptNo') receipt_no FROM json_each(?)) UPDATE accounting_donations SET receipt_requested=1,receipt_status='issued',receipt_no=(SELECT receipt_no FROM u WHERE u.donation_id=accounting_donations.id),receipt_issued_at=?,receipt_cancelled_at=NULL,updated_at=? WHERE id IN (SELECT donation_id FROM u) AND receipt_status IN ('not_requested','requested','error')`).bind(j,now,now),db.prepare(`WITH u AS (SELECT json_extract(value,'$.itemId') item_id,json_extract(value,'$.externalNo') external_no,json_extract(value,'$.resultCode') result_code,NULLIF(json_extract(value,'$.resultMessage'),'') result_message FROM json_each(?)) UPDATE accounting_donation_export_items SET export_status='issued',external_receipt_no=(SELECT external_no FROM u WHERE u.item_id=accounting_donation_export_items.id),result_code=(SELECT result_code FROM u WHERE u.item_id=accounting_donation_export_items.id),result_message=(SELECT result_message FROM u WHERE u.item_id=accounting_donation_export_items.id),processed_at=?,updated_at=? WHERE id IN (SELECT item_id FROM u)`).bind(j,now,now))}
        if(cancel.length){const j=JSON.stringify(cancel);statements.push(db.prepare(`WITH u AS (SELECT json_extract(value,'$.donationId') donation_id FROM json_each(?)) UPDATE accounting_donations SET receipt_status='cancelled',receipt_cancelled_at=?,updated_at=? WHERE id IN (SELECT donation_id FROM u) AND receipt_status IN ('requested','issued','error')`).bind(j,now,now),db.prepare(`WITH u AS (SELECT json_extract(value,'$.itemId') item_id,json_extract(value,'$.externalNo') external_no,json_extract(value,'$.resultCode') result_code,NULLIF(json_extract(value,'$.resultMessage'),'') result_message FROM json_each(?)) UPDATE accounting_donation_export_items SET export_status='cancelled',external_receipt_no=(SELECT external_no FROM u WHERE u.item_id=accounting_donation_export_items.id),result_code=(SELECT result_code FROM u WHERE u.item_id=accounting_donation_export_items.id),result_message=(SELECT result_message FROM u WHERE u.item_id=accounting_donation_export_items.id),processed_at=?,updated_at=? WHERE id IN (SELECT item_id FROM u)`).bind(j,now,now))}
        if(errorRows.length){const j=JSON.stringify(errorRows);statements.push(db.prepare(`WITH u AS (SELECT json_extract(value,'$.donationId') donation_id FROM json_each(?)) UPDATE accounting_donations SET receipt_requested=1,receipt_status='error',updated_at=? WHERE id IN (SELECT donation_id FROM u) AND receipt_status IN ('not_requested','requested','error')`).bind(j,now),db.prepare(`WITH u AS (SELECT json_extract(value,'$.itemId') item_id,json_extract(value,'$.externalNo') external_no,json_extract(value,'$.resultCode') result_code,COALESCE(NULLIF(json_extract(value,'$.resultMessage'),''),'처리 오류') result_message FROM json_each(?)) UPDATE accounting_donation_export_items SET export_status='error',external_receipt_no=(SELECT external_no FROM u WHERE u.item_id=accounting_donation_export_items.id),result_code=(SELECT result_code FROM u WHERE u.item_id=accounting_donation_export_items.id),result_message=(SELECT result_message FROM u WHERE u.item_id=accounting_donation_export_items.id),processed_at=?,updated_at=? WHERE id IN (SELECT item_id FROM u)`).bind(j,now,now))}
        statements.push(db.prepare(`UPDATE accounting_donation_export_batches SET status=CASE WHEN EXISTS(SELECT 1 FROM accounting_donation_export_items i WHERE i.batch_id=? AND i.export_status IN ('exported','error')) THEN 'processed_with_errors' ELSE 'processed' END,success_count=(SELECT COUNT(*) FROM accounting_donation_export_items i WHERE i.batch_id=? AND i.export_status IN ('issued','cancelled')),error_count=(SELECT COUNT(*) FROM accounting_donation_export_items i WHERE i.batch_id=? AND i.export_status='error'),original_result_filename=?,processed_by=?,processed_at=?,updated_at=? WHERE id=? AND status='processing_results'`).bind(batchId,batchId,batchId,filename||null,me.name,now,now,batchId),operationAudit(db,'apply-results','donation-export',batchId,me,{requested:rows.length,success:success.length,cancelled:cancel.length,errors:errorRows.length,skipped,filename},now));
        await db.batch(statements);return json({ok:true,success:success.length,errors:errorRows.length,cancelled:cancel.length,skipped,message:`발급 ${success.length}건, 취소 ${cancel.length}건, 오류 ${errorRows.length}건을 반영했습니다.${skipped?` 미확인 ${skipped}건은 제외했습니다.`:''}`});
      }catch(error){await db.prepare(`UPDATE accounting_donation_export_batches SET status=?,updated_at=? WHERE id=? AND status='processing_results'`).bind(previous==='processed_with_errors'?'processed_with_errors':'created',new Date().toISOString(),batchId).run().catch(()=>undefined);throw error}
    }

    return json({ ok: false, message: '지원하지 않는 실무 회계처리입니다.' }, 400);
  } catch (error) {
    console.error('accounting operations action failed', action, error);
    return json({ ok: false, message: error instanceof Error ? error.message : '실무 회계처리 중 오류가 발생했습니다.' }, 500);
  }
};

export const onRequestGet: PagesFunction = async () => json({ ok: false, message: 'POST 방식으로 요청해 주세요.' }, 405);
