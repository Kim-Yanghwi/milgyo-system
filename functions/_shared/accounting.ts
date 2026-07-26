import { clean, randomHex, type SessionUser } from './helpers';
import { ensureAccountingSpecialTables, getResolutionDimensions } from './accounting-special';

export const ACCOUNTING_SCHEMA_VERSION = '2026-07-26.3';

const DEFAULT_ACCOUNTS = [
  ['1000','자산','asset','debit','',1],
  ['1100','현금및현금성자산','asset','debit','1000',1],
  ['1110','현금','asset','debit','1100',1],
  ['1120','보통예금','asset','debit','1100',1],
  ['1130','법인카드미결제','asset','debit','1100',1],
  ['1200','미수금','asset','debit','1000',1],
  ['1300','선급금','asset','debit','1000',1],
  ['1500','유형자산','asset','debit','1000',1],
  ['2000','부채','liability','credit','',1],
  ['2100','미지급금','liability','credit','2000',1],
  ['2200','예수금','liability','credit','2000',1],
  ['3000','순자산','equity','credit','',1],
  ['3100','기본순자산','equity','credit','3000',1],
  ['3200','이월잉여금','equity','credit','3000',1],
  ['4000','수입','revenue','credit','',1],
  ['4100','회비수입','revenue','credit','4000',1],
  ['4200','후원금·보시금수입','revenue','credit','4000',1],
  ['4210','목적지정기부금수입','revenue','credit','4200',1],
  ['4300','교육·법회·의례수입','revenue','credit','4000',1],
  ['4400','보조금·지원금수입','revenue','credit','4000',1],
  ['4900','기타수입','revenue','credit','4000',1],
  ['5000','지출','expense','debit','',1],
  ['5100','인건비','expense','debit','5000',1],
  ['5200','임차료','expense','debit','5000',1],
  ['5300','공공요금·제세공과금','expense','debit','5000',1],
  ['5400','사무용품·소모품비','expense','debit','5000',1],
  ['5500','여비·교통비','expense','debit','5000',1],
  ['5600','회의비·업무추진비','expense','debit','5000',1],
  ['5700','교육·연수비','expense','debit','5000',1],
  ['5800','법회·의례·포교사업비','expense','debit','5000',1],
  ['5900','기타운영비','expense','debit','5000',1],
  ['6100','목적사업비','expense','debit','5000',1],
  ['6200','시설비·수선비','expense','debit','5000',1],
  ['6300','지원금·보조금지출','expense','debit','5000',1],
];

let accountingReady = false;
let accountingPromise: Promise<void> | null = null;

export const parseMoney = (value: unknown) => {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value) : 0;
  const text = String(value ?? '').trim();
  if (!text) return 0;
  const negative = /^\s*\(|^-/.test(text);
  const normalized = text.replace(/[^0-9.]/g, '');
  const amount = Number(normalized || 0);
  if (!Number.isFinite(amount)) return 0;
  return Math.round((negative ? -1 : 1) * amount);
};

export const isAccountingManager = (user: SessionUser) => {
  if (user.role === 'admin') return true;
  const scope = `${user.position || ''} ${user.department || ''}`;
  return /(이사장|사무총장|재정|회계)/.test(scope);
};

export const canViewAllAccounting = (user: SessionUser) => user.role === 'admin' || user.role === 'audit' || isAccountingManager(user);

