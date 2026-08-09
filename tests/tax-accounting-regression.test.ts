import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { unzipSync, strFromU8 } from 'fflate';
import {
  IncrementalSha256,
  csvCell,
  getTaxExportDownload,
  processNextTaxExport,
  queueTaxExport,
  safePersonalIdentifier,
  updateCrc32,
} from '../functions/_shared/accounting-tax-export';
import {
  assertLinkedTaxJournalsReversed,
  fileWithholdingRecord,
  payWithholdingTaxes,
  postVatAdjustmentJournal,
} from '../functions/_shared/accounting-tax-journal';
import { assertAccountingAttachmentRetentionElapsed } from '../functions/_shared/accounting-attachment-ops';
import { calculateVatFromSupply, getTaxValidation } from '../functions/_shared/accounting-tax';

const migrationFiles = () => fs.readdirSync('migrations/accounting')
  .filter((file) => /^00(0[4-9]|1[0-2]).*\.sql$/.test(file)).sort()
  .map((file) => `migrations/accounting/${file}`);

const migrate = (through = '0012') => {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync('database/accounting-base-schema.sql', 'utf8'));
  for (const file of migrationFiles()) {
    if (file.split('/').pop()!.slice(0, 4) > through) break;
    db.exec(fs.readFileSync(file, 'utf8'));
  }
  return db;
};

const asD1 = (db: DatabaseSync) => ({
  prepare(sql: string) {
    const statement = {
      sql,
      values: [] as unknown[],
      bind(...values: unknown[]) { this.values = values; return this; },
    };
    return statement;
  },
  async batch(statements: Array<{ sql: string; values: unknown[] }>) {
    return statements.map((statement) => {
      const row = db.prepare(statement.sql).get(...statement.values);
      return { results: row === undefined ? [] : [row] };
    });
  },
}) as unknown as D1Database;

const insertJournal = (db: DatabaseSync, id: string, sourceType: string, sourceId: string, status = 'posted') => {
  db.prepare(`INSERT INTO accounting_journals
    (id,journal_no,fiscal_year,journal_date,source_type,source_id,description,status,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(id, `전표-${id}`, 2026, '2026-01-15', sourceType, sourceId, id, status, '2026-01-15T00:00:00.000Z');
};

test('fresh schema applies through v64 and contains the restored attachment foundation', () => {
  const v63Migration = fs.readFileSync('migrations/accounting/0011_v63_tax_accounting.sql', 'utf8');
  assert.doesNotMatch(v63Migration, /SELECT\s+CASE\b/i,
    'D1 remote migration compatibility requires trigger guards without SELECT CASE ... END');
  const db = migrate();
  const version = db.prepare(`SELECT meta_value FROM accounting_meta WHERE meta_key='schema_version'`).get() as any;
  assert.equal(version.meta_value, '2026-08-08.2');
  assert.ok(db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='accounting_attachments'`).get());
  const journalColumns = db.prepare(`PRAGMA table_info(accounting_journals)`).all() as any[];
  assert.ok(journalColumns.some((column) => column.name === 'updated_at'));
});

test('production verification SQL executes against the complete accounting schema', () => {
  const db = migrate();
  const verificationSql = fs.readFileSync('database/accounting-production-checks.sql','utf8');
  assert.doesNotMatch(verificationSql, /\bUNION(?:\s+ALL)?\b/i,
    'D1 verification SQL must avoid compound SELECT terms because workerd limits their count');
  assert.doesNotThrow(() => db.exec(verificationSql));
});

test('VAT automatic calculation uses supply amount as the 10 percent tax base', () => {
  assert.deepEqual(calculateVatFromSupply(10_000_000, 'taxable'), {
    supplyAmount: 10_000_000,
    vatAmount: 1_000_000,
    totalAmount: 11_000_000,
  });
  assert.deepEqual(calculateVatFromSupply(10_000_000, 'exempt'), {
    supplyAmount: 10_000_000,
    vatAmount: 0,
    totalAmount: 10_000_000,
  });
});

