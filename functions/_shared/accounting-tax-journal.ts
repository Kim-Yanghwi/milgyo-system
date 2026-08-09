import { randomHex, type SessionUser } from './helpers';
import {
  isPeriodClosed,
  monthlySummaryStatement,
  nextAccountingNumber,
  type AccountingDimension,
  type AccountingSummaryLine,
} from './accounting';
import { taxAudit, validTaxDate } from './accounting-tax';

type TaxActor = Pick<SessionUser, 'id' | 'name'>;

type TaxJournalLine = AccountingSummaryLine & {
  counterparty?: string;
  memo?: string;
};

type TaxJournalInput = {
  journalDate: string;
  sourceType: 'vat-adjustment' | 'withholding-accrual' | 'withholding-payment';
  sourceId: string;
  description: string;
  dimensions: AccountingDimension;
  lines: TaxJournalLine[];
  actor: TaxActor;
  now: string;
};

type SourceLine = {
  journal_id: string;
  account_code: string;
  account_type: string;
  debit: number;
  credit: number;
  department: string;
  project: string;
  counterparty: string;
  book_type_code: string;
  entity_id: string;
  fund_id: string;
};

const prepareTaxJournal = async (db: D1Database, input: TaxJournalInput) => {
  if (!validTaxDate(input.journalDate)) throw new Error('세무 조정 전표일자를 확인해 주세요.');
  if (await isPeriodClosed(db, input.journalDate)) {
    throw new Error('세무 조정 대상 회계기간이 마감되어 있습니다. 마감 해제 또는 회계담당자 검토 후 다시 처리해 주세요.');
  }
  const debit = input.lines.reduce((sum, line) => sum + Number(line.debit || 0), 0);
  const credit = input.lines.reduce((sum, line) => sum + Number(line.credit || 0), 0);
  if (input.lines.length < 2 || debit <= 0 || debit !== credit
    || input.lines.some((line) => line.debit < 0 || line.credit < 0 || (!!line.debit && !!line.credit))) {
    throw new Error('세무 조정 전표의 차변·대변 구성이 올바르지 않습니다.');
  }
  const accountCodes = [...new Set(input.lines.map((line) => line.accountCode))];
  const validAccounts = await db.prepare(`SELECT code FROM accounting_accounts
    WHERE active=1 AND code IN (${accountCodes.map(() => '?').join(',')})`)
    .bind(...accountCodes).all<{ code: string }>();
  if ((validAccounts.results || []).length !== accountCodes.length) {
    throw new Error('세무 조정 전표에 사용할 수 없는 계정과목이 포함되어 있습니다.');
  }
  const duplicate = await db.prepare(`SELECT id,journal_no FROM accounting_journals
    WHERE source_type=? AND source_id=? AND status IN ('posted','reversed') LIMIT 1`)
    .bind(input.sourceType, input.sourceId).first<{ id: string; journal_no: string }>();
  if (duplicate) return { duplicate: true, journalId: duplicate.id, journalNo: duplicate.journal_no, statements: [] as D1PreparedStatement[] };

  const year = Number(input.journalDate.slice(0, 4));
  const journalId = `JRN-${randomHex(24)}`;
  const journalNo = await nextAccountingNumber(db, 'journal', year);
  const statements: D1PreparedStatement[] = [
    db.prepare(`INSERT INTO accounting_journals
      (id,journal_no,fiscal_year,journal_date,source_type,source_id,description,status,created_by,approved_by,created_at)
      VALUES (?,?,?,?,?,?,?,'posted',?,?,?)`)
      .bind(journalId, journalNo, year, input.journalDate, input.sourceType, input.sourceId,
        input.description, input.actor.name, input.actor.name, input.now),
  ];
  input.lines.forEach((line, index) => {
    const lineId = `JL-${randomHex(20)}`;
    statements.push(
      db.prepare(`INSERT INTO accounting_journal_lines
        (id,journal_id,line_no,account_code,debit,credit,department,project,counterparty,memo)
        VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .bind(lineId, journalId, index + 1, line.accountCode, line.debit, line.credit,
          line.department || '', line.project || '', line.counterparty || '', line.memo || null),
      db.prepare(`INSERT INTO accounting_journal_line_dimensions
        (journal_line_id,book_type_code,entity_id,fund_id,created_at) VALUES (?,?,?,?,?)`)
        .bind(lineId, input.dimensions.bookTypeCode || 'general', input.dimensions.entityId || 'ENTITY-HQ',
          input.dimensions.fundId || '', input.now),
      monthlySummaryStatement(db, input.journalDate, line, input.dimensions, input.now),
    );
  });
  return { duplicate: false, journalId, journalNo, statements };
};

const loadSourceJournalId = async (db: D1Database, sourceType: string, sourceId: string) => {
  if (!sourceId) return '';
  if (sourceType === 'journal') return sourceId;
  const queries: Record<string, string> = {
    resolution: `SELECT journal_id FROM accounting_resolutions WHERE id=?`,
    card_transaction: `SELECT journal_id FROM accounting_card_transactions WHERE id=?`,
    donation: `SELECT journal_id FROM accounting_donations WHERE id=?`,
  };
  const sql = queries[sourceType];
  if (!sql) return '';
  const row = await db.prepare(sql).bind(sourceId).first<{ journal_id: string | null }>();
  return String(row?.journal_id || '');
};

const loadJournalLines = async (db: D1Database, journalId: string) => {
  if (!journalId) return [] as SourceLine[];
  const journal = await db.prepare(`SELECT status FROM accounting_journals WHERE id=?`).bind(journalId)
    .first<{ status: string }>();
  if (!journal || journal.status !== 'posted') {
    throw new Error('연결 원자료의 게시 전표를 찾을 수 없거나 이미 취소된 전표입니다.');
  }
  const rows = await db.prepare(`SELECT l.journal_id,l.account_code,a.account_type,l.debit,l.credit,
    l.department,l.project,l.counterparty,
    COALESCE(NULLIF(d.book_type_code,''),'general') AS book_type_code,
    COALESCE(NULLIF(d.entity_id,''),'ENTITY-HQ') AS entity_id,COALESCE(d.fund_id,'') AS fund_id
    FROM accounting_journal_lines l JOIN accounting_accounts a ON a.code=l.account_code
    LEFT JOIN accounting_journal_line_dimensions d ON d.journal_line_id=l.id
    WHERE l.journal_id=? ORDER BY l.line_no`).bind(journalId).all<SourceLine>();
  return rows.results || [];
};

const matchingDimension = (line: SourceLine, dimensions: AccountingDimension) =>
  line.book_type_code === (dimensions.bookTypeCode || 'general')
  && line.entity_id === (dimensions.entityId || 'ENTITY-HQ')
  && line.fund_id === (dimensions.fundId || '');

const chooseSingleLine = (
  rows: SourceLine[],
  explicitAccountCode: string,
  predicate: (line: SourceLine) => boolean,
  message: string,
) => {
  const candidates = rows.filter(predicate);
  if (explicitAccountCode) {
    const selected = candidates.find((line) => line.account_code === explicitAccountCode);
    if (!selected) throw new Error('선택한 상대계정이 연결 원전표의 해당 차변·대변 행과 일치하지 않습니다.');
    return selected;
  }
  const accountCodes = [...new Set(candidates.map((line) => line.account_code))];
  if (accountCodes.length !== 1) throw new Error(message);
  return candidates.find((line) => line.account_code === accountCodes[0])!;
};

export const postVatAdjustmentJournal = async (
  db: D1Database,
  vatId: string,
  baseAccountCode: string,
  actor: TaxActor,
  now = new Date().toISOString(),
) => {
  const row = await db.prepare(`SELECT * FROM accounting_vat_records WHERE id=?`).bind(vatId).first<any>();
  if (!row) throw new Error('부가가치세 자료를 찾을 수 없습니다.');
  if (row.status !== 'confirmed') throw new Error('확정된 부가가치세 자료만 원장 조정 전표를 생성할 수 있습니다.');
  if (row.adjustment_journal_id) {
    const existing = await db.prepare(`SELECT journal_no FROM accounting_journals WHERE id=?`)
      .bind(row.adjustment_journal_id).first<{ journal_no: string }>();
    return { duplicate: true, journalId: row.adjustment_journal_id, journalNo: existing?.journal_no || '' };
  }
  const vatAmount = Number(row.vat_amount || 0);
  const applicable = vatAmount > 0 && row.tax_type === 'taxable'
    && (row.direction === 'sale' || row.deduction_status === 'deductible');
  if (!applicable) {
    throw new Error('과세 매출 또는 공제가능 과세 매입 중 부가가치세가 있는 자료만 원장 조정 대상입니다.');
  }
  const dimensions: AccountingDimension = {
    bookTypeCode: row.book_type_code || 'general',
    entityId: row.entity_id || 'ENTITY-HQ',
    fundId: row.fund_id || '',
  };
  const sourceJournalId = await loadSourceJournalId(db, row.source_type, row.source_id);
  const sourceLines = await loadJournalLines(db, sourceJournalId);
  let base: SourceLine | null = null;
  if (sourceLines.length) {
    base = chooseSingleLine(sourceLines, baseAccountCode, (line) => matchingDimension(line, dimensions)
      && line.account_code !== '1140' && line.account_code !== '2210'
      && (row.direction === 'purchase'
        ? line.debit > 0 && ['expense', 'asset'].includes(line.account_type)
        : line.credit > 0 && line.account_type === 'revenue'),
    '원전표에 가능한 상대계정이 둘 이상입니다. 부가가치세 조정에 사용할 계정과목을 명시해 주세요.');
  } else {
    if (!baseAccountCode) {
      throw new Error('수동·가져오기 자료는 원전표를 자동 추적할 수 없습니다. 부가가치세 조정 상대계정을 선택해 주세요.');
    }
    const account = await db.prepare(`SELECT code,account_type FROM accounting_accounts WHERE code=? AND active=1`)
      .bind(baseAccountCode).first<{ code: string; account_type: string }>();
    const validType = row.direction === 'purchase'
      ? ['expense', 'asset'].includes(String(account?.account_type || ''))
      : account?.account_type === 'revenue';
    if (!account || !validType) throw new Error('부가가치세 조정 상대계정의 계정 성격을 확인해 주세요.');
    base = {
      journal_id: '', account_code: account.code, account_type: account.account_type,
      debit: 0, credit: 0, department: '', project: '', counterparty: row.counterparty_name || '',
      book_type_code: dimensions.bookTypeCode || 'general', entity_id: dimensions.entityId || 'ENTITY-HQ',
      fund_id: dimensions.fundId || '',
    };
  }
  const common = {
    department: base.department || '', project: base.project || '',
    counterparty: row.counterparty_name || base.counterparty || '', memo: `VAT ${vatId}`,
  };
  const lines: TaxJournalLine[] = row.direction === 'purchase'
    ? [
        { accountCode: '1140', debit: vatAmount, credit: 0, ...common },
        { accountCode: base.account_code, debit: 0, credit: vatAmount, ...common },
      ]
    : [
        { accountCode: base.account_code, debit: vatAmount, credit: 0, ...common },
        { accountCode: '2210', debit: 0, credit: vatAmount, ...common },
      ];
  const prepared = await prepareTaxJournal(db, {
    journalDate: row.transaction_date,
    sourceType: 'vat-adjustment', sourceId: vatId,
    description: `[부가가치세 조정] ${row.counterparty_name || vatId}`,
    dimensions, lines, actor, now,
  });
  if (prepared.duplicate) return prepared;
  await db.batch([
    ...prepared.statements,
    db.prepare(`UPDATE accounting_vat_records SET adjustment_journal_id=?,updated_by=?,updated_at=?
      WHERE id=? AND status='confirmed' AND adjustment_journal_id IS NULL`)
      .bind(prepared.journalId, actor.name, now, vatId),
    taxAudit(db, 'post-adjustment', 'vat-record', vatId, actor,
      { journalId: prepared.journalId, journalNo: prepared.journalNo, vatAmount, baseAccountCode: base.account_code }, now),
  ]);
  return prepared;
};

const prepareWithholdingAccrual = async (
  db: D1Database,
  row: any,
  settlementAccountCode: string,
  actor: TaxActor,
  now: string,
) => {
  const deduction = Number(row.income_tax || 0) + Number(row.local_income_tax || 0) + Number(row.other_deduction || 0);
  if (!deduction) return null;
  if (!row.source_resolution_id) {
    throw new Error('공제액 원장 반영을 위해 게시된 지출결의서를 먼저 연결해 주세요.');
  }
  const source = await db.prepare(`SELECT journal_id FROM accounting_resolutions WHERE id=?`)
    .bind(row.source_resolution_id).first<{ journal_id: string | null }>();
  const dimensions: AccountingDimension = {
    bookTypeCode: row.book_type_code || 'general', entityId: row.entity_id || 'ENTITY-HQ', fundId: row.fund_id || '',
  };
  const sourceLines = await loadJournalLines(db, String(source?.journal_id || ''));
  const settlement = chooseSingleLine(sourceLines, settlementAccountCode,
    (line) => matchingDimension(line, dimensions) && line.credit > 0
      && ['asset', 'liability'].includes(line.account_type) && Number(line.credit) >= deduction,
    '연결 지출전표의 지급 상대계정을 하나로 정할 수 없습니다. 공제액을 되돌릴 상대계정을 명시해 주세요.');
  const common = {
    department: settlement.department || '', project: settlement.project || '',
    counterparty: row.payee_name || settlement.counterparty || '', memo: `원천징수 ${row.payment_no}`,
  };
  const lines: TaxJournalLine[] = [
    { accountCode: settlement.account_code, debit: deduction, credit: 0, ...common },
  ];
  if (Number(row.income_tax || 0)) lines.push({ accountCode: '2220', debit: 0, credit: Number(row.income_tax), ...common });
  if (Number(row.local_income_tax || 0)) lines.push({ accountCode: '2230', debit: 0, credit: Number(row.local_income_tax), ...common });
  if (Number(row.other_deduction || 0)) lines.push({ accountCode: '2240', debit: 0, credit: Number(row.other_deduction), ...common });
  return prepareTaxJournal(db, {
    journalDate: row.payment_date, sourceType: 'withholding-accrual', sourceId: row.id,
    description: `[원천징수 공제계상] ${row.payee_name || row.payment_no}`,
    dimensions, lines, actor, now,
  });
};

export const fileWithholdingRecord = async (
  db: D1Database,
  withholdingId: string,
  settlementAccountCode: string,
  actor: TaxActor,
  now = new Date().toISOString(),
) => {
  const row = await db.prepare(`SELECT w.*,p.name AS payee_name FROM accounting_withholding_records w
    JOIN accounting_tax_payees p ON p.id=w.payee_id WHERE w.id=?`).bind(withholdingId).first<any>();
  if (!row) throw new Error('원천징수 내역을 찾을 수 없습니다.');
  if (row.filing_status !== 'unfiled') throw new Error('미신고 원천징수 내역만 신고완료로 처리할 수 있습니다.');
  if (row.accrual_journal_id) throw new Error('이미 공제액 계상 전표가 연결된 자료입니다.');
  const prepared = await prepareWithholdingAccrual(db, row, settlementAccountCode, actor, now);
  if (prepared?.duplicate) throw new Error('동일 원천징수 내역의 공제액 계상 전표가 이미 존재합니다. 목록을 새로고침해 주세요.');
  const statements = prepared ? [...prepared.statements] : [];
  statements.push(
    db.prepare(`UPDATE accounting_withholding_records SET filing_status='filed',filed_at=?,accrual_journal_id=?,
      updated_by=?,updated_at=? WHERE id=? AND filing_status='unfiled' AND accrual_journal_id IS NULL`)
      .bind(now, prepared?.journalId || null, actor.name, now, withholdingId),
    taxAudit(db, 'file', 'withholding-record', withholdingId, actor,
      { journalId: prepared?.journalId || null, journalNo: prepared?.journalNo || null,
        incomeTax: row.income_tax, localIncomeTax: row.local_income_tax, otherDeduction: row.other_deduction }, now),
  );
  await db.batch(statements);
  return { journalId: prepared?.journalId || null, journalNo: prepared?.journalNo || null };
};

export const payWithholdingTaxes = async (
  db: D1Database,
  withholdingId: string,
  taxPaymentDate: string,
  bankAccountCode: string,
  actor: TaxActor,
  now = new Date().toISOString(),
) => {
  const row = await db.prepare(`SELECT w.*,p.name AS payee_name FROM accounting_withholding_records w
    JOIN accounting_tax_payees p ON p.id=w.payee_id WHERE w.id=?`).bind(withholdingId).first<any>();
  if (!row) throw new Error('원천징수 내역을 찾을 수 없습니다.');
  if (row.filing_status !== 'filed') throw new Error('신고완료 원천징수 내역만 납부완료로 처리할 수 있습니다.');
  if (row.payment_journal_id) throw new Error('이미 세금 납부 전표가 연결된 자료입니다.');
  const taxTotal = Number(row.income_tax || 0) + Number(row.local_income_tax || 0);
  if (!taxTotal) {
    await db.batch([
      db.prepare(`UPDATE accounting_withholding_records SET filing_status='paid',paid_at=?,updated_by=?,updated_at=?
        WHERE id=? AND filing_status='filed'`).bind(now, actor.name, now, withholdingId),
      taxAudit(db, 'pay', 'withholding-record', withholdingId, actor, { taxTotal: 0, journalId: null }, now),
    ]);
    return { journalId: null, journalNo: null };
  }
  if (!validTaxDate(taxPaymentDate)) throw new Error('원천세 실제 납부일을 확인해 주세요.');
  const bank = await db.prepare(`SELECT code FROM accounting_accounts
    WHERE code=? AND active=1 AND account_type='asset' AND normal_side='debit'`)
    .bind(bankAccountCode).first<{ code: string }>();
  if (!bank) throw new Error('원천세 출금계정은 사용 가능한 현금·예금 등 자산·차변 계정으로 선택해 주세요.');
  const dimensions: AccountingDimension = {
    bookTypeCode: row.book_type_code || 'general', entityId: row.entity_id || 'ENTITY-HQ', fundId: row.fund_id || '',
  };
  const common = { department: '', project: '', counterparty: '관할 세무기관', memo: `원천세 납부 ${row.payment_no}` };
  const lines: TaxJournalLine[] = [];
  if (Number(row.income_tax || 0)) lines.push({ accountCode: '2220', debit: Number(row.income_tax), credit: 0, ...common });
  if (Number(row.local_income_tax || 0)) lines.push({ accountCode: '2230', debit: Number(row.local_income_tax), credit: 0, ...common });
  lines.push({ accountCode: bank.code, debit: 0, credit: taxTotal, ...common });
  const prepared = await prepareTaxJournal(db, {
    journalDate: taxPaymentDate, sourceType: 'withholding-payment', sourceId: withholdingId,
    description: `[원천세 납부] ${row.payee_name || row.payment_no}`,
    dimensions, lines, actor, now,
  });
  if (prepared.duplicate) throw new Error('동일 원천징수 내역의 세금 납부 전표가 이미 존재합니다. 목록을 새로고침해 주세요.');
  await db.batch([
    ...prepared.statements,
    db.prepare(`UPDATE accounting_withholding_records SET filing_status='paid',paid_at=?,payment_journal_id=?,
      tax_payment_bank_account_code=?,updated_by=?,updated_at=?
      WHERE id=? AND filing_status='filed' AND payment_journal_id IS NULL`)
      .bind(taxPaymentDate, prepared.journalId, bank.code, actor.name, now, withholdingId),
    taxAudit(db, 'pay', 'withholding-record', withholdingId, actor,
      { journalId: prepared.journalId, journalNo: prepared.journalNo, taxTotal,
        incomeTax: row.income_tax, localIncomeTax: row.local_income_tax, bankAccountCode: bank.code, taxPaymentDate }, now),
  ]);
  return prepared;
};

export const assertLinkedTaxJournalsReversed = async (db: D1Database, journalIds: unknown[]) => {
  const ids = [...new Set(journalIds.map((value) => String(value || '')).filter(Boolean))];
  if (!ids.length) return;
  const posted = await db.prepare(`SELECT journal_no FROM accounting_journals
    WHERE id IN (${ids.map(() => '?').join(',')}) AND status='posted' ORDER BY journal_no`)
    .bind(...ids).all<{ journal_no: string }>();
  const numbers = (posted.results || []).map((row) => row.journal_no);
  if (numbers.length) {
    throw new Error(`연결 세무전표(${numbers.join(', ')})를 기본회계에서 먼저 역분개한 뒤 자료를 취소해 주세요.`);
  }
};
