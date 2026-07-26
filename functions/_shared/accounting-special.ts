import { clean, randomHex } from './helpers';

export const ACCOUNTING_SPECIAL_SCHEMA_VERSION = '2026-07-26.1';

export const DEFAULT_BOOK_TYPES = [
  ['general', '일반회계', '종단의 일반적인 목적사업과 운영 활동을 관리합니다.', 1],
  ['purpose', '목적사업회계', '지정 목적·기금·보조사업 등 사용처가 제한된 회계를 관리합니다.', 1],
  ['revenue', '수익사업회계', '수익사업에서 발생하는 수입·지출과 자산을 구분 관리합니다.', 1],
] as const;

export const DEFAULT_FUNDS = [
  ['FUND-GENERAL', '일반재원', 'unrestricted', '사용 목적이 별도로 제한되지 않은 일반재원'],
  ['FUND-DESIGNATED', '목적지정 기부금', 'designated_donation', '기부자가 사용 목적을 지정한 기부금'],
  ['FUND-GRANT', '보조금·지원금', 'grant', '국가·지자체·기관의 보조금 및 지원금'],
  ['FUND-RESERVE', '적립금·준비금', 'reserve', '장래 사업과 시설을 위한 적립 재원'],
] as const;

let specialReady = false;
let specialPromise: Promise<void> | null = null;

const tableColumns = async (db: D1Database, table: string) => {
  const result = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  return new Set((result.results || []).map((row) => row.name));
};

