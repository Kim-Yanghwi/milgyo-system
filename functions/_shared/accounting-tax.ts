import { clean, randomHex, type SessionUser } from './helpers';
import { nextSpecialSequence } from './accounting-special';

export const TAX_SCHEMA_VERSION = '2026-08-08.2';

const REQUIRED_TAX_TABLES = [
  'accounting_card_payments',
  'accounting_tax_profiles',
  'accounting_tax_profile_revisions',
  'accounting_vat_records',
  'accounting_tax_payees',
  'accounting_withholding_records',
  'accounting_tax_export_batches',
  'accounting_tax_export_files',
  'accounting_tax_export_events',
  'accounting_v63_migration_review',
] as const;

const taxSchemaReady = new WeakSet<object>();
const taxSchemaPromises = new WeakMap<object, Promise<void>>();

export const ensureAccountingTaxTables = async (db: D1Database) => {
  const key = db as unknown as object;
  if (taxSchemaReady.has(key)) return;
  let pending = taxSchemaPromises.get(key);
  if (!pending) {
    pending = (async () => {
      const placeholders = REQUIRED_TAX_TABLES.map(() => '?').join(',');
      const [tables, version] = await db.batch([
        db.prepare(`SELECT COUNT(*) AS count FROM sqlite_master
          WHERE type='table' AND name IN (${placeholders})`).bind(...REQUIRED_TAX_TABLES),
        db.prepare(`SELECT meta_value FROM accounting_meta WHERE meta_key='schema_version'`),
      ]);
      const installedVersion = String((version.results?.[0] as any)?.meta_value || '');
      if (Number((tables.results?.[0] as any)?.count || 0) !== REQUIRED_TAX_TABLES.length
        || installedVersion !== TAX_SCHEMA_VERSION) {
        throw new Error(`세무·신고자료 DB 스키마가 준비되지 않았습니다. v64 마이그레이션 ${TAX_SCHEMA_VERSION}을 적용해 주세요.`);
      }
      taxSchemaReady.add(key);
    })().catch((error) => {
      taxSchemaPromises.delete(key);
      throw error;
    });
    taxSchemaPromises.set(key, pending);
  }
  await pending;
};

export const validTaxYear = (value: unknown) => {
  const year = Number(value);
  return Number.isInteger(year) && year >= 2000 && year <= 2200 ? year : 0;
};

export const validTaxDate = (value: unknown) => {
  const text = clean(value, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return false;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};

export const normalizeTaxBusinessNo = (value: unknown) => clean(value, 30).replace(/[^0-9]/g, '');

export const normalizeMaskedIdentifier = (value: unknown) => {
  const text = clean(value, 40).replace(/\s+/g, '');
  if (!text) return '';
  const digits = text.replace(/\D/g, '');
  const hasMask = /[*xX•●]/.test(text);
  if (digits.length >= 7 && !hasMask) {
    throw new Error('개인 식별번호 원문은 저장할 수 없습니다. 뒤 자리를 *로 가린 값만 입력해 주세요.');
  }
  if (digits.length > 7) {
    throw new Error('개인 식별번호는 앞 7자리까지만 남기고 나머지를 *로 가려 주세요.');
  }
  if (text.length > 30) throw new Error('마스킹 식별번호를 30자 이내로 입력해 주세요.');
  return text;
};

export const nextTaxNumber = async (
  db: D1Database,
  type: 'payee' | 'withholding' | 'tax-export' | 'card-payment',
  year: number,
) => {
  const meta = {
    payee: ['지급자', `tax-payee:${year}`, 5],
    withholding: ['원천징수', `tax-withholding:${year}`, 5],
    'tax-export': ['세무자료', `tax-export:${year}`, 5],
    'card-payment': ['카드결제', `card-payment:${year}`, 5],
  } as const;
  const [prefix, key, digits] = meta[type];
  const sequence = await nextSpecialSequence(db, key);
  return `${prefix}-${year}-${String(sequence).padStart(digits, '0')}`;
};

export const taxAudit = (
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

export const vatFilingPeriod = (dateValue: string, cycle: string) => {
  if (!validTaxDate(dateValue)) return '';
  const year = Number(dateValue.slice(0, 4));
  const month = Number(dateValue.slice(5, 7));
  if (cycle === 'annual') return `${year}-A`;
  if (cycle === 'semiannual') return `${year}-H${month <= 6 ? 1 : 2}`;
  return `${year}-Q${Math.ceil(month / 3)}`;
};

export const defaultWithholdingDueDate = (paymentDate: string) => {
  if (!validTaxDate(paymentDate)) return '';
  const date = new Date(`${paymentDate}T00:00:00Z`);
  const due = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 10));
  return due.toISOString().slice(0, 10);
};