test('tax page boot does not collide with built-in HTML form properties', () => {
  const source = fs.readFileSync('src/pages/accounting-tax.astro', 'utf8');
  assert.match(source, /elements\.namedItem\(name\)/,
    'form fields named id or name must be resolved through the form controls collection');
  assert.doesNotMatch(source, /\bf\.(?:id|name)\.value\b/,
    'HTMLFormElement.id and HTMLFormElement.name must not be treated as input controls');
  assert.match(source, /catch\(error\)\{\$\('\[data-app\]'\)\.hidden=false;/,
    'initialization failures must reveal the page before showing an error notice');
});

test('runtime tax validation avoids D1 compound selects and executes on the complete schema', async () => {
  const source = fs.readFileSync('functions/_shared/accounting-tax.ts', 'utf8');
  assert.doesNotMatch(source, /\bUNION(?:\s+ALL)?\b/i,
    'runtime tax validation must not use compound SELECT terms on D1');
  const database = migrate();
  const allEntities = await getTaxValidation(asD1(database), 2026);
  const headquarters = await getTaxValidation(asD1(database), 2026, 'ENTITY-HQ');
  assert.ok(Array.isArray(allEntities));
  assert.ok(Array.isArray(headquarters));
  assert.equal(allEntities.some((item) => item.code === 'TAX_PROFILE_UNCONFIRMED'), false,
    'an empty accounting year must not report a tax-profile error before there is activity');
  assert.equal(headquarters.some((item) => item.code === 'TAX_PROFILE_UNCONFIRMED'), false,
    'an empty scoped entity must not report a tax-profile error before there is activity');
  assert.equal(headquarters.some((item) => item.code === 'PERIOD_NOT_CLOSED'), false,
    'months without accounting activity must not produce a closing warning');
});

test('site-wide date inputs accept eight typed digits without breaking native segment editing', () => {
  const helper = fs.readFileSync('public/milgyo-date-input.js', 'utf8');
  const layout = fs.readFileSync('src/layouts/GovLayout.astro', 'utf8');
  assert.match(layout, /src="\/milgyo-date-input\.js"/);
  assert.match(helper, /input\.value = value/);
  assert.match(helper, /\^\\d\{8\}\$/);
  assert.match(helper, /clipboardData/);
  assert.match(helper, /nativeDateEdit/,
    'existing dates must stay in the browser native year/month/day editing mode for the full focus session');
  assert.match(helper, /if \(input\.dataset\.nativeDateEdit === '1'\) return/);
});

test('tax date controls keep inline weekday boxes and only mask native date text during an eight-digit draft', () => {
  const source = fs.readFileSync('src/pages/accounting-tax.astro', 'utf8');
  const helper = fs.readFileSync('public/milgyo-date-input.js', 'utf8');
  assert.match(source, /className='date-weekday'/);
  assert.match(source, /grid-template-columns:minmax\(0,1fr\) auto/);
  assert.match(source, /background:#eaf2fb/);
  assert.match(source, /data-numeric-date-drafting="1"/);
  assert.match(helper, /className = 'date-input-shell'/);
  assert.match(helper, /className = 'date-display-value'/);
});

test('withholding month fields are freely editable text and normalize six digits on blur or submit', () => {
  const source = fs.readFileSync('src/pages/accounting-tax.astro', 'utf8');
  assert.match(source, /name="filingMonth" type="text"[^>]*data-month-input/);
  assert.match(source, /data-withholding-month type="text"[^>]*data-month-input/);
  assert.match(source, /const normalizeMonthValue=/);
  assert.match(source, /\^\\d\{6\}\$/);
});

test('withholding uses religious-order practical defaults while preserving direct manual editing', () => {
  const source = fs.readFileSync('src/pages/accounting-tax.astro', 'utf8');
  const action = fs.readFileSync('functions/api/accounting-tax/action.ts', 'utf8');
  assert.match(source, /name="autoNecessaryExpense"/);
  assert.match(source, /name="autoWithholdingTax"/);
  assert.match(source, /value="reimbursement"/);
  assert.match(action, /'reimbursement'/);
  assert.match(source, /Math\.floor\(base\*\.60\)/,
    'ordinary one-off advisory and lecture other income should default to the common 60 percent expense treatment');
  assert.match(source, /Math\.floor\(taxable\*\.20\)/,
    'with a 60 percent expense default, ordinary other income produces an 8 percent national withholding rate on gross payment');
  assert.match(source, /Math\.floor\(base\*\.03\)/,
    'continuous independent personal-service business income should default to 3 percent national withholding');
  assert.match(source, /type==='nonresident'/);
  assert.match(source, /Math\.floor\(base\*\.20\)/,
    'nonresident personal service uses 20 percent as the practical no-treaty default while allowing manual override');
  assert.match(source, /type==='reimbursement'/);
  assert.match(source, /incomeTax:0,localTax:0/);
  assert.match(source, /f\.incomeTax\.readOnly=false;f\.localIncomeTax\.readOnly=false/,
    'auto suggestions must remain directly editable and manual typing turns automatic calculation off');
  assert.match(source, /정기 직책수당은 근로소득/);
  assert.match(source, /실제 비용 보전임이 확인되는 금액만 실비변상·비과세/);
});

test('withholding payment-date label stays on one line', () => {
  const source = fs.readFileSync('src/pages/accounting-tax.astro', 'utf8');
  assert.match(source, /tax-payment-date-label/);
  assert.match(source, /tax-payment-date-label\{white-space:nowrap\}/);
});

test('tax UI keeps navigation, profile notes, payee search, tables and package guidance consistent', () => {
  const source = fs.readFileSync('src/pages/accounting-tax.astro', 'utf8');
  assert.match(source, /class="check-stack span-2 profile-checks"/);
  assert.match(source, /확정본 변경 사유<\/label>|확정본 변경 사유<textarea/);
  assert.match(source, /payee-list-head/);
  assert.match(source, /세무사 전달용 자료 안내/);
  assert.match(source, /:global\(\.tax-app \.table-wrap th\).*text-align:center!important/);
  assert.match(source, /\.nav\{[^}]*font-family:inherit[^}]*font-size:\.9rem/);
});

test('accounting navigation removes reload-like entries and keeps long labels on one line', () => {
  const source = fs.readFileSync('src/pages/accounting.astro', 'utf8');
  assert.doesNotMatch(source, />회계 실무관리<\/a>/);
  assert.match(source, /<span data-user-label><\/span>\s*<a href="\/" class="btn btn-outline">전자문서<\/a>/);
  assert.match(source, /\.acc-special-link\{[^}]*white-space:nowrap/);
});

test('v64 repairs only unambiguous v63 account migrations and leaves ambiguous rows for review', () => {
  const db = migrate('0011');
  const insertResolution = db.prepare(`INSERT INTO accounting_resolutions
    (id,resolution_no,resolution_type,fiscal_year,resolution_date,title,account_code,settlement_account_code,amount,
     payment_method,status,created_by_user_id,created_by_name,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  insertResolution.run('R-BANK','R-BANK','expense',2026,'2026-01-10','bank','5300','2110',1000,'계좌이체','posted','u','u','2026-01-10','2026-01-10');
  insertResolution.run('R-OTHER','R-OTHER','expense',2026,'2026-01-10','other','5300','2110',1000,'기타','draft','u','u','2026-01-10','2026-01-10');
  insertJournal(db,'J-BANK','resolution','R-BANK');
  db.prepare(`INSERT INTO accounting_journal_lines
    (id,journal_id,line_no,account_code,debit,credit) VALUES ('JL-B1','J-BANK',1,'5300',1000,0),('JL-B2','J-BANK',2,'2110',0,1000)`).run();
  db.prepare(`INSERT INTO accounting_journal_line_dimensions
    (journal_line_id,book_type_code,entity_id,fund_id,created_at) VALUES
    ('JL-B1','general','ENTITY-HQ','','2026-01-10'),('JL-B2','general','ENTITY-HQ','','2026-01-10')`).run();
  db.prepare(`INSERT INTO accounting_monthly_summary
    (fiscal_year,period_month,book_type_code,entity_id,fund_id,account_code,department,project,debit_total,credit_total,updated_at)
    VALUES (2026,1,'general','ENTITY-HQ','','5300','','',9999,0,'2026-01-10')`).run();
  db.exec(fs.readFileSync('migrations/accounting/0012_v64_tax_accounting_hardening.sql','utf8'));
  assert.equal((db.prepare(`SELECT settlement_account_code FROM accounting_resolutions WHERE id='R-BANK'`).get() as any).settlement_account_code,'1120');
  assert.equal((db.prepare(`SELECT account_code FROM accounting_journal_lines WHERE id='JL-B2'`).get() as any).account_code,'1120');
  assert.equal((db.prepare(`SELECT settlement_account_code FROM accounting_resolutions WHERE id='R-OTHER'`).get() as any).settlement_account_code,'2110');
  assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM accounting_v63_migration_review WHERE entity_id='R-OTHER' AND status='open'`).get() as any).count,1);
  const summary = db.prepare(`SELECT debit_total FROM accounting_monthly_summary WHERE account_code='5300'`).get() as any;
  assert.equal(summary.debit_total,1000);
});