export const ensureAccountingSpecialTables = async (db: D1Database) => {
  if (specialReady) return;
  if (!specialPromise) specialPromise = (async () => {
    const now = new Date().toISOString();
    await db.batch([
      db.prepare(`CREATE TABLE IF NOT EXISTS accounting_book_types (
        code TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
        active INTEGER NOT NULL DEFAULT 1, system_type INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS accounting_entities (
        id TEXT PRIMARY KEY, entity_code TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
        entity_type TEXT NOT NULL, parent_id TEXT, department_path TEXT,
        registration_no TEXT, representative TEXT, address TEXT,
        consolidation_enabled INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 1,
        created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS accounting_funds (
        id TEXT PRIMARY KEY, fund_code TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
        fund_type TEXT NOT NULL, purpose TEXT, restriction_note TEXT,
        active INTEGER NOT NULL DEFAULT 1, system_fund INTEGER NOT NULL DEFAULT 0,
        created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS accounting_budget_plans (
        id TEXT PRIMARY KEY, fiscal_year INTEGER NOT NULL,
        book_type_code TEXT NOT NULL DEFAULT 'general', entity_id TEXT NOT NULL DEFAULT '', fund_id TEXT NOT NULL DEFAULT '',
        department TEXT NOT NULL DEFAULT '', project TEXT NOT NULL DEFAULT '', account_code TEXT NOT NULL,
        original_amount INTEGER NOT NULL DEFAULT 0, supplementary_amount INTEGER NOT NULL DEFAULT 0,
        transfer_in INTEGER NOT NULL DEFAULT 0, transfer_out INTEGER NOT NULL DEFAULT 0,
        memo TEXT, created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(fiscal_year, book_type_code, entity_id, fund_id, department, project, account_code)
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS accounting_resolution_dimensions (
        resolution_id TEXT PRIMARY KEY, book_type_code TEXT NOT NULL DEFAULT 'general',
        entity_id TEXT NOT NULL DEFAULT '', fund_id TEXT NOT NULL DEFAULT '',
        source_category TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS accounting_journal_line_dimensions (
        journal_line_id TEXT PRIMARY KEY, book_type_code TEXT NOT NULL DEFAULT 'general',
        entity_id TEXT NOT NULL DEFAULT '', fund_id TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS accounting_donors (
        id TEXT PRIMARY KEY, donor_no TEXT NOT NULL UNIQUE, donor_type TEXT NOT NULL,
        name TEXT NOT NULL, identifier_masked TEXT, phone TEXT, email TEXT, address TEXT,
        receipt_consent INTEGER NOT NULL DEFAULT 0, memo TEXT,
        active INTEGER NOT NULL DEFAULT 1, created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS accounting_donations (
        id TEXT PRIMARY KEY, donation_no TEXT NOT NULL UNIQUE, fiscal_year INTEGER NOT NULL,
        donation_date TEXT NOT NULL, donor_id TEXT, donation_category TEXT NOT NULL,
        book_type_code TEXT NOT NULL DEFAULT 'general', entity_id TEXT NOT NULL DEFAULT '', fund_id TEXT NOT NULL DEFAULT '',
        amount INTEGER NOT NULL, payment_method TEXT, account_code TEXT NOT NULL DEFAULT '4200',
        settlement_account_code TEXT NOT NULL DEFAULT '1120', purpose TEXT, memo TEXT,
        receipt_requested INTEGER NOT NULL DEFAULT 0, receipt_status TEXT NOT NULL DEFAULT 'not_requested',
        receipt_no TEXT, receipt_issued_at TEXT, receipt_cancelled_at TEXT,
        journal_id TEXT, status TEXT NOT NULL DEFAULT 'registered',
        created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS accounting_assets (
        id TEXT PRIMARY KEY, asset_no TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
        category TEXT NOT NULL, acquisition_date TEXT NOT NULL, acquisition_cost INTEGER NOT NULL,
        useful_life_months INTEGER NOT NULL DEFAULT 0, depreciation_method TEXT NOT NULL DEFAULT 'straight_line',
        residual_value INTEGER NOT NULL DEFAULT 0, book_type_code TEXT NOT NULL DEFAULT 'general',
        entity_id TEXT NOT NULL DEFAULT '', fund_id TEXT NOT NULL DEFAULT '', department TEXT NOT NULL DEFAULT '',
        location TEXT, custodian TEXT, asset_account_code TEXT NOT NULL DEFAULT '1500',
        status TEXT NOT NULL DEFAULT 'in_use', disposal_date TEXT, disposal_amount INTEGER,
        memo TEXT, created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS accounting_cards (
        id TEXT PRIMARY KEY, card_code TEXT NOT NULL UNIQUE, card_label TEXT NOT NULL,
        issuer TEXT, masked_number TEXT, holder TEXT,
        book_type_code TEXT NOT NULL DEFAULT 'general', entity_id TEXT NOT NULL DEFAULT '', department TEXT NOT NULL DEFAULT '',
        settlement_account_code TEXT NOT NULL DEFAULT '1130', active INTEGER NOT NULL DEFAULT 1,
        created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS accounting_card_transactions (
        id TEXT PRIMARY KEY, transaction_no TEXT NOT NULL UNIQUE, card_id TEXT NOT NULL,
        transaction_date TEXT NOT NULL, merchant TEXT NOT NULL, amount INTEGER NOT NULL,
        tax_amount INTEGER NOT NULL DEFAULT 0, account_code TEXT,
        book_type_code TEXT NOT NULL DEFAULT 'general', entity_id TEXT NOT NULL DEFAULT '', fund_id TEXT NOT NULL DEFAULT '',
        department TEXT NOT NULL DEFAULT '', project TEXT NOT NULL DEFAULT '', memo TEXT,
        status TEXT NOT NULL DEFAULT 'unmatched', resolution_id TEXT, journal_id TEXT,
        created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS accounting_branch_reports (
        id TEXT PRIMARY KEY, fiscal_year INTEGER NOT NULL, period_type TEXT NOT NULL, period_key TEXT NOT NULL,
        entity_id TEXT NOT NULL, book_type_code TEXT NOT NULL DEFAULT 'general',
        income_total INTEGER NOT NULL DEFAULT 0, expense_total INTEGER NOT NULL DEFAULT 0,
        asset_total INTEGER NOT NULL DEFAULT 0, liability_total INTEGER NOT NULL DEFAULT 0,
        cash_balance INTEGER NOT NULL DEFAULT 0, donation_total INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'draft', detail_json TEXT NOT NULL DEFAULT '{}', memo TEXT,
        submitted_by TEXT, submitted_at TEXT, reviewed_by TEXT, reviewed_at TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(fiscal_year, period_type, period_key, entity_id, book_type_code)
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS accounting_special_sequences (
        seq_key TEXT PRIMARY KEY, last_seq INTEGER NOT NULL DEFAULT 0
      )`),
    ]);

    const bookStatements = DEFAULT_BOOK_TYPES.map(([code, name, description, system]) => db.prepare(`
      INSERT OR IGNORE INTO accounting_book_types
      (code,name,description,active,system_type,created_at,updated_at) VALUES (?,?,?,1,?,?,?)
    `).bind(code, name, description, system, now, now));
    await db.batch(bookStatements);

    await db.prepare(`INSERT OR IGNORE INTO accounting_entities
      (id,entity_code,name,entity_type,parent_id,department_path,consolidation_enabled,active,created_by,created_at,updated_at)
      VALUES ('ENTITY-HQ','HQ','종단 본부','headquarters',NULL,'사무국',1,1,'system',?,?)`)
      .bind(now, now).run();

    const fundStatements = DEFAULT_FUNDS.map(([code, name, type, purpose]) => db.prepare(`
      INSERT OR IGNORE INTO accounting_funds
      (id,fund_code,name,fund_type,purpose,active,system_fund,created_by,created_at,updated_at)
      VALUES (?,?,?,?,?,1,1,'system',?,?)
    `).bind(`FUND-${randomHex(12)}`, code, name, type, purpose, now, now));
    await db.batch(fundStatements);

    // 기존 1단계 예산을 차원형 예산표로 안전하게 복사합니다. 기존 테이블은 보존합니다.
    const legacyColumns = await tableColumns(db, 'accounting_budgets');
    if (legacyColumns.has('id')) {
      await db.prepare(`INSERT OR IGNORE INTO accounting_budget_plans
        (id,fiscal_year,book_type_code,entity_id,fund_id,department,project,account_code,
         original_amount,supplementary_amount,transfer_in,transfer_out,memo,created_by,created_at,updated_at)
        SELECT id,fiscal_year,'general','ENTITY-HQ','',department,project,account_code,
         original_amount,supplementary_amount,transfer_in,transfer_out,memo,created_by,created_at,updated_at
        FROM accounting_budgets`).run();
    }

    await db.batch([
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_acc_budget_plan_dims ON accounting_budget_plans
        (fiscal_year,book_type_code,entity_id,fund_id,account_code)`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_acc_resolution_dims ON accounting_resolution_dimensions
        (book_type_code,entity_id,fund_id)`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_acc_journal_line_dims ON accounting_journal_line_dimensions
        (book_type_code,entity_id,fund_id)`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_acc_donation_date ON accounting_donations
        (fiscal_year,donation_date DESC)`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_acc_donation_donor ON accounting_donations (donor_id)`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_acc_asset_entity ON accounting_assets (entity_id,status)`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_acc_card_tx_status ON accounting_card_transactions (status,transaction_date DESC)`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_acc_branch_period ON accounting_branch_reports
        (fiscal_year,period_type,period_key,status)`),
    ]);

    specialReady = true;
  })().catch((error) => { specialPromise = null; throw error; });
  await specialPromise;
};