export const calculateVatFromTotal = (totalAmount: number, taxType: string) => {
  const total = Math.max(0, Math.round(Number(totalAmount || 0)));
  if (taxType !== 'taxable') return { supplyAmount: total, vatAmount: 0 };
  const vatAmount = Math.round(total / 11);
  return { supplyAmount: total - vatAmount, vatAmount };
};

export const calculateVatFromSupply = (supplyAmount: number, taxType: string) => {
  const supply = Math.max(0, Math.round(Number(supplyAmount || 0)));
  const vatAmount = taxType === 'taxable' ? Math.round(supply * 0.1) : 0;
  return { supplyAmount: supply, vatAmount, totalAmount: supply + vatAmount };
};

export type TaxValidationItem = {
  code: string;
  severity: 'error' | 'warning' | 'info';
  title: string;
  detail: string;
  count: number;
};

export const getTaxValidation = async (db: D1Database, year: number, entityId = '') => {
  const entityCondition = entityId ? ' AND entity_id=?' : '';
  const entityValues = entityId ? [entityId] : [];
  const start = `${year}-01-01`, end = `${year + 1}-01-01`;
  const nowKst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const currentYear = nowKst.getUTCFullYear(), currentMonth = nowKst.getUTCMonth() + 1;
  const elapsedMonth = year < currentYear ? 12 : year === currentYear ? Math.max(0, currentMonth - 1) : 0;
  const profileValidation = entityId
    ? db.prepare(`SELECT CASE WHEN EXISTS (
        SELECT 1 FROM accounting_entities a WHERE a.id=? AND a.active=1 AND (
          EXISTS (SELECT 1 FROM accounting_monthly_summary m WHERE m.fiscal_year=? AND COALESCE(NULLIF(m.entity_id,''),'ENTITY-HQ')=a.id)
          OR EXISTS (SELECT 1 FROM accounting_budget_plans b WHERE b.fiscal_year=? AND COALESCE(NULLIF(b.entity_id,''),'ENTITY-HQ')=a.id)
          OR EXISTS (SELECT 1 FROM accounting_resolutions r
            LEFT JOIN accounting_resolution_dimensions d ON d.resolution_id=r.id
            WHERE r.fiscal_year=? AND COALESCE(NULLIF(d.entity_id,''),'ENTITY-HQ')=a.id)
          OR EXISTS (SELECT 1 FROM accounting_donations d WHERE d.fiscal_year=? AND COALESCE(NULLIF(d.entity_id,''),'ENTITY-HQ')=a.id)
          OR EXISTS (SELECT 1 FROM accounting_vat_records v WHERE v.fiscal_year=? AND v.status<>'cancelled'
            AND COALESCE(NULLIF(v.entity_id,''),'ENTITY-HQ')=a.id)
          OR EXISTS (SELECT 1 FROM accounting_withholding_records w WHERE w.fiscal_year=? AND w.filing_status<>'cancelled'
            AND COALESCE(NULLIF(w.entity_id,''),'ENTITY-HQ')=a.id)
        )
      ) AND NOT EXISTS (
        SELECT 1 FROM accounting_tax_profiles p
        WHERE p.fiscal_year=? AND p.entity_id=? AND p.profile_status='confirmed'
      ) THEN 1 ELSE 0 END AS count`).bind(entityId, year, year, year, year, year, year, year, entityId)
    : db.prepare(`SELECT COUNT(*) AS count FROM accounting_entities a
      WHERE a.active=1 AND (
        EXISTS (SELECT 1 FROM accounting_monthly_summary m WHERE m.fiscal_year=? AND COALESCE(NULLIF(m.entity_id,''),'ENTITY-HQ')=a.id)
        OR EXISTS (SELECT 1 FROM accounting_budget_plans b WHERE b.fiscal_year=? AND COALESCE(NULLIF(b.entity_id,''),'ENTITY-HQ')=a.id)
        OR EXISTS (SELECT 1 FROM accounting_resolutions r
          LEFT JOIN accounting_resolution_dimensions d ON d.resolution_id=r.id
          WHERE r.fiscal_year=? AND COALESCE(NULLIF(d.entity_id,''),'ENTITY-HQ')=a.id)
        OR EXISTS (SELECT 1 FROM accounting_donations d WHERE d.fiscal_year=? AND COALESCE(NULLIF(d.entity_id,''),'ENTITY-HQ')=a.id)
        OR EXISTS (SELECT 1 FROM accounting_vat_records v WHERE v.fiscal_year=? AND v.status<>'cancelled'
          AND COALESCE(NULLIF(v.entity_id,''),'ENTITY-HQ')=a.id)
        OR EXISTS (SELECT 1 FROM accounting_withholding_records w WHERE w.fiscal_year=? AND w.filing_status<>'cancelled'
          AND COALESCE(NULLIF(w.entity_id,''),'ENTITY-HQ')=a.id)
      ) AND NOT EXISTS (
        SELECT 1 FROM accounting_tax_profiles p
        WHERE p.fiscal_year=? AND p.entity_id=a.id AND p.profile_status='confirmed'
      )`).bind(year, year, year, year, year, year, year);
  const results = await db.batch([
    profileValidation,
    db.prepare(`SELECT COUNT(*) AS count FROM (
      SELECT j.id FROM accounting_journals j
      JOIN accounting_journal_lines l ON l.journal_id=j.id
      WHERE j.fiscal_year=? GROUP BY j.id HAVING SUM(l.debit)<>SUM(l.credit)
    )`).bind(year),
    db.prepare(`SELECT
      (SELECT COUNT(*) FROM accounting_cards c
        LEFT JOIN accounting_accounts a ON a.code=c.settlement_account_code
        WHERE c.active=1 AND (a.code IS NULL OR a.active<>1 OR a.account_type<>'liability' OR a.normal_side<>'credit'))
      + (SELECT COUNT(*) FROM accounting_resolutions r
        LEFT JOIN accounting_accounts a ON a.code=r.settlement_account_code
        WHERE r.fiscal_year=? AND (
          (r.payment_method='법인카드' AND (a.code IS NULL OR a.active<>1 OR a.account_type<>'liability' OR a.normal_side<>'credit'))
          OR (COALESCE(r.payment_method,'')<>'법인카드' AND (a.code IS NULL OR a.active<>1 OR a.account_type<>'asset' OR a.normal_side<>'debit'))
        ))
      + (SELECT COUNT(*) FROM accounting_bank_accounts b LEFT JOIN accounting_accounts a ON a.code=b.settlement_account_code
        WHERE b.active=1 AND (a.code IS NULL OR a.active<>1 OR a.account_type<>'asset' OR a.normal_side<>'debit'))
      + (SELECT COUNT(*) FROM accounting_donations d LEFT JOIN accounting_accounts a ON a.code=d.settlement_account_code
        WHERE d.fiscal_year=? AND (a.code IS NULL OR a.active<>1 OR a.account_type<>'asset' OR a.normal_side<>'debit'))
      + (SELECT COUNT(*) FROM accounting_assets x LEFT JOIN accounting_accounts a ON a.code=x.asset_account_code
        WHERE (a.code IS NULL OR a.active<>1 OR a.account_type<>'asset' OR a.normal_side<>'debit'))
      + (SELECT COUNT(*) FROM accounting_contracts c LEFT JOIN accounting_accounts a ON a.code=c.account_code
        WHERE substr(c.contract_date,1,4)=? AND (a.code IS NULL OR a.active<>1 OR a.account_type<>'expense' OR a.normal_side<>'debit'))
      + (SELECT COUNT(*) FROM accounting_card_transactions t LEFT JOIN accounting_accounts a ON a.code=t.account_code
        WHERE t.transaction_date>=? AND t.transaction_date<? AND t.account_code IS NOT NULL
          AND (a.code IS NULL OR a.active<>1 OR a.account_type<>'expense' OR a.normal_side<>'debit'))
      + (SELECT COUNT(*) FROM accounting_card_transactions t JOIN accounting_cards c ON c.id=t.card_id
        WHERE t.transaction_date>=? AND t.transaction_date<? AND (
          COALESCE(NULLIF(t.book_type_code,''),'general')<>COALESCE(NULLIF(c.book_type_code,''),'general')
          OR COALESCE(NULLIF(t.entity_id,''),'ENTITY-HQ')<>COALESCE(NULLIF(c.entity_id,''),'ENTITY-HQ')
        )) AS count`).bind(year, year, String(year), start, end, start, end),
    db.prepare(`SELECT
      (SELECT COUNT(*) FROM accounting_journal_lines l
        JOIN accounting_journals j ON j.id=l.journal_id
        WHERE j.fiscal_year=? AND l.account_code='1130')
      + (SELECT COUNT(*) FROM accounting_monthly_summary WHERE fiscal_year=? AND account_code='1130')
      + (SELECT COUNT(*) FROM accounting_cards WHERE active=1 AND settlement_account_code='1130')
      + (SELECT COUNT(*) FROM accounting_resolutions WHERE fiscal_year=? AND settlement_account_code='1130')
      + (SELECT COUNT(*) FROM accounting_card_transactions
        WHERE transaction_date>=? AND transaction_date<? AND account_code='1130')
      + (SELECT COUNT(*) FROM accounting_bank_accounts WHERE active=1 AND settlement_account_code='1130')
      + (SELECT COUNT(*) FROM accounting_donations WHERE fiscal_year=? AND settlement_account_code='1130')
      + (SELECT COUNT(*) FROM accounting_matching_rules WHERE active=1 AND account_code='1130')
      + (SELECT COUNT(*) FROM accounting_import_transactions
        WHERE transaction_date>=? AND transaction_date<? AND classification_account_code='1130')
      + (SELECT COUNT(*) FROM accounting_assets WHERE asset_account_code='1130')
      + (SELECT COUNT(*) FROM accounting_contracts WHERE substr(contract_date,1,4)=? AND account_code='1130') AS count`)
      .bind(year, year, year, start, end, year, start, end, String(year)),
    db.prepare(`SELECT COUNT(*) AS count FROM accounting_vat_records
      WHERE fiscal_year=? AND status<>'cancelled' AND (status='draft' OR deduction_status='pending')${entityCondition}`)
      .bind(year, ...entityValues),
    db.prepare(`SELECT COUNT(*) AS count FROM accounting_withholding_records
      WHERE fiscal_year=? AND filing_status='unfiled'${entityCondition}`).bind(year, ...entityValues),
    db.prepare(`SELECT COUNT(*) AS count FROM accounting_import_transactions
      WHERE transaction_date>=? AND transaction_date<? AND status IN ('unmatched','suggested')`).bind(start, end),
    db.prepare(`SELECT COUNT(DISTINCT m.period_month) AS count FROM accounting_monthly_summary m
      WHERE m.fiscal_year=? AND m.period_month BETWEEN 1 AND ?
        ${entityId ? "AND COALESCE(NULLIF(m.entity_id,''),'ENTITY-HQ')=?" : ''}
        AND (COALESCE(m.debit_total,0)<>0 OR COALESCE(m.credit_total,0)<>0)
        AND NOT EXISTS (
          SELECT 1 FROM accounting_closings c
          WHERE c.fiscal_year=m.fiscal_year AND c.period_month=m.period_month AND c.status='closed'
        )`).bind(year, elapsedMonth, ...entityValues),
    db.prepare(`SELECT COUNT(*) AS count FROM accounting_attachment_integrity_issues WHERE status='open'`),
    db.prepare(`SELECT COUNT(*) AS count FROM accounting_donors
      WHERE COALESCE(identifier_masked,'')<>''
        AND identifier_masked NOT LIKE '%*%' AND identifier_masked NOT LIKE '%x%'
        AND identifier_masked NOT LIKE '%X%' AND identifier_masked NOT LIKE '%•%' AND identifier_masked NOT LIKE '%●%'
        AND LENGTH(REPLACE(REPLACE(REPLACE(identifier_masked,'-',''),' ',''),'.',''))>=7`),
    db.prepare(`SELECT COUNT(*) AS count FROM accounting_vat_records
      WHERE fiscal_year=? AND status<>'cancelled'${entityCondition}`).bind(year, ...entityValues),
    db.prepare(`SELECT COUNT(*) AS count FROM accounting_withholding_records
      WHERE fiscal_year=? AND filing_status<>'cancelled'${entityCondition}`).bind(year, ...entityValues),
    db.prepare(`SELECT vat_business_type,withholding_enabled FROM accounting_tax_profiles
      WHERE fiscal_year=? ${entityId ? 'AND entity_id=?' : ''}
      ORDER BY CASE profile_status WHEN 'confirmed' THEN 0 ELSE 1 END,updated_at DESC LIMIT 1`).bind(year, ...entityValues),
    db.prepare(`SELECT COUNT(*) AS count FROM accounting_v63_migration_review WHERE status='open'`),
    db.prepare(`SELECT COUNT(*) AS count FROM (
      SELECT source_type,source_id FROM accounting_journals
      WHERE fiscal_year=? AND source_id IS NOT NULL AND source_id<>'' AND status IN ('posted','reversed')
      GROUP BY source_type,source_id HAVING COUNT(*)>1
    )`).bind(year),
    db.prepare(`SELECT COUNT(*) AS count FROM (
      SELECT v.id FROM accounting_vat_records v
      LEFT JOIN accounting_journals j ON j.id=v.adjustment_journal_id
      LEFT JOIN accounting_journal_lines l ON l.journal_id=j.id
      WHERE v.fiscal_year=? AND v.status='confirmed' AND v.tax_type='taxable' AND v.vat_amount>0
        AND (v.direction='sale' OR (v.direction='purchase' AND v.deduction_status='deductible'))${entityCondition}
      GROUP BY v.id,v.direction,v.vat_amount,v.adjustment_journal_id,j.status
      HAVING v.adjustment_journal_id IS NULL OR j.status<>'posted'
        OR (v.direction='purchase' AND COALESCE(SUM(CASE WHEN l.account_code='1140' THEN l.debit-l.credit ELSE 0 END),0)<>v.vat_amount)
        OR (v.direction='sale' AND COALESCE(SUM(CASE WHEN l.account_code='2210' THEN l.credit-l.debit ELSE 0 END),0)<>v.vat_amount)
    )`).bind(year, ...entityValues),
    db.prepare(`SELECT COUNT(*) AS count FROM (
      SELECT w.id FROM accounting_withholding_records w
      LEFT JOIN accounting_journals j ON j.id=w.accrual_journal_id
      LEFT JOIN accounting_journal_lines l ON l.journal_id=j.id
      WHERE w.fiscal_year=? AND w.filing_status IN ('filed','paid')
        AND (w.income_tax+w.local_income_tax+w.other_deduction)>0${entityCondition}
      GROUP BY w.id,w.income_tax,w.local_income_tax,w.other_deduction,w.accrual_journal_id,j.status
      HAVING w.accrual_journal_id IS NULL OR j.status<>'posted'
        OR COALESCE(SUM(CASE WHEN l.account_code='2220' THEN l.credit-l.debit ELSE 0 END),0)<>w.income_tax
        OR COALESCE(SUM(CASE WHEN l.account_code='2230' THEN l.credit-l.debit ELSE 0 END),0)<>w.local_income_tax
        OR COALESCE(SUM(CASE WHEN l.account_code='2240' THEN l.credit-l.debit ELSE 0 END),0)<>w.other_deduction
    )`).bind(year, ...entityValues),
    db.prepare(`SELECT COUNT(*) AS count FROM (
      SELECT w.id FROM accounting_withholding_records w
      LEFT JOIN accounting_journals j ON j.id=w.payment_journal_id
      LEFT JOIN accounting_journal_lines l ON l.journal_id=j.id
      WHERE w.fiscal_year=? AND w.filing_status='paid' AND (w.income_tax+w.local_income_tax)>0${entityCondition}
      GROUP BY w.id,w.income_tax,w.local_income_tax,w.payment_journal_id,j.status
      HAVING w.payment_journal_id IS NULL OR j.status<>'posted'
        OR COALESCE(SUM(CASE WHEN l.account_code='2220' THEN l.debit-l.credit ELSE 0 END),0)<>w.income_tax
        OR COALESCE(SUM(CASE WHEN l.account_code='2230' THEN l.debit-l.credit ELSE 0 END),0)<>w.local_income_tax
    )`).bind(year, ...entityValues),
    db.prepare(`SELECT
      (SELECT COUNT(*) FROM (
        SELECT v.source_id FROM accounting_vat_records v JOIN accounting_resolutions s ON s.id=v.source_id
        WHERE v.fiscal_year=? AND v.status<>'cancelled' AND v.source_type='resolution'${entityId ? ' AND v.entity_id=?' : ''}
        GROUP BY v.source_id HAVING SUM(v.total_amount)>MAX(ABS(s.amount))
      ))
      + (SELECT COUNT(*) FROM (
        SELECT v.source_id FROM accounting_vat_records v JOIN accounting_card_transactions s ON s.id=v.source_id
        WHERE v.fiscal_year=? AND v.status<>'cancelled' AND v.source_type='card_transaction'${entityId ? ' AND v.entity_id=?' : ''}
        GROUP BY v.source_id HAVING SUM(v.total_amount)>MAX(ABS(s.amount))
      ))
      + (SELECT COUNT(*) FROM (
        SELECT v.source_id FROM accounting_vat_records v JOIN accounting_import_transactions s ON s.id=v.source_id
        WHERE v.fiscal_year=? AND v.status<>'cancelled' AND v.source_type='import_transaction'${entityId ? ' AND v.entity_id=?' : ''}
        GROUP BY v.source_id HAVING SUM(v.total_amount)>MAX(ABS(s.amount))
      ))
      + (SELECT COUNT(*) FROM (
        SELECT v.source_id FROM accounting_vat_records v JOIN accounting_donations s ON s.id=v.source_id
        WHERE v.fiscal_year=? AND v.status<>'cancelled' AND v.source_type='donation'${entityId ? ' AND v.entity_id=?' : ''}
        GROUP BY v.source_id HAVING SUM(v.total_amount)>MAX(ABS(s.amount))
      )) AS count`).bind(
        year, ...entityValues, year, ...entityValues, year, ...entityValues, year, ...entityValues,
      ),
    db.prepare(`SELECT COUNT(*) AS count FROM (
      SELECT w.source_resolution_id,SUM(w.gross_amount) AS allocated,MAX(ABS(r.amount)) AS source_amount
      FROM accounting_withholding_records w JOIN accounting_resolutions r ON r.id=w.source_resolution_id
      WHERE w.fiscal_year=? AND w.filing_status<>'cancelled'${entityCondition}
      GROUP BY w.source_resolution_id HAVING SUM(w.gross_amount)>MAX(ABS(r.amount))
    )`).bind(year, ...entityValues),
    db.prepare(`SELECT COUNT(*) AS count FROM accounting_vat_records v
      JOIN accounting_journals j ON j.id=v.adjustment_journal_id
      WHERE v.fiscal_year=? AND v.status='cancelled' AND j.status='posted'${entityCondition}`).bind(year, ...entityValues),
    db.prepare(`SELECT COUNT(*) AS count FROM accounting_withholding_records w
      WHERE w.fiscal_year=? AND w.filing_status='cancelled'${entityCondition} AND (
        EXISTS (SELECT 1 FROM accounting_journals j WHERE j.id=w.accrual_journal_id AND j.status='posted')
        OR EXISTS (SELECT 1 FROM accounting_journals j WHERE j.id=w.payment_journal_id AND j.status='posted')
      )`).bind(year, ...entityValues),
    db.prepare(`SELECT COUNT(*) AS count FROM accounting_vat_records v
      LEFT JOIN accounting_vat_records p ON p.id=v.supersedes_id
      WHERE v.fiscal_year=? AND v.supersedes_id IS NOT NULL${entityId ? ' AND v.entity_id=?' : ''} AND (
        p.id IS NULL OR p.status<>'cancelled'
        OR p.source_type<>v.source_type OR p.source_id<>v.source_id
        OR p.source_line_no<>v.source_line_no
        OR p.book_type_code<>v.book_type_code OR p.entity_id<>v.entity_id
        OR COALESCE(p.fund_id,'')<>COALESCE(v.fund_id,'')
        OR v.version_no<>p.version_no+1
      )`).bind(year, ...entityValues),
    db.prepare(`SELECT COUNT(*) AS count FROM accounting_withholding_records w
      LEFT JOIN accounting_withholding_records p ON p.id=w.supersedes_id
      WHERE w.fiscal_year=? AND w.supersedes_id IS NOT NULL${entityId ? ' AND w.entity_id=?' : ''} AND (
        p.id IS NULL OR p.filing_status<>'cancelled'
        OR COALESCE(p.source_resolution_id,'')<>COALESCE(w.source_resolution_id,'')
        OR p.book_type_code<>w.book_type_code OR p.entity_id<>w.entity_id
        OR COALESCE(p.fund_id,'')<>COALESCE(w.fund_id,'')
        OR w.version_no<>p.version_no+1
      )`).bind(year, ...entityValues),
  ]);
  const countAt = (index: number) => Number((results[index]?.results?.[0] as any)?.count || 0);
  const profile = (results[12]?.results?.[0] || {}) as any;
  const items: TaxValidationItem[] = [];
  const add = (item: TaxValidationItem) => items.push(item);
  if (countAt(0)) add({ code: 'TAX_PROFILE_UNCONFIRMED', severity: 'error', title: '세무기본정보 미확정', detail: '제출범위에서 활동이 있는 회계조직별 세무기본정보를 입력하고 확정해 주세요.', count: countAt(0) });
  if (countAt(1)) add({ code: 'JOURNAL_IMBALANCE', severity: 'error', title: '차변·대변 불일치 전표', detail: '합계가 일치하지 않는 전표가 있어 제출 패키지의 신뢰성을 보장할 수 없습니다.', count: countAt(1) });
  if (countAt(2)) add({ code: 'ACCOUNT_REFERENCE_INVALID', severity: 'error', title: '계정과목 성격 불일치', detail: '법인카드·결의·금융계좌·기부·자산·계약 자료 중 해당 필드의 자산·부채·비용 성격과 맞지 않는 계정과목이 있습니다.', count: countAt(2) });
  if (countAt(3)) add({ code: 'LEGACY_CARD_ACCOUNT', severity: 'error', title: '구 법인카드계정 잔존', detail: '전표에 구계정 1130이 남아 있습니다. v63 이관 결과를 확인해 주세요.', count: countAt(3) });
  if (countAt(4)) add({ code: 'VAT_PENDING', severity: 'warning', title: '부가가치세 검토대기', detail: '공제 여부 또는 자료 상태가 확정되지 않은 부가가치세 내역이 있습니다.', count: countAt(4) });
  if (countAt(5)) add({ code: 'WITHHOLDING_UNFILED', severity: 'warning', title: '원천징수 미신고', detail: '신고완료 또는 납부완료로 처리되지 않은 원천징수 내역이 있습니다.', count: countAt(5) });
  if (countAt(6)) add({ code: 'RECONCILIATION_PENDING', severity: 'warning', title: '미대사 금융거래', detail: '통장·법인카드 거래 중 대사가 끝나지 않은 내역이 있습니다.', count: countAt(6) });
  if (countAt(7)) add({ code: 'PERIOD_NOT_CLOSED', severity: 'warning', title: '월 마감 미완료', detail: `제출 기준시점까지 실제 회계활동이 있는 경과월 중 ${countAt(7)}개월이 아직 마감되지 않았습니다. 기본 회계의 결산·마감에서 확인해 주세요.`, count: countAt(7) });
  if (countAt(8)) add({ code: 'ATTACHMENT_INTEGRITY', severity: 'error', title: '증빙파일 무결성 문제', detail: '해결되지 않은 회계 첨부파일 무결성 점검 결과가 있습니다.', count: countAt(8) });
  if (countAt(9)) add({ code: 'UNMASKED_IDENTIFIER', severity: 'error', title: '식별번호 마스킹 확인 필요', detail: '마스킹 문자가 없는 후원자 식별정보가 있습니다. 원문 여부를 확인해 주세요.', count: countAt(9) });
  if (['general', 'mixed'].includes(String(profile.vat_business_type || '')) && !countAt(10)) add({ code: 'VAT_DATA_EMPTY', severity: 'warning', title: '부가가치세 자료 없음', detail: '과세 또는 겸영으로 설정되어 있으나 해당 연도 부가가치세 보조장부가 비어 있습니다.', count: 1 });
  if (Number(profile.withholding_enabled || 0) === 1 && !countAt(11)) add({ code: 'WITHHOLDING_DATA_EMPTY', severity: 'warning', title: '원천징수 자료 없음', detail: '원천징수 대상으로 설정되어 있으나 해당 연도 원천징수 내역이 비어 있습니다.', count: 1 });
  if (countAt(13)) add({ code: 'V63_MIGRATION_REVIEW', severity: 'error', title: 'v63 이관 검토대기', detail: '지급방법이 불명확해 자동 복구하지 않은 비법인카드 2110 결의가 있습니다. 이관 검토대장에서 원증빙과 계정을 확인해 주세요.', count: countAt(13) });
  if (countAt(14)) add({ code: 'DUPLICATE_JOURNAL_SOURCE', severity: 'error', title: '원자료 중복전표', detail: '같은 원자료에 게시·취소 전표가 중복 연결되어 있습니다. 제출 전에 중복 전표를 역분개하고 연결관계를 확인해 주세요.', count: countAt(14) });
  if (countAt(15)) add({ code: 'VAT_LEDGER_MISMATCH', severity: 'error', title: '부가가치세 원장 불일치', detail: '확정 세액과 부가가치세대급금·예수금 조정 전표가 없거나 금액이 다릅니다.', count: countAt(15) });
  if (countAt(16)) add({ code: 'WITHHOLDING_ACCRUAL_MISMATCH', severity: 'error', title: '원천징수 예수금 불일치', detail: '신고 자료의 소득세·지방소득세·기타공제와 공제액 계상 전표가 없거나 금액이 다릅니다.', count: countAt(16) });
  if (countAt(17)) add({ code: 'WITHHOLDING_PAYMENT_MISMATCH', severity: 'error', title: '원천세 납부전표 불일치', detail: '납부완료 자료와 소득세·지방소득세 예수금 납부 전표가 없거나 금액이 다릅니다.', count: countAt(17) });
  if (countAt(18)) add({ code: 'VAT_SOURCE_OVERALLOCATED', severity: 'error', title: '부가가치세 원자료 초과분할', detail: '활성 부가가치세 분할합계가 연결 원자료 금액을 초과합니다.', count: countAt(18) });
  if (countAt(19)) add({ code: 'WITHHOLDING_SOURCE_OVERALLOCATED', severity: 'error', title: '원천징수 결의금액 초과연결', detail: '활성 원천징수 총지급액 합계가 연결 지출결의금액을 초과합니다.', count: countAt(19) });
  if (countAt(20) || countAt(21)) add({ code: 'CANCELLED_TAX_JOURNAL_POSTED', severity: 'error', title: '취소 세무자료 전표 잔존', detail: '취소된 세무 보조장부에 아직 게시 상태인 조정·납부 전표가 연결되어 있습니다. 기본회계에서 역분개해 주세요.', count: countAt(20) + countAt(21) });
  if (countAt(22)) add({ code: 'VAT_CORRECTION_LINEAGE_INVALID', severity: 'error', title: '부가가치세 정정계보 오류', detail: '정정본이 취소된 직전본의 원자료 행·회계범위·버전 번호를 올바르게 승계하지 않았습니다.', count: countAt(22) });
  if (countAt(23)) add({ code: 'WITHHOLDING_CORRECTION_LINEAGE_INVALID', severity: 'error', title: '원천징수 정정계보 오류', detail: '정정본이 취소된 직전본의 원자료·회계범위·버전 번호를 올바르게 승계하지 않았습니다.', count: countAt(23) });
  if (!items.length) add({ code: 'VALIDATION_OK', severity: 'info', title: '사전검증 완료', detail: '현재 자동검증 항목에서 오류나 경고가 발견되지 않았습니다.', count: 0 });
  return items;
};

export const cleanTaxText = (value: unknown, max = 200) => clean(value, max);