test('database guards prevent duplicate source journals and immutable card links', () => {
  const db = migrate();
  insertJournal(db,'J-1','card','CARD-TX-1');
  assert.throws(() => insertJournal(db,'J-2','card','CARD-TX-1'),/duplicate posted journal source/);
  db.prepare(`INSERT INTO accounting_cards
    (id,card_code,card_label,settlement_account_code,created_at,updated_at)
    VALUES ('C-1','C-1','card','2110','2026-01-01','2026-01-01')`).run();
  db.prepare(`INSERT INTO accounting_card_transactions
    (id,transaction_no,card_id,transaction_date,merchant,amount,account_code,status,journal_id,created_at,updated_at)
    VALUES ('T-1','T-1','C-1','2026-01-15','merchant',1000,'5300','posted','J-1','2026-01-15','2026-01-15')`).run();
  insertJournal(db,'J-3','manual','MANUAL-3');
  insertJournal(db,'J-4','manual','MANUAL-4');
  insertJournal(db,'J-5','manual','MANUAL-5');
  insertJournal(db,'J-6','manual','MANUAL-6');
  insertJournal(db,'J-7','manual','MANUAL-7');
  const insertCardPayment = db.prepare(`INSERT INTO accounting_card_payments
    (id,payment_no,fiscal_year,card_id,payment_date,amount,payable_account_code,bank_account_code,journal_id,created_by,created_at,request_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  assert.throws(() => insertCardPayment.run('CP-BAD-AMOUNT','CP-BAD-AMOUNT',2026,'C-1','2026-01-20',0,'2110','1120','J-4','tester','2026-01-20','REQ-CP-BAD-AMOUNT'),/card payment amount must be positive/);
  assert.throws(() => insertCardPayment.run('CP-BAD-PAYABLE','CP-BAD-PAYABLE',2026,'C-1','2026-01-20',100,'1120','1120','J-5','tester','2026-01-20','REQ-CP-BAD-PAYABLE'),/card payable account must be active liability credit/);
  assert.throws(() => insertCardPayment.run('CP-BAD-BANK','CP-BAD-BANK',2026,'C-1','2026-01-20',100,'2110','2110','J-6','tester','2026-01-20','REQ-CP-BAD-BANK'),/card bank account must be active cash asset debit/);
  assert.throws(() => insertCardPayment.run('CP-TOO-LARGE','CP-TOO-LARGE',2026,'C-1','2026-01-20',1001,'2110','1120','J-7','tester','2026-01-20','REQ-CP-TOO-LARGE'),/card payment exceeds outstanding amount/);
  assert.throws(() => db.prepare(`UPDATE accounting_card_transactions SET journal_id='J-3' WHERE id='T-1'`).run(),/immutable or duplicated/);
  db.prepare(`INSERT INTO accounting_card_payments
    (id,payment_no,fiscal_year,card_id,payment_date,amount,payable_account_code,bank_account_code,journal_id,created_by,created_at,request_id)
    VALUES ('CP-1','CP-1',2026,'C-1','2026-01-20',100,'2110','1120','J-3','tester','2026-01-20','REQ-CP-1')`).run();
  assert.throws(() => db.prepare(`UPDATE accounting_card_payments SET memo='rewrite' WHERE id='CP-1'`).run(),/posted card payment is immutable/);
  assert.throws(() => db.prepare(`DELETE FROM accounting_card_payments WHERE id='CP-1'`).run(),/posted card payment cannot be deleted/);
});

test('confirmed tax profiles require a reasoned revision and preserve prior snapshots', () => {
  const db=migrate();
  db.prepare(`INSERT INTO accounting_tax_profiles
    (id,fiscal_year,entity_id,legal_name,registration_no,qualified_donation_status,vat_business_type,vat_reporting_cycle,
     religious_income_method,profile_status,confirmed_by,confirmed_at,created_by,created_at,updated_by,updated_at)
    VALUES ('PROFILE-1',2026,'ENTITY-HQ','원 법인명','101-00-00001','not_qualified','not_applicable','not_applicable',
      'not_applicable','confirmed','tester','2026-01-01','tester','2026-01-01','tester','2026-01-01')`).run();
  assert.throws(() => db.prepare(`UPDATE accounting_tax_profiles SET legal_name='무단 변경' WHERE id='PROFILE-1'`).run(),/explicit revision/);
  db.prepare(`UPDATE accounting_tax_profiles SET legal_name='개정 법인명',revision_no=2,change_reason='법인명 변경',updated_by='tester',updated_at='2026-02-01'
    WHERE id='PROFILE-1'`).run();
  const revision=db.prepare(`SELECT revision_no,snapshot_json,change_reason FROM accounting_tax_profile_revisions WHERE profile_id='PROFILE-1'`).get() as any;
  assert.equal(revision.revision_no,1);
  assert.match(revision.snapshot_json,/원 법인명/);
  assert.equal(revision.change_reason,'법인명 변경');
  assert.throws(() => db.prepare(`DELETE FROM accounting_tax_profiles WHERE id='PROFILE-1'`).run(),/cannot be deleted/);
});

test('journal line and dimension edits advance the journal snapshot fence', () => {
  const db=migrate();
  insertJournal(db,'J-SNAPSHOT','manual','SNAPSHOT-SOURCE');
  db.prepare(`INSERT INTO accounting_journal_lines
    (id,journal_id,line_no,account_code,debit,credit) VALUES ('JL-SNAPSHOT','J-SNAPSHOT',1,'1120',100,0)`).run();
  db.prepare(`INSERT INTO accounting_journal_line_dimensions
    (journal_line_id,book_type_code,entity_id,fund_id,created_at) VALUES ('JL-SNAPSHOT','general','ENTITY-HQ','','2026-01-15')`).run();
  db.prepare(`UPDATE accounting_journals SET updated_at='2000-01-01T00:00:00.000Z' WHERE id='J-SNAPSHOT'`).run();
  db.prepare(`UPDATE accounting_journal_lines SET debit=101 WHERE id='JL-SNAPSHOT'`).run();
  const lineTouch=(db.prepare(`SELECT updated_at FROM accounting_journals WHERE id='J-SNAPSHOT'`).get() as any).updated_at;
  assert.match(lineTouch,/^\d{4}-\d{2}-\d{2}T/);
  db.prepare(`UPDATE accounting_journals SET updated_at='2000-01-01T00:00:00.000Z' WHERE id='J-SNAPSHOT'`).run();
  db.prepare(`UPDATE accounting_journal_line_dimensions SET entity_id='ENTITY-HQ' WHERE journal_line_id='JL-SNAPSHOT'`).run();
  const dimensionTouch=(db.prepare(`SELECT updated_at FROM accounting_journals WHERE id='J-SNAPSHOT'`).get() as any).updated_at;
  assert.match(dimensionTouch,/^\d{4}-\d{2}-\d{2}T/);
});

test('confirmed VAT is immutable, cancellable only with reason, and replaceable on the same source line', () => {
  const db = migrate();
  const insert = db.prepare(`INSERT INTO accounting_vat_records
    (id,fiscal_year,transaction_date,direction,source_type,source_id,book_type_code,entity_id,fund_id,counterparty_name,
     evidence_type,total_amount,supply_amount,vat_amount,tax_type,deduction_status,filing_period,status,confirmed_by,confirmed_at,
     created_by,created_at,updated_by,updated_at,source_line_no,supersedes_id,version_no)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  insert.run('VAT-1',2026,'2026-02-01','purchase','resolution','R-1','general','ENTITY-HQ','','vendor','tax_invoice',1100,1000,100,'taxable','deductible','2026-Q1','confirmed','u','2026-02-01','u','2026-02-01','u','2026-02-01',1,null,1);
  assert.throws(() => db.prepare(`UPDATE accounting_vat_records SET vat_amount=90,supply_amount=1010 WHERE id='VAT-1'`).run(),/confirmed vat record is immutable/);
  assert.throws(() => db.prepare(`UPDATE accounting_vat_records SET status='cancelled' WHERE id='VAT-1'`).run(),/cancellation reason/);
  db.prepare(`UPDATE accounting_vat_records SET status='cancelled',cancellation_reason='오입력',cancelled_by='u',cancelled_at='2026-02-02' WHERE id='VAT-1'`).run();
  assert.throws(() => db.prepare(`UPDATE accounting_vat_records SET memo='change' WHERE id='VAT-1'`).run(),/cancelled vat record is immutable/);
  assert.throws(() => db.prepare(`DELETE FROM accounting_vat_records WHERE id='VAT-1'`).run(),/cannot be deleted/);
  insert.run('VAT-2',2026,'2026-02-01','purchase','resolution','R-1','general','ENTITY-HQ','','vendor','tax_invoice',1100,1000,100,'taxable','deductible','2026-Q1','confirmed','u','2026-02-02','u','2026-02-02','u','2026-02-02',1,'VAT-1',2);
  assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM accounting_vat_records WHERE source_id='R-1' AND status='confirmed'`).get() as any).count,1);
  db.prepare(`UPDATE accounting_vat_records SET status='cancelled',cancellation_reason='재정정',cancelled_by='u',cancelled_at='2026-02-03' WHERE id='VAT-2'`).run();
  assert.throws(() => insert.run('VAT-BAD',2026,'2026-02-01','purchase','resolution','R-1','general','ENTITY-HQ','','vendor','tax_invoice',1100,1000,100,'taxable','deductible','2026-Q1','confirmed','u','2026-02-03','u','2026-02-03','u','2026-02-03',2,'VAT-2',3),/invalid vat correction lineage/);
  assert.throws(() => insert.run('VAT-3',2026,'2026-02-01','purchase','resolution','R-1','general','ENTITY-HQ','','vendor','tax_invoice',1100,1000,100,'taxable','deductible','2026-Q1','confirmed','u','2026-02-03','u','2026-02-03','u','2026-02-03',1,'VAT-1',2),/UNIQUE/);
});

test('withholding states move forward and filed values cannot be rewritten', () => {
  const db = migrate();
  db.prepare(`INSERT INTO accounting_tax_payees
    (id,payee_no,payee_type,name,resident_status,active,created_by,created_at,updated_by,updated_at)
    VALUES ('P-1','P-1','employee','payee','resident',1,'u','2026-01-01','u','2026-01-01')`).run();
  db.prepare(`INSERT INTO accounting_withholding_records
    (id,payment_no,fiscal_year,payment_date,payee_id,income_type,religious_income_method,book_type_code,entity_id,fund_id,
     gross_amount,tax_exempt_amount,necessary_expense,taxable_amount,income_tax,local_income_tax,other_deduction,net_amount,
     filing_month,filing_status,created_by,created_at,updated_by,updated_at)
    VALUES ('W-1','W-1',2026,'2026-03-01','P-1','earned','not_applicable','general','ENTITY-HQ','',1000,0,0,1000,0,0,0,1000,'2026-03','unfiled','u','2026-03-01','u','2026-03-01')`).run();
  db.prepare(`UPDATE accounting_withholding_records SET filing_status='filed',filed_at='2026-03-10' WHERE id='W-1'`).run();
  assert.throws(() => db.prepare(`UPDATE accounting_withholding_records SET gross_amount=900,net_amount=900 WHERE id='W-1'`).run(),/filed withholding record is immutable/);
  assert.throws(() => db.prepare(`UPDATE accounting_withholding_records SET filing_status='unfiled' WHERE id='W-1'`).run(),/filed withholding record is immutable/);
  db.prepare(`UPDATE accounting_withholding_records SET filing_status='paid',paid_at='2026-03-10' WHERE id='W-1'`).run();
  assert.throws(() => db.prepare(`UPDATE accounting_withholding_records SET paid_at='2026-03-11' WHERE id='W-1'`).run(),/paid withholding metadata is immutable/);
  assert.throws(() => db.prepare(`DELETE FROM accounting_withholding_records WHERE id='W-1'`).run(),/cannot be deleted/);
  db.prepare(`UPDATE accounting_withholding_records
    SET filing_status='cancelled',cancellation_reason='지급정보 정정',cancelled_by='u',cancelled_at='2026-03-11'
    WHERE id='W-1'`).run();
  assert.throws(() => db.prepare(`INSERT INTO accounting_withholding_records
    (id,payment_no,fiscal_year,payment_date,payee_id,income_type,religious_income_method,book_type_code,entity_id,fund_id,
     gross_amount,tax_exempt_amount,necessary_expense,taxable_amount,income_tax,local_income_tax,other_deduction,net_amount,
     filing_month,filing_status,created_by,created_at,updated_by,updated_at,supersedes_id,version_no)
    VALUES ('W-BAD','W-BAD',2026,'2026-03-01','P-1','earned','not_applicable','general','ENTITY-BRANCH','',
      1000,0,0,1000,0,0,0,1000,'2026-03','unfiled','u','2026-03-11','u','2026-03-11','W-1',2)`).run(),/invalid withholding correction lineage/);
  db.prepare(`INSERT INTO accounting_withholding_records
    (id,payment_no,fiscal_year,payment_date,payee_id,income_type,religious_income_method,book_type_code,entity_id,fund_id,
     gross_amount,tax_exempt_amount,necessary_expense,taxable_amount,income_tax,local_income_tax,other_deduction,net_amount,
     filing_month,filing_status,created_by,created_at,updated_by,updated_at,supersedes_id,version_no)
    VALUES ('W-2','W-2',2026,'2026-03-01','P-1','earned','not_applicable','general','ENTITY-HQ','',
      1000,0,0,1000,0,0,0,1000,'2026-03','unfiled','u','2026-03-11','u','2026-03-11','W-1',2)`).run();
  assert.equal((db.prepare(`SELECT supersedes_id,version_no FROM accounting_withholding_records WHERE id='W-2'`).get() as any).version_no,2);
});

test('streaming hash, CRC32, masking, and CSV formula defense are deterministic', async () => {
  const bytes = new TextEncoder().encode('abc');
  assert.equal(new IncrementalSha256().update(bytes.subarray(0,1)).update(bytes.subarray(1)).digestHex(),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(updateCrc32(0,bytes),0x352441c2);
  assert.equal(csvCell('=HYPERLINK("x")'),'"\'=HYPERLINK(""x"")"');
  assert.equal(safePersonalIdentifier('900101-1234567'),'900101-1******');
});

test('attachment originals cannot be deleted before their retention deadline', () => {
  assert.throws(
    () => assertAccountingAttachmentRetentionElapsed('2036-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z'),
    /보존기한.*전에는 원본을 삭제할 수 없습니다/,
  );
  assert.throws(
    () => assertAccountingAttachmentRetentionElapsed(null,'2026-01-01T00:00:00.000Z'),
    /보존기한을 확인할 수 없어/,
  );
  assert.equal(
    assertAccountingAttachmentRetentionElapsed('2025-12-31T00:00:00.000Z','2026-01-01T00:00:00.000Z'),
    '2025-12-31T00:00:00.000Z',
  );
});

class D1StatementAdapter {
  values: unknown[] = [];
  constructor(private db: DatabaseSync, private sql: string) {}
  bind(...values: unknown[]) { this.values=values;return this; }
  async all<T>() { return {results:this.db.prepare(this.sql).all(...this.values) as T[],success:true}; }
  async first<T>() { return (this.db.prepare(this.sql).get(...this.values) as T) || null; }
  async run() { return this.db.prepare(this.sql).run(...this.values); }
  async batchResult() { return this.all(); }
}

class D1Adapter {
  constructor(private db: DatabaseSync) {}
  prepare(sql: string) { return new D1StatementAdapter(this.db,sql) as any; }
  async batch(statements: D1StatementAdapter[]) {
    const results=[];
    for(const statement of statements) results.push(await statement.batchResult());
    return results;
  }
}

class MemoryR2 {
  objects = new Map<string,Uint8Array>();
  async put(key:string,value:any) {
    let bytes:Uint8Array;
    if(value instanceof ReadableStream){const chunks:Uint8Array[]=[];let size=0;const reader=value.getReader();while(true){const part=await reader.read();if(part.done)break;if(part.value){chunks.push(part.value);size+=part.value.byteLength}}bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength}}
    else if(typeof value==='string')bytes=new TextEncoder().encode(value);else bytes=value instanceof Uint8Array?value:new Uint8Array(value.buffer||value);
    this.objects.set(key,bytes);return {key,size:bytes.byteLength,etag:`etag-${bytes.byteLength}`};
  }
  async get(key:string){const bytes=this.objects.get(key);if(!bytes)return null;return {body:new ReadableStream<Uint8Array>({start(controller){controller.enqueue(bytes);controller.close()}}),arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),text:async()=>new TextDecoder().decode(bytes),size:bytes.byteLength,etag:`etag-${bytes.byteLength}`};}
  async delete(key:string|string[]){for(const item of Array.isArray(key)?key:[key])this.objects.delete(item);}
}

test('VAT and withholding actions create balanced ledger journals and monthly summaries', async () => {
  const sqlite=migrate();
  const db=new D1Adapter(sqlite) as any;
  const actor={id:'U-1',name:'tester'};
  const insertResolution=sqlite.prepare(`INSERT INTO accounting_resolutions
    (id,resolution_no,resolution_type,fiscal_year,resolution_date,title,counterparty,account_code,settlement_account_code,amount,
     payment_method,status,journal_id,created_by_user_id,created_by_name,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  insertResolution.run('R-VAT','R-VAT','expense',2026,'2026-02-01','VAT purchase','vendor','5300','1120',1100,'계좌이체','posted','J-VAT','U-1','tester','2026-02-01','2026-02-01');
  insertJournal(sqlite,'J-VAT','resolution','R-VAT');
  sqlite.prepare(`INSERT INTO accounting_journal_lines
    (id,journal_id,line_no,account_code,debit,credit,department,project,counterparty)
    VALUES ('JL-V1','J-VAT',1,'5300',1100,0,'재정','','vendor'),('JL-V2','J-VAT',2,'1120',0,1100,'재정','','vendor')`).run();
  sqlite.prepare(`INSERT INTO accounting_journal_line_dimensions
    (journal_line_id,book_type_code,entity_id,fund_id,created_at)
    VALUES ('JL-V1','general','ENTITY-HQ','','2026-02-01'),('JL-V2','general','ENTITY-HQ','','2026-02-01')`).run();
  sqlite.prepare(`INSERT INTO accounting_vat_records
    (id,fiscal_year,transaction_date,direction,source_type,source_id,book_type_code,entity_id,fund_id,counterparty_name,
     evidence_type,total_amount,supply_amount,vat_amount,tax_type,deduction_status,filing_period,status,confirmed_by,confirmed_at,
     created_by,created_at,updated_by,updated_at,source_line_no,version_no)
    VALUES ('VAT-A',2026,'2026-02-01','purchase','resolution','R-VAT','general','ENTITY-HQ','','vendor','tax_invoice',1100,1000,100,
      'taxable','deductible','2026-Q1','confirmed','tester','2026-02-01','tester','2026-02-01','tester','2026-02-01',1,1)`).run();
  const vatPosted=await postVatAdjustmentJournal(db,'VAT-A','',actor,'2026-02-02T00:00:00.000Z');
  assert.ok(vatPosted.journalNo);
  const vatLines=sqlite.prepare(`SELECT account_code,debit,credit FROM accounting_journal_lines WHERE journal_id=? ORDER BY line_no`).all(vatPosted.journalId) as any[];
  assert.deepEqual(vatLines.map((line)=>[line.account_code,line.debit,line.credit]),[['1140',100,0],['5300',0,100]]);
  assert.equal((sqlite.prepare(`SELECT adjustment_journal_id FROM accounting_vat_records WHERE id='VAT-A'`).get() as any).adjustment_journal_id,vatPosted.journalId);
  await assert.rejects(()=>assertLinkedTaxJournalsReversed(db,[vatPosted.journalId]),/먼저 역분개/);

  insertResolution.run('R-W','R-W','expense',2026,'2026-03-01','payee gross','payee','5100','1120',1000,'계좌이체','posted','J-W','U-1','tester','2026-03-01','2026-03-01');
  insertJournal(sqlite,'J-W','resolution','R-W');
  sqlite.prepare(`INSERT INTO accounting_journal_lines
    (id,journal_id,line_no,account_code,debit,credit,counterparty)
    VALUES ('JL-W1','J-W',1,'5100',1000,0,'payee'),('JL-W2','J-W',2,'1120',0,1000,'payee')`).run();
  sqlite.prepare(`INSERT INTO accounting_journal_line_dimensions
    (journal_line_id,book_type_code,entity_id,fund_id,created_at)
    VALUES ('JL-W1','general','ENTITY-HQ','','2026-03-01'),('JL-W2','general','ENTITY-HQ','','2026-03-01')`).run();
  sqlite.prepare(`INSERT INTO accounting_tax_payees
    (id,payee_no,payee_type,name,resident_status,active,created_by,created_at,updated_by,updated_at)
    VALUES ('PAYEE-A','PAYEE-A','employee','payee','resident',1,'tester','2026-01-01','tester','2026-01-01')`).run();
  sqlite.prepare(`INSERT INTO accounting_withholding_records
    (id,payment_no,fiscal_year,payment_date,payee_id,income_type,religious_income_method,source_resolution_id,
     book_type_code,entity_id,fund_id,gross_amount,tax_exempt_amount,necessary_expense,taxable_amount,income_tax,
     local_income_tax,other_deduction,net_amount,filing_month,filing_status,created_by,created_at,updated_by,updated_at)
    VALUES ('W-A','W-A',2026,'2026-03-01','PAYEE-A','earned','not_applicable','R-W','general','ENTITY-HQ','',1000,0,0,1000,
      30,3,10,957,'2026-03','unfiled','tester','2026-03-01','tester','2026-03-01')`).run();
  const filed=await fileWithholdingRecord(db,'W-A','',actor,'2026-03-10T00:00:00.000Z');
  assert.ok(filed.journalNo);
  const accrual=sqlite.prepare(`SELECT account_code,debit,credit FROM accounting_journal_lines WHERE journal_id=? ORDER BY line_no`).all(filed.journalId) as any[];
  assert.deepEqual(accrual.map((line)=>[line.account_code,line.debit,line.credit]),[['1120',43,0],['2220',0,30],['2230',0,3],['2240',0,10]]);
  const paid=await payWithholdingTaxes(db,'W-A','2026-04-10','1120',actor,'2026-04-10T00:00:00.000Z');
  assert.ok(paid.journalNo);
  const payment=sqlite.prepare(`SELECT account_code,debit,credit FROM accounting_journal_lines WHERE journal_id=? ORDER BY line_no`).all(paid.journalId) as any[];
  assert.deepEqual(payment.map((line)=>[line.account_code,line.debit,line.credit]),[['2220',30,0],['2230',3,0],['1120',0,33]]);
  const withholding=sqlite.prepare(`SELECT filing_status,accrual_journal_id,payment_journal_id FROM accounting_withholding_records WHERE id='W-A'`).get() as any;
  assert.equal(withholding.filing_status,'paid');
  assert.equal(withholding.accrual_journal_id,filed.journalId);
  assert.equal(withholding.payment_journal_id,paid.journalId);
  const unbalanced=sqlite.prepare(`SELECT COUNT(*) AS count FROM (
    SELECT j.id FROM accounting_journals j JOIN accounting_journal_lines l ON l.journal_id=j.id
    WHERE j.source_type IN ('vat-adjustment','withholding-accrual','withholding-payment') GROUP BY j.id HAVING SUM(l.debit)<>SUM(l.credit))`).get() as any;
  assert.equal(unbalanced.count,0);
});

test('async tax export streams every dataset, persists a ZIP, and supports repeat download', async () => {
  const sqlite=migrate();
  const db=new D1Adapter(sqlite) as any;
  const bucket=new MemoryR2() as any;
  await assert.rejects(
    () => queueTaxExport(db,{year:2026,periodStart:'2026-01-01',periodEnd:'2026-12-31',bookTypeCode:'general',entityId:'ENTITY-HQ',fundId:'',allowValidationErrors:true,requestId:'REQ-BLOCKED'},{id:'U-1',name:'tester'}),
    /자동검증 오류 1개를 모두 해결/,
  );
  sqlite.prepare(`INSERT INTO accounting_entities
    (id,entity_code,name,entity_type,created_at,updated_at) VALUES
    ('ENTITY-A','ENTITY-A','A 조직','temple','2026-01-01','2026-01-01'),
    ('ENTITY-B','ENTITY-B','B 조직','temple','2026-01-01','2026-01-01')`).run();
  sqlite.prepare(`INSERT INTO accounting_tax_profiles
    (id,fiscal_year,entity_id,legal_name,registration_no,qualified_donation_status,vat_business_type,vat_reporting_cycle,
     religious_income_method,profile_status,confirmed_by,confirmed_at,created_by,created_at,updated_by,updated_at)
    VALUES ('PROFILE-A',2026,'ENTITY-A','A 조직','101-00-00001','not_qualified','not_applicable','not_applicable',
      'not_applicable','confirmed','tester','2026-01-01','tester','2026-01-01','tester','2026-01-01')`).run();
  sqlite.prepare(`INSERT INTO accounting_vendors
    (id,vendor_code,name,created_by,created_at,updated_at) VALUES
    ('VENDOR-A','V-A','A 거래처','tester','2026-01-01','2026-01-01'),
    ('VENDOR-B','V-B','B 거래처','tester','2026-01-01','2026-01-01')`).run();
  const resolution=sqlite.prepare(`INSERT INTO accounting_resolutions
    (id,resolution_no,resolution_type,fiscal_year,resolution_date,title,account_code,settlement_account_code,amount,
     payment_method,status,vendor_id,created_by_user_id,created_by_name,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  resolution.run('RES-A','RES-A','expense',2026,'2026-02-01','A 결의','5300','1120',1000,'계좌이체','draft','VENDOR-A','U-1','tester','2026-02-01','2026-02-01');
  resolution.run('RES-B','RES-B','expense',2026,'2026-02-01','B 결의','5300','1120',1000,'계좌이체','draft','VENDOR-B','U-1','tester','2026-02-01','2026-02-01');
  sqlite.prepare(`INSERT INTO accounting_resolution_dimensions
    (resolution_id,book_type_code,entity_id,fund_id,created_at,updated_at) VALUES
    ('RES-A','general','ENTITY-A','','2026-02-01','2026-02-01'),
    ('RES-B','general','ENTITY-B','','2026-02-01','2026-02-01')`).run();
  sqlite.prepare(`INSERT INTO accounting_attachments
    (reference_type,reference_id,original_filename,stored_filename,object_key,size_bytes,uploaded_by,uploaded_at,retention_until)
    VALUES
    ('resolution','RES-A','A-증빙.pdf','a.pdf','accounting/2026/a.pdf',10,'tester','2026-02-01','2036-02-01'),
    ('resolution','RES-B','B-증빙.pdf','b.pdf','accounting/2026/b.pdf',10,'tester','2026-02-01','2036-02-01')`).run();
  const pagedVat=sqlite.prepare(`INSERT INTO accounting_vat_records
    (id,fiscal_year,transaction_date,direction,source_type,source_id,book_type_code,entity_id,fund_id,counterparty_name,
     evidence_type,total_amount,supply_amount,vat_amount,tax_type,deduction_status,filing_period,status,
     created_by,created_at,updated_by,updated_at,source_line_no,version_no)
    VALUES (?,2026,'2026-02-15','purchase','manual','','general','ENTITY-A','','페이지 검증','tax_invoice',1100,1000,100,
      'taxable','pending','2026-Q1','draft','tester','2026-02-15','tester','2026-02-15',1,1)`);
  sqlite.exec('BEGIN');
  for(let index=0;index<505;index+=1)pagedVat.run(`VAT-PAGE-${String(index).padStart(4,'0')}`);
  sqlite.exec('COMMIT');
  const queued=await queueTaxExport(db,{year:2026,periodStart:'2026-01-01',periodEnd:'2026-12-31',bookTypeCode:'general',entityId:'ENTITY-A',fundId:'',allowValidationErrors:false,requestId:'REQ-1'},{id:'U-1',name:'tester'});
  assert.equal(queued.status,'queued');
  let status:any;
  for(let step=0;step<30;step+=1){status=await processNextTaxExport(db,bucket,queued.id);if(status.status==='ready'||status.status==='failed')break;}
  assert.equal(status.status,'ready',status.message||status.errorMessage);
  assert.equal(status.progressCurrent,status.progressTotal);
  assert.match(status.packageSha256,/^[a-f0-9]{64}$/);
  const response=await getTaxExportDownload(db,bucket,queued.id);
  const zipBytes=new Uint8Array(await response.arrayBuffer());
  const files=unzipSync(zipBytes);
  assert.ok(files['manifest.json']);
  assert.ok(files['17_부가가치세.csv']);
  assert.equal(strFromU8(files['17_부가가치세.csv']).split('\r\n').length,506);
  const vendorCsv=strFromU8(files['13_거래처.csv']);
  assert.match(vendorCsv,/A 거래처/);
  assert.doesNotMatch(vendorCsv,/B 거래처/);
  const attachmentCsv=strFromU8(files['19_증빙연결목록.csv']);
  assert.match(attachmentCsv,/A-증빙\.pdf/);
  assert.doesNotMatch(attachmentCsv,/B-증빙\.pdf/);
  const manifest=JSON.parse(strFromU8(files['manifest.json']));
  assert.equal(manifest.exportNo,queued.exportNo);
  assert.equal(manifest.files.length,22);
  const duplicate=await queueTaxExport(db,{year:2026,periodStart:'2026-01-01',periodEnd:'2026-12-31',bookTypeCode:'general',entityId:'ENTITY-A',fundId:'',allowValidationErrors:false,requestId:'REQ-1'},{id:'U-1',name:'tester'});
  assert.equal(duplicate.duplicate,true);
  assert.equal(duplicate.id,queued.id);

  const failedQueue=await queueTaxExport(db,{year:2026,periodStart:'2026-01-01',periodEnd:'2026-12-31',bookTypeCode:'general',entityId:'ENTITY-A',fundId:'',allowValidationErrors:false,requestId:'REQ-FAIL'},{id:'U-1',name:'tester'});
  sqlite.prepare(`UPDATE accounting_entities SET name='생성 중 변경',updated_at='2099-01-01T00:00:00.000Z' WHERE id='ENTITY-A'`).run();
  let failedStatus:any;
  for(let step=0;step<30;step+=1){failedStatus=await processNextTaxExport(db,bucket,failedQueue.id);if(failedStatus.status==='failed')break;}
  assert.equal(failedStatus.status,'failed');
  assert.match(failedStatus.message,/생성 중 변경/);
  assert.equal([...bucket.objects.keys()].some((key)=>key.includes(failedQueue.id)),false);
  const cleanup=sqlite.prepare(`SELECT cleanup_at,cleanup_error FROM accounting_tax_export_batches WHERE id=?`).get(failedQueue.id) as any;
  assert.ok(cleanup.cleanup_at);
  assert.equal(cleanup.cleanup_error,null);
});