export const nextSpecialSequence = async (db: D1Database, key: string) => {
  await db.prepare(`INSERT OR IGNORE INTO accounting_special_sequences (seq_key,last_seq) VALUES (?,0)`).bind(key).run();
  const row = await db.prepare(`UPDATE accounting_special_sequences SET last_seq=last_seq+1 WHERE seq_key=? RETURNING last_seq`)
    .bind(key).first<{ last_seq: number }>();
  return Number(row?.last_seq || 1);
};

export const nextSpecialNumber = async (db: D1Database, type: 'donor'|'donation'|'receipt'|'asset'|'card'|'card-tx', year?: number) => {
  const y = year || new Date(Date.now() + 9 * 60 * 60 * 1000).getUTCFullYear();
  const meta = {
    donor: ['후원자', `donor:${y}`, 5],
    donation: ['기부', `donation:${y}`, 5],
    receipt: ['기부금영수증', `receipt:${y}`, 5],
    asset: ['자산', `asset:${y}`, 5],
    card: ['카드', `card:${y}`, 4],
    'card-tx': ['카드사용', `card-tx:${y}`, 5],
  } as const;
  const [prefix, key, digits] = meta[type];
  const seq = await nextSpecialSequence(db, key);
  return `${prefix}-${y}-${String(seq).padStart(digits, '0')}`;
};

export const getDimensionMaster = async (db: D1Database) => {
  const [books, entities, funds] = await db.batch([
    db.prepare(`SELECT code,name,description,active,system_type FROM accounting_book_types WHERE active=1 ORDER BY CASE code WHEN 'general' THEN 1 WHEN 'purpose' THEN 2 WHEN 'revenue' THEN 3 ELSE 9 END,name`),
    db.prepare(`SELECT id,entity_code,name,entity_type,parent_id,department_path,representative,address,consolidation_enabled,active FROM accounting_entities WHERE active=1 ORDER BY entity_type,entity_code,name`),
    db.prepare(`SELECT id,fund_code,name,fund_type,purpose,restriction_note,active,system_fund FROM accounting_funds WHERE active=1 ORDER BY system_fund DESC,fund_code,name`),
  ]);
  return { books: books.results || [], entities: entities.results || [], funds: funds.results || [] };
};

export const validateDimensions = async (db: D1Database, raw: Record<string, unknown>) => {
  const bookTypeCode = clean(raw.bookTypeCode, 30) || 'general';
  const entityId = clean(raw.entityId, 80) || 'ENTITY-HQ';
  const fundId = clean(raw.fundId, 80);
  const [book, entity, fund] = await db.batch([
    db.prepare(`SELECT code FROM accounting_book_types WHERE code=? AND active=1`).bind(bookTypeCode),
    db.prepare(`SELECT id FROM accounting_entities WHERE id=? AND active=1`).bind(entityId),
    fundId ? db.prepare(`SELECT id FROM accounting_funds WHERE id=? AND active=1`).bind(fundId) : db.prepare(`SELECT '' AS id`),
  ]);
  if (!book.results?.length) throw new Error('회계구분을 확인해 주세요.');
  if (!entity.results?.length) throw new Error('회계조직을 확인해 주세요.');
  if (fundId && !fund.results?.length) throw new Error('재원을 확인해 주세요.');
  return { bookTypeCode, entityId, fundId };
};

export const getResolutionDimensions = async (db: D1Database, resolutionId: string) => {
  const row = await db.prepare(`SELECT book_type_code,entity_id,fund_id,source_category
    FROM accounting_resolution_dimensions WHERE resolution_id=?`).bind(resolutionId).first<any>();
  return {
    bookTypeCode: row?.book_type_code || 'general',
    entityId: row?.entity_id || 'ENTITY-HQ',
    fundId: row?.fund_id || '',
    sourceCategory: row?.source_category || '',
  };
};

export const cleanSpecialText = (value: unknown, max = 200) => clean(value, max);