export const ensureAccountingTables = async (db: D1Database) => {
  if (accountingReady) return;
  if (!accountingPromise) accountingPromise = (async () => {
    await db.batch([
      db.prepare(`CREATE TABLE IF NOT EXISTS accounting_fiscal_years (
        year INTEGER PRIMARY KEY, name TEXT NOT NULL, start_date TEXT NOT NULL, end_date TEXT NOT NULL,
        base_currency TEXT NOT NULL DEFAULT 'KRW', status TEXT NOT NULL DEFAULT 'open',
        created_by TEXT, created_at TEXT NOT NULL, closed_by TEXT, closed_at TEXT
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS accounting_accounts (
        code TEXT PRIMARY KEY, name TEXT NOT NULL, account_type TEXT NOT NULL,
        normal_side TEXT NOT NULL, parent_code TEXT, active INTEGER NOT NULL DEFAULT 1,
        system_account INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS accounting_budgets (
        id TEXT PRIMARY KEY, fiscal_year INTEGER NOT NULL, department TEXT NOT NULL DEFAULT '', project TEXT NOT NULL DEFAULT '',
        account_code TEXT NOT NULL, original_amount INTEGER NOT NULL DEFAULT 0,
        supplementary_amount INTEGER NOT NULL DEFAULT 0, transfer_in INTEGER NOT NULL DEFAULT 0,
        transfer_out INTEGER NOT NULL DEFAULT 0, memo TEXT, created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(fiscal_year, department, project, account_code)
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS accounting_resolutions (
        id TEXT PRIMARY KEY, resolution_no TEXT NOT NULL UNIQUE, resolution_type TEXT NOT NULL,
        fiscal_year INTEGER NOT NULL, resolution_date TEXT NOT NULL, title TEXT NOT NULL,
        department TEXT NOT NULL DEFAULT '', project TEXT NOT NULL DEFAULT '', counterparty TEXT NOT NULL DEFAULT '',
        account_code TEXT NOT NULL, settlement_account_code TEXT NOT NULL,
        amount INTEGER NOT NULL, tax_amount INTEGER NOT NULL DEFAULT 0, payment_method TEXT,
        memo TEXT, document_id TEXT UNIQUE, status TEXT NOT NULL DEFAULT 'draft', journal_id TEXT,
        created_by_user_id TEXT NOT NULL, created_by_name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS accounting_journals (
        id TEXT PRIMARY KEY, journal_no TEXT NOT NULL UNIQUE, fiscal_year INTEGER NOT NULL,
        journal_date TEXT NOT NULL, source_type TEXT NOT NULL, source_id TEXT,
        description TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'posted', document_id TEXT,
        reversed_journal_id TEXT, created_by TEXT, approved_by TEXT, created_at TEXT NOT NULL
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS accounting_journal_lines (
        id TEXT PRIMARY KEY, journal_id TEXT NOT NULL, line_no INTEGER NOT NULL,
        account_code TEXT NOT NULL, debit INTEGER NOT NULL DEFAULT 0, credit INTEGER NOT NULL DEFAULT 0,
        department TEXT NOT NULL DEFAULT '', project TEXT NOT NULL DEFAULT '', counterparty TEXT NOT NULL DEFAULT '', memo TEXT,
        UNIQUE(journal_id, line_no)
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS accounting_closings (
        id TEXT PRIMARY KEY, fiscal_year INTEGER NOT NULL, period_month INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'closed', closed_by TEXT NOT NULL, closed_at TEXT NOT NULL,
        memo TEXT, UNIQUE(fiscal_year, period_month)
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS accounting_audit_logs (
        id TEXT PRIMARY KEY, action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT,
        actor_user_id TEXT, actor_name TEXT, detail_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS accounting_sequences (seq_key TEXT PRIMARY KEY, last_seq INTEGER NOT NULL DEFAULT 0)`),
      db.prepare(`CREATE TABLE IF NOT EXISTS accounting_meta (meta_key TEXT PRIMARY KEY, meta_value TEXT NOT NULL, updated_at TEXT NOT NULL)`),
    ]);

    const now = new Date().toISOString();
    const currentYear = new Date(Date.now() + 9 * 60 * 60 * 1000).getUTCFullYear();
    const firstYear = Math.min(2026, currentYear);
    const lastYear = Math.max(2030, currentYear);
    const fiscalYearStatements = Array.from({ length: lastYear - firstYear + 1 }, (_, index) => firstYear + index)
      .map((year) => db.prepare(`INSERT OR IGNORE INTO accounting_fiscal_years (year,name,start_date,end_date,base_currency,status,created_at)
        VALUES (?,?,?,?, 'KRW','open',?)`).bind(year, `${year} 회계연도`, `${year}-01-01`, `${year}-12-31`, now));
    if (fiscalYearStatements.length) await db.batch(fiscalYearStatements);

    const accountStatements = DEFAULT_ACCOUNTS.map(([code,name,type,side,parent,system]) => db.prepare(`
      INSERT OR IGNORE INTO accounting_accounts
      (code,name,account_type,normal_side,parent_code,active,system_account,created_at,updated_at)
      VALUES (?,?,?,?,?,1,?,?,?)
    `).bind(code,name,type,side,parent || null,system,now,now));
    if (accountStatements.length) await db.batch(accountStatements);

    await db.batch([
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_acc_budget_year ON accounting_budgets (fiscal_year, department, account_code)`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_acc_resolution_status ON accounting_resolutions (status, resolution_date DESC)`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_acc_resolution_document ON accounting_resolutions (document_id)`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_acc_journal_date ON accounting_journals (fiscal_year, journal_date DESC)`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_acc_line_account ON accounting_journal_lines (account_code, journal_id)`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_acc_line_department ON accounting_journal_lines (department, project)`),
    ]);
    // D1 bind count differs from normal SQL; keep schema marker separate.
    await db.prepare(`INSERT INTO accounting_meta (meta_key,meta_value,updated_at) VALUES ('schema_version',?,?)
      ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value, updated_at=excluded.updated_at`)
      .bind(ACCOUNTING_SCHEMA_VERSION, now).run();
    await ensureAccountingSpecialTables(db);
    accountingReady = true;
  })().catch((error) => { accountingPromise = null; throw error; });
  await accountingPromise;
};

const nextSequence = async (db: D1Database, key: string) => {
  await db.prepare(`INSERT OR IGNORE INTO accounting_sequences (seq_key,last_seq) VALUES (?,0)`).bind(key).run();
  const row = await db.prepare(`UPDATE accounting_sequences SET last_seq=last_seq+1 WHERE seq_key=? RETURNING last_seq`)
    .bind(key).first<{ last_seq: number }>();
  return Number(row?.last_seq || 1);
};

