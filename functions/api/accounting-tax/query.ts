import { authenticateSession, clean, ensureTables, json } from '../../_shared/helpers';
import { canViewAllAccounting, ensureAccountingTables, hasAccountingAccess, isAccountingManager } from '../../_shared/accounting';
import { getDimensionMaster } from '../../_shared/accounting-special';
import { ensureAccountingTaxTables, getTaxValidation, validTaxYear } from '../../_shared/accounting-tax';

interface Env { DB: D1Database; ACCOUNTING_DB: D1Database; }
type Payload = Record<string, unknown> & { token?: string; action?: string };

const currentYear = () => new Date(Date.now() + 9 * 60 * 60 * 1000).getUTCFullYear();
const requestedLimit = (value: unknown, fallback = 100) => Math.max(10, Math.min(200, Number(value || fallback) || fallback));
const EXPORT_PAGE_SIZE = 1000;
const EXPORT_MAX_ROWS = 100000;

const fetchCompleteExport = async <T>(
  db: D1Database,
  selectSql: string,
  values: unknown[],
  orderBy: string,
  expected: number,
  label: string,
) => {
  if (expected > EXPORT_MAX_ROWS) throw new Error(`${label}이 ${EXPORT_MAX_ROWS.toLocaleString('ko-KR')}건을 초과합니다. 조건을 나누어 내보내 주세요.`);
  const rows: T[] = [];
  for (let offset = 0; offset < expected; offset += EXPORT_PAGE_SIZE) {
    const page = await db.prepare(`${selectSql} ${orderBy} LIMIT ? OFFSET ?`)
      .bind(...values, EXPORT_PAGE_SIZE, offset).all<T>();
    rows.push(...(page.results || []));
  }
  if (rows.length !== expected) throw new Error(`${label} 전체 건수 검증에 실패했습니다. 예상 ${expected}건, 추출 ${rows.length}건입니다. 입력 작업이 끝난 뒤 다시 시도해 주세요.`);
  return rows;
};