export const nextAccountingNumber = async (db: D1Database, type: 'resolution-income'|'resolution-expense'|'journal', year: number) => {
  const prefix = type === 'journal' ? '전표' : type === 'resolution-income' ? '수입결의' : '지출결의';
  const seq = await nextSequence(db, `${type}:${year}`);
  return `${prefix}-${year}-${String(seq).padStart(4,'0')}`;
};

export const isPeriodClosed = async (db: D1Database, date: string) => {
  const year = Number(date.slice(0,4));
  const month = Number(date.slice(5,7));
  const row = await db.prepare(`SELECT 1 AS yes FROM accounting_closings WHERE fiscal_year=? AND period_month=? AND status='closed'`)
    .bind(year, month).first<{ yes: number }>();
  return !!row;
};

export const prepareResolutionPosting = async (
  db: D1Database,
  resolution: {
    id: string; resolution_type: string; fiscal_year: number; resolution_date: string; title: string;
    department: string; project: string; counterparty: string; account_code: string;
    settlement_account_code: string; amount: number; document_id: string | null; created_by_name: string;
  },
  approvedBy: string,
) => {
  if (await isPeriodClosed(db, resolution.resolution_date)) throw new Error('해당 회계기간은 마감되어 전표를 생성할 수 없습니다.');
  const existing = await db.prepare(`SELECT id FROM accounting_journals WHERE source_type='resolution' AND source_id=? AND status='posted'`)
    .bind(resolution.id).first<{id:string}>();
  if (existing) return { statements: [] as D1PreparedStatement[], journalId: existing.id, duplicate: true };
  const journalId = `JRN-${randomHex(24)}`;
  const journalNo = await nextAccountingNumber(db, 'journal', resolution.fiscal_year);
  const now = new Date().toISOString();
  const dimensions = await getResolutionDimensions(db, resolution.id);
  const line1Id = `JL-${randomHex(20)}`;
  const line2Id = `JL-${randomHex(20)}`;
  const amount = Math.abs(Number(resolution.amount || 0));
  if (!amount) throw new Error('결의금액이 0원입니다.');
  const isIncome = resolution.resolution_type === 'income';
  const debitAccount = isIncome ? resolution.settlement_account_code : resolution.account_code;
  const creditAccount = isIncome ? resolution.account_code : resolution.settlement_account_code;
  const common = [resolution.department || '', resolution.project || '', resolution.counterparty || '', resolution.title];
  const statements = [
    db.prepare(`INSERT INTO accounting_journals
      (id,journal_no,fiscal_year,journal_date,source_type,source_id,description,status,document_id,created_by,approved_by,created_at)
      VALUES (?,?,?,?, 'resolution',?,?, 'posted',?,?,?,?)`)
      .bind(journalId,journalNo,resolution.fiscal_year,resolution.resolution_date,resolution.id,resolution.title,resolution.document_id,resolution.created_by_name,approvedBy,now),
    db.prepare(`INSERT INTO accounting_journal_lines
      (id,journal_id,line_no,account_code,debit,credit,department,project,counterparty,memo)
      VALUES (?,?,?,?,?,0,?,?,?,?)`)
      .bind(line1Id,journalId,1,debitAccount,amount,...common),
    db.prepare(`INSERT INTO accounting_journal_lines
      (id,journal_id,line_no,account_code,debit,credit,department,project,counterparty,memo)
      VALUES (?,?,?,?,0,?, ?,?,?,?)`)
      .bind(line2Id,journalId,2,creditAccount,amount,...common),
    db.prepare(`INSERT INTO accounting_journal_line_dimensions
      (journal_line_id,book_type_code,entity_id,fund_id,created_at) VALUES (?,?,?,?,?)`)
      .bind(line1Id,dimensions.bookTypeCode,dimensions.entityId,dimensions.fundId,now),
    db.prepare(`INSERT INTO accounting_journal_line_dimensions
      (journal_line_id,book_type_code,entity_id,fund_id,created_at) VALUES (?,?,?,?,?)`)
      .bind(line2Id,dimensions.bookTypeCode,dimensions.entityId,dimensions.fundId,now),
    db.prepare(`UPDATE accounting_resolutions SET status='posted', journal_id=?, updated_at=? WHERE id=?`)
      .bind(journalId,now,resolution.id),
    db.prepare(`INSERT INTO accounting_audit_logs (id,action,entity_type,entity_id,actor_name,detail_json,created_at)
      VALUES (?, 'post','resolution',?,?,?,?)`)
      .bind(`LOG-${randomHex(20)}`,resolution.id,approvedBy,JSON.stringify({journalNo,amount}),now),
  ];
  return { statements, journalId, duplicate: false };
};

export const cleanAccountingText = (value: unknown, max = 200) => clean(value, max);