const taxSummary = async (db: D1Database, year: number, entityId = '') => {
  const entityCondition = entityId ? ' AND entity_id=?' : '';
  const values = entityId ? [year, entityId] : [year];
  const [vat, withholding, exports, profile] = await db.batch([
    db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN status<>'cancelled' THEN 1 ELSE 0 END),0) AS record_count,
      COALESCE(SUM(CASE WHEN direction='purchase' AND status<>'cancelled' THEN supply_amount ELSE 0 END),0) AS purchase_supply,
      COALESCE(SUM(CASE WHEN direction='purchase' AND status<>'cancelled' THEN vat_amount ELSE 0 END),0) AS input_vat,
      COALESCE(SUM(CASE WHEN direction='sale' AND status<>'cancelled' THEN supply_amount ELSE 0 END),0) AS sale_supply,
      COALESCE(SUM(CASE WHEN direction='sale' AND status<>'cancelled' THEN vat_amount ELSE 0 END),0) AS output_vat,
      COALESCE(SUM(CASE WHEN status<>'cancelled' AND (status='draft' OR deduction_status='pending') THEN 1 ELSE 0 END),0) AS pending_count
      FROM accounting_vat_records WHERE fiscal_year=?${entityCondition}`).bind(...values),
    db.prepare(`SELECT COALESCE(SUM(CASE WHEN filing_status<>'cancelled' THEN 1 ELSE 0 END),0) AS record_count,
      COALESCE(SUM(CASE WHEN filing_status<>'cancelled' THEN gross_amount ELSE 0 END),0) AS gross_amount,
      COALESCE(SUM(CASE WHEN filing_status<>'cancelled' THEN income_tax ELSE 0 END),0) AS income_tax,
      COALESCE(SUM(CASE WHEN filing_status<>'cancelled' THEN local_income_tax ELSE 0 END),0) AS local_income_tax,
      COALESCE(SUM(CASE WHEN filing_status='unfiled' THEN 1 ELSE 0 END),0) AS unfiled_count
      FROM accounting_withholding_records WHERE fiscal_year=?${entityCondition}`).bind(...values),
    db.prepare(`SELECT COUNT(*) AS count FROM accounting_tax_export_batches WHERE fiscal_year=?${entityCondition}`)
      .bind(...values),
    db.prepare(`SELECT profile_status,vat_business_type,withholding_enabled FROM accounting_tax_profiles
      WHERE fiscal_year=?${entityCondition} ORDER BY updated_at DESC LIMIT 1`).bind(...values),
  ]);
  return {
    ...(vat.results?.[0] || {}),
    withholding: withholding.results?.[0] || {},
    export_count: Number((exports.results?.[0] as any)?.count || 0),
    profile: profile.results?.[0] || null,
  };
};

const vatRows = async (db: D1Database, payload: Payload, year: number, all: boolean) => {
  const conditions = ['v.fiscal_year=?'];
  const values: unknown[] = [year];
  const entityId = clean(payload.entityId, 80), direction = clean(payload.direction, 20), status = clean(payload.status, 20);
  const filingPeriod = clean(payload.filingPeriod, 20), query = clean(payload.query, 120);
  if (entityId) { conditions.push('v.entity_id=?'); values.push(entityId); }
  if (direction) { conditions.push('v.direction=?'); values.push(direction); }
  if (status) { conditions.push('v.status=?'); values.push(status); }
  if (filingPeriod) { conditions.push('v.filing_period=?'); values.push(filingPeriod); }
  if (query) {
    conditions.push(`(v.counterparty_name LIKE ? OR v.counterparty_business_no LIKE ? OR v.evidence_no LIKE ? OR v.source_id LIKE ?)`);
    values.push(`%${query}%`, `%${query}%`, `%${query}%`, `%${query}%`);
  }
  const where = conditions.join(' AND ');
  const limit = requestedLimit(payload.limit);
  const summary = await db.prepare(`SELECT COUNT(*) AS total_count,COALESCE(SUM(total_amount),0) AS total_amount,
    COALESCE(SUM(supply_amount),0) AS supply_amount,COALESCE(SUM(vat_amount),0) AS vat_amount
    FROM accounting_vat_records v WHERE ${where}`).bind(...values).first<any>() || {};
  const selectSql = `SELECT v.*,b.name AS book_type_name,e.name AS entity_name,f.name AS fund_name
    FROM accounting_vat_records v
    LEFT JOIN accounting_book_types b ON b.code=v.book_type_code
    LEFT JOIN accounting_entities e ON e.id=v.entity_id
    LEFT JOIN accounting_funds f ON f.id=v.fund_id WHERE ${where}`;
  const orderBy = 'ORDER BY v.transaction_date DESC,v.created_at DESC,v.id DESC';
  const expected = Number(summary.total_count || 0);
  const rows = all
    ? await fetchCompleteExport<any>(db, selectSql, values, orderBy, expected, '부가가치세 내보내기 자료')
    : ((await db.prepare(`${selectSql} ${orderBy} LIMIT ${limit}`).bind(...values).all()).results || []);
  return { rows, summary, limit: all ? null : limit, complete: all, expectedCount: expected };
};

const withholdingRows = async (db: D1Database, payload: Payload, year: number, all: boolean) => {
  const conditions = ['w.fiscal_year=?'];
  const values: unknown[] = [year];
  const entityId = clean(payload.entityId, 80), status = clean(payload.status, 20), filingMonth = clean(payload.filingMonth, 7);
  const incomeType = clean(payload.incomeType, 30), query = clean(payload.query, 120);
  if (entityId) { conditions.push('w.entity_id=?'); values.push(entityId); }
  if (status) { conditions.push('w.filing_status=?'); values.push(status); }
  if (filingMonth) { conditions.push('w.filing_month=?'); values.push(filingMonth); }
  if (incomeType) { conditions.push('w.income_type=?'); values.push(incomeType); }
  if (query) { conditions.push('(p.name LIKE ? OR p.payee_no LIKE ? OR w.payment_no LIKE ?)'); values.push(`%${query}%`, `%${query}%`, `%${query}%`); }
  const where = conditions.join(' AND '), limit = requestedLimit(payload.limit);
  const summary = await db.prepare(`SELECT COUNT(*) AS total_count,COALESCE(SUM(w.gross_amount),0) AS gross_amount,
    COALESCE(SUM(w.income_tax),0) AS income_tax,COALESCE(SUM(w.local_income_tax),0) AS local_income_tax,
    COALESCE(SUM(w.net_amount),0) AS net_amount
    FROM accounting_withholding_records w JOIN accounting_tax_payees p ON p.id=w.payee_id WHERE ${where}`)
    .bind(...values).first<any>() || {};
  const selectSql = `SELECT w.*,p.payee_no,p.payee_type,p.name AS payee_name,p.identifier_masked,p.business_no,p.resident_status,
    b.name AS book_type_name,e.name AS entity_name,f.name AS fund_name,r.resolution_no
    FROM accounting_withholding_records w JOIN accounting_tax_payees p ON p.id=w.payee_id
    LEFT JOIN accounting_book_types b ON b.code=w.book_type_code
    LEFT JOIN accounting_entities e ON e.id=w.entity_id LEFT JOIN accounting_funds f ON f.id=w.fund_id
    LEFT JOIN accounting_resolutions r ON r.id=w.source_resolution_id WHERE ${where}`;
  const orderBy = 'ORDER BY w.payment_date DESC,w.created_at DESC,w.id DESC';
  const expected = Number(summary.total_count || 0);
  const rows = all
    ? await fetchCompleteExport<any>(db, selectSql, values, orderBy, expected, '원천징수 내보내기 자료')
    : ((await db.prepare(`${selectSql} ${orderBy} LIMIT ${limit}`).bind(...values).all()).results || []);
  return { rows, summary, limit: all ? null : limit, complete: all, expectedCount: expected };
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB || !env.ACCOUNTING_DB) return json({ ok: false, message: '전자문서 DB 또는 회계 전용 DB가 연결되지 않았습니다.' }, 500);
  let payload: Payload;
  try { payload = await request.json(); } catch { return json({ ok: false, message: '요청 형식이 올바르지 않습니다.' }, 400); }
  await ensureTables(env.DB);
  const auth = await authenticateSession(env.DB, clean(payload.token, 200));
  if (!auth.ok) return json({ ok: false, message: auth.message }, auth.status);
  if (!hasAccountingAccess(auth.user) || !canViewAllAccounting(auth.user)) {
    return json({ ok: false, message: '세무·신고자료는 회계담당자·관리자·감사만 조회할 수 있습니다.' }, 403);
  }
  try {
    await ensureAccountingTables(env.ACCOUNTING_DB);
    await ensureAccountingTaxTables(env.ACCOUNTING_DB);
    const db = env.ACCOUNTING_DB, action = clean(payload.action, 60) || 'init';
    const year = validTaxYear(payload.year) || currentYear();
    const manager = isAccountingManager(auth.user), canViewAll = canViewAllAccounting(auth.user);
    const entityId = clean(payload.entityId, 80);

    if (action === 'init') {
      const [fiscalYears, accounts, master, summary, validation, payees] = await Promise.all([
        db.prepare(`SELECT year,name,start_date,end_date,base_currency,status,closed_at FROM accounting_fiscal_years ORDER BY year`).all(),
        db.prepare(`SELECT code,name,account_type,normal_side,parent_code,active,system_account FROM accounting_accounts WHERE active=1 ORDER BY code`).all(),
        getDimensionMaster(db),
        taxSummary(db, year, entityId),
        getTaxValidation(db, year, entityId),
        db.prepare(`SELECT * FROM accounting_tax_payees WHERE active=1 ORDER BY name,payee_no`).all(),
      ]);
      return json({ ok: true, me: auth.user, permissions: { manager, canViewAll, audit: auth.user.role === 'audit' }, year,
        fiscalYears: fiscalYears.results || [], accounts: accounts.results || [], ...master, summary, validation, payees: payees.results || [] });
    }

    if (action === 'overview') return json({ ok: true, summary: await taxSummary(db, year, entityId), validation: await getTaxValidation(db, year, entityId) });

    if (action === 'profile') {
      const requestedEntity = entityId || 'ENTITY-HQ';
      const row = await db.prepare(`SELECT p.*,e.name AS entity_name FROM accounting_tax_profiles p
        LEFT JOIN accounting_entities e ON e.id=p.entity_id WHERE p.fiscal_year=? AND p.entity_id=?`)
        .bind(year, requestedEntity).first();
      return json({ ok: true, row: row || null });
    }

    if (action === 'payees') {
      const query = clean(payload.query, 120), activeOnly = payload.activeOnly !== false;
      const rows = await db.prepare(`SELECT * FROM accounting_tax_payees WHERE 1=1
        ${activeOnly ? 'AND active=1' : ''} ${query ? 'AND (name LIKE ? OR payee_no LIKE ? OR business_no LIKE ?)' : ''}
        ORDER BY active DESC,name,payee_no`)
        .bind(...(query ? [`%${query}%`, `%${query}%`, `%${query}%`] : [])).all();
      return json({ ok: true, rows: rows.results || [] });
    }

    if (action === 'vat-records' || action === 'vat-export') {
      if (!canViewAll) return json({ ok: false, message: '부가가치세 보조장부 조회 권한이 없습니다.' }, 403);
      return json({ ok: true, ...(await vatRows(db, payload, year, action === 'vat-export')) });
    }

    if (action === 'withholding-records' || action === 'withholding-export') {
      if (!canViewAll) return json({ ok: false, message: '원천징수 보조장부 조회 권한이 없습니다.' }, 403);
      return json({ ok: true, ...(await withholdingRows(db, payload, year, action === 'withholding-export')) });
    }

    if (action === 'source-candidates') {
      if (!canViewAll) return json({ ok: false, message: '연결 원자료 조회 권한이 없습니다.' }, 403);
      const type = clean(payload.sourceType, 30), start = `${year}-01-01`, end = `${year + 1}-01-01`;
      const requestedEntity = clean(payload.entityId, 80);
      let rows: any;
      if (type === 'resolution') rows = await db.prepare(`SELECT r.id,r.resolution_no AS source_no,r.resolution_date AS source_date,
        r.title AS description,r.counterparty,r.amount,r.tax_amount,
        CASE WHEN r.resolution_type='income' THEN 'sale' ELSE 'purchase' END AS direction,
        COALESCE(d.book_type_code,'general') AS book_type_code,
        COALESCE(d.entity_id,'ENTITY-HQ') AS entity_id,COALESCE(d.fund_id,'') AS fund_id
        FROM accounting_resolutions r LEFT JOIN accounting_resolution_dimensions d ON d.resolution_id=r.id
        WHERE r.fiscal_year=? ${requestedEntity ? `AND COALESCE(NULLIF(d.entity_id,''),'ENTITY-HQ')=?` : ''}
        ${clean(payload.direction, 20) === 'purchase' ? `AND r.resolution_type='expense'` : clean(payload.direction, 20) === 'sale' ? `AND r.resolution_type='income'` : ''}
        ORDER BY r.resolution_date DESC,r.created_at DESC LIMIT 500`).bind(year, ...(requestedEntity ? [requestedEntity] : [])).all();
      else if (type === 'card_transaction') rows = await db.prepare(`SELECT t.id,t.transaction_no AS source_no,t.transaction_date AS source_date,
        t.merchant AS description,t.merchant AS counterparty,t.amount,t.tax_amount,'purchase' AS direction,t.book_type_code,t.entity_id,t.fund_id
        FROM accounting_card_transactions t WHERE t.transaction_date>=? AND t.transaction_date<?
        ${requestedEntity ? 'AND t.entity_id=?' : ''}
        ORDER BY t.transaction_date DESC,t.created_at DESC LIMIT 500`).bind(start, end, ...(requestedEntity ? [requestedEntity] : [])).all();
      else if (type === 'import_transaction') rows = await db.prepare(`SELECT t.id,COALESCE(t.approval_no,t.id) AS source_no,t.transaction_date AS source_date,
        t.description,t.counterparty,t.amount,t.tax_amount,CASE WHEN t.direction='in' THEN 'sale' ELSE 'purchase' END AS direction,
        COALESCE(NULLIF(ba.book_type_code,''),NULLIF(c.book_type_code,''),'general') AS book_type_code,
        COALESCE(NULLIF(ba.entity_id,''),NULLIF(c.entity_id,''),'ENTITY-HQ') AS entity_id,
        COALESCE(ba.fund_id,'') AS fund_id
        FROM accounting_import_transactions t JOIN accounting_import_batches ib ON ib.id=t.batch_id
        LEFT JOIN accounting_bank_accounts ba ON t.source_type='bank' AND ba.id=ib.source_account_id
        LEFT JOIN accounting_cards c ON t.source_type='card' AND c.id=ib.source_account_id
        WHERE t.transaction_date>=? AND t.transaction_date<?
        ${requestedEntity ? `AND COALESCE(NULLIF(ba.entity_id,''),NULLIF(c.entity_id,''),'ENTITY-HQ')=?` : ''}
        ORDER BY t.transaction_date DESC,t.created_at DESC LIMIT 500`).bind(start, end, ...(requestedEntity ? [requestedEntity] : [])).all();
      else if (type === 'donation') rows = await db.prepare(`SELECT d.id,d.donation_no AS source_no,d.donation_date AS source_date,
        COALESCE(d.purpose,'기부금') AS description,COALESCE(o.name,'익명') AS counterparty,d.amount,0 AS tax_amount,'sale' AS direction,
        d.book_type_code,d.entity_id,d.fund_id FROM accounting_donations d LEFT JOIN accounting_donors o ON o.id=d.donor_id
        WHERE d.fiscal_year=? ${requestedEntity ? 'AND d.entity_id=?' : ''}
        ORDER BY d.donation_date DESC,d.created_at DESC LIMIT 500`).bind(year, ...(requestedEntity ? [requestedEntity] : [])).all();
      else if (type === 'journal') rows = await db.prepare(`SELECT j.id,j.journal_no AS source_no,j.journal_date AS source_date,
        j.description,'' AS counterparty,COALESCE(SUM(l.debit),0) AS amount,0 AS tax_amount,'' AS direction,
        COALESCE(MAX(d.book_type_code),'general') AS book_type_code,COALESCE(MAX(d.entity_id),'ENTITY-HQ') AS entity_id,
        COALESCE(MAX(d.fund_id),'') AS fund_id FROM accounting_journals j
        JOIN accounting_journal_lines l ON l.journal_id=j.id LEFT JOIN accounting_journal_line_dimensions d ON d.journal_line_id=l.id
        WHERE j.fiscal_year=? AND j.status IN ('posted','reversed') ${requestedEntity ? `AND COALESCE(NULLIF(d.entity_id,''),'ENTITY-HQ')=?` : ''}
        GROUP BY j.id
        HAVING COUNT(DISTINCT COALESCE(NULLIF(d.book_type_code,''),'general'))=1
          AND COUNT(DISTINCT COALESCE(NULLIF(d.entity_id,''),'ENTITY-HQ'))=1
          AND COUNT(DISTINCT COALESCE(d.fund_id,''))=1
        ORDER BY j.journal_date DESC,j.created_at DESC LIMIT 500`).bind(year, ...(requestedEntity ? [requestedEntity] : [])).all();
      else return json({ ok: false, message: '연결할 원자료 유형을 확인해 주세요.' }, 400);
      return json({ ok: true, rows: rows.results || [] });
    }

    if (action === 'export-history') {
      if (!canViewAll) return json({ ok: false, message: '제출 패키지 이력 조회 권한이 없습니다.' }, 403);
      const rows = await db.prepare(`SELECT x.*,e.name AS entity_name,b.name AS book_type_name,f.name AS fund_name
        FROM accounting_tax_export_batches x LEFT JOIN accounting_entities e ON e.id=x.entity_id
        LEFT JOIN accounting_book_types b ON b.code=x.book_type_code LEFT JOIN accounting_funds f ON f.id=x.fund_id
        WHERE x.fiscal_year=? ORDER BY x.created_at DESC LIMIT 100`).bind(year).all();
      return json({ ok: true, rows: rows.results || [] });
    }

    return json({ ok: false, message: '지원하지 않는 세무·신고자료 조회입니다.' }, 400);
  } catch (error) {
    console.error('accounting tax query failed', error);
    return json({ ok: false, message: error instanceof Error ? error.message : '세무·신고자료 조회 중 오류가 발생했습니다.' }, 500);
  }
};

export const onRequestGet: PagesFunction = async () => json({ ok: false, message: 'POST 방식으로 요청해 주세요.' }, 405);
