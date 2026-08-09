import { Zip, ZipPassThrough, strToU8 } from 'fflate';
import { randomHex, type SessionUser } from './helpers';
import { getTaxValidation, nextTaxNumber, TAX_SCHEMA_VERSION, validTaxDate, type TaxValidationItem } from './accounting-tax';
import { TAX_EXPORT_R2_PREFIX, assertR2KeyWithinPrefixes, assertR2KeysWithinPrefixes } from './r2-scope-guard';

const PAGE_SIZE = 500;
const EXPORT_PREFIX = 'tax-exports';
const LEASE_SECONDS = 15 * 60;
const RETENTION_YEARS = 10;

export type TaxExportRequest = {
  year: number;
  periodStart: string;
  periodEnd: string;
  bookTypeCode: string;
  entityId: string;
  fundId: string;
  allowValidationErrors: boolean;
  requestId: string;
};

type ExportContext = TaxExportRequest & {
  batchId: string;
  exportNo: string;
  snapshotAt: string;
  balanceStart: string;
  generatedBy: string;
  validation: TaxValidationItem[];
  totalDebit: number;
  totalCredit: number;
  asOfDebit: number;
  asOfCredit: number;
};

type SqlQuery = { sql: string; values: unknown[] };
type CsvColumn = { header: string; key: string; maskIdentifier?: boolean };
type Dataset = {
  key: string;
  fileName: string;
  contentType: string;
  columns?: CsvColumn[];
  query?: (context: ExportContext) => SqlQuery;
  staticText?: (context: ExportContext) => string;
  staticRowCount?: (context: ExportContext) => number;
};

type ExportBatch = ExportContext & {
  id: string;
  status: string;
  created_at: string;
  filters_json: string;
  manifest_json: string;
  progress_current: number;
  progress_total: number;
};

const encoder = new TextEncoder();

const rotr = (value: number, bits: number) => (value >>> bits) | (value << (32 - bits));
const SHA_K = new Uint32Array([
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
]);

export class IncrementalSha256 {
  private state = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
  private buffer = new Uint8Array(64);
  private buffered = 0;
  private bytes = 0;
  private finished = false;

  update(input: Uint8Array) {
    if (this.finished) throw new Error('SHA-256 digest has already been finalized.');
    this.bytes += input.byteLength;
    let offset = 0;
    while (offset < input.byteLength) {
      const take = Math.min(64 - this.buffered, input.byteLength - offset);
      this.buffer.set(input.subarray(offset, offset + take), this.buffered);
      this.buffered += take;
      offset += take;
      if (this.buffered === 64) {
        this.compress(this.buffer);
        this.buffered = 0;
      }
    }
    return this;
  }

  private compress(block: Uint8Array) {
    const words = new Uint32Array(64);
    for (let index = 0; index < 16; index += 1) {
      const offset = index * 4;
      words[index] = ((block[offset] << 24) | (block[offset + 1] << 16)
        | (block[offset + 2] << 8) | block[offset + 3]) >>> 0;
    }
    for (let index = 16; index < 64; index += 1) {
      const x = words[index - 15], y = words[index - 2];
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
    }
    let [a,b,c,d,e,f,g,h] = this.state;
    for (let index = 0; index < 64; index += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + s1 + ch + SHA_K[index] + words[index]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) >>> 0;
      h=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;
    }
    const values = [a,b,c,d,e,f,g,h];
    for (let index = 0; index < 8; index += 1) this.state[index] = (this.state[index] + values[index]) >>> 0;
  }

  digestHex() {
    if (!this.finished) {
      const bitLength = this.bytes * 8;
      const high = Math.floor(bitLength / 0x100000000);
      const low = bitLength >>> 0;
      this.buffer[this.buffered++] = 0x80;
      if (this.buffered > 56) {
        this.buffer.fill(0, this.buffered);
        this.compress(this.buffer);
        this.buffered = 0;
      }
      this.buffer.fill(0, this.buffered, 56);
      const view = new DataView(this.buffer.buffer);
      view.setUint32(56, high >>> 0, false);
      view.setUint32(60, low, false);
      this.compress(this.buffer);
      this.finished = true;
    }
    return [...this.state].map((value) => value.toString(16).padStart(8, '0')).join('');
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

export const updateCrc32 = (crc: number, bytes: Uint8Array) => {
  let value = crc ^ 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
};

export const csvCell = (value: unknown) => {
  const raw = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  const text = /^[\t\r\n ]*[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return `"${text.replace(/"/g, '""')}"`;
};

export const safePersonalIdentifier = (value: unknown) => {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const digits = text.replace(/\D/g, '');
  if (digits.length < 7) return text;
  if (/[*xX•●]/.test(text) && digits.length <= 7) return text;
  return `${digits.slice(0, 6)}-${digits.slice(6, 7)}${'*'.repeat(6)}`;
};

const columns = (...pairs: Array<[string,string] | [string,string,'mask']>): CsvColumn[] =>
  pairs.map(([header,key,kind]) => ({ header, key, maskIdentifier: kind === 'mask' }));

const dimensionFilter = (alias: string, context: ExportContext) => {
  const conditions: string[] = [];
  const values: unknown[] = [];
  if (context.bookTypeCode) { conditions.push(`COALESCE(NULLIF(${alias}.book_type_code,''),'general')=?`); values.push(context.bookTypeCode); }
  if (context.entityId) { conditions.push(`COALESCE(NULLIF(${alias}.entity_id,''),'ENTITY-HQ')=?`); values.push(context.entityId); }
  if (context.fundId) { conditions.push(`COALESCE(${alias}.fund_id,'')=?`); values.push(context.fundId); }
  return { sql: conditions.length ? ` AND ${conditions.join(' AND ')}` : '', values };
};

const journalBase = (context: ExportContext, startDate: string) => {
  const dims = dimensionFilter('d', context);
  return {
    sql: `SELECT printf('%s|%010d|%s',j.journal_date,l.line_no,l.id) AS row_key,
      j.id AS journal_id,j.journal_no,j.journal_date,j.source_type,j.source_id,j.description,j.status,j.document_id,
      l.id AS line_id,l.line_no,l.account_code,a.name AS account_name,a.account_type,a.normal_side,l.debit,l.credit,
      l.department,l.project,l.counterparty,l.memo,COALESCE(NULLIF(d.book_type_code,''),'general') AS book_type_code,
      COALESCE(NULLIF(d.entity_id,''),'ENTITY-HQ') AS entity_id,COALESCE(d.fund_id,'') AS fund_id,
      bt.name AS book_type_name,e.name AS entity_name,f.name AS fund_name,j.created_at
      FROM accounting_journals j JOIN accounting_journal_lines l ON l.journal_id=j.id
      JOIN accounting_accounts a ON a.code=l.account_code LEFT JOIN accounting_journal_line_dimensions d ON d.journal_line_id=l.id
      LEFT JOIN accounting_book_types bt ON bt.code=COALESCE(NULLIF(d.book_type_code,''),'general')
      LEFT JOIN accounting_entities e ON e.id=COALESCE(NULLIF(d.entity_id,''),'ENTITY-HQ')
      LEFT JOIN accounting_funds f ON f.id=d.fund_id
      WHERE j.journal_date>=? AND j.journal_date<=? AND j.status IN ('posted','reversed')
        AND j.created_at<=? AND COALESCE(j.updated_at,j.created_at)<=?${dims.sql}`,
    values: [startDate, context.periodEnd, context.snapshotAt, context.snapshotAt, ...dims.values],
  };
};

const scopedVendorPredicate = (alias: string, context: ExportContext): SqlQuery => {
  const resolutionDimensions = dimensionFilter('rd', context);
  const contractDimensions = dimensionFilter('contract', context);
  return {
    sql: `(
      EXISTS (
        SELECT 1 FROM accounting_resolutions r
        LEFT JOIN accounting_resolution_dimensions rd ON rd.resolution_id=r.id
        WHERE r.vendor_id=${alias}.id AND r.resolution_date>=? AND r.resolution_date<=?
          AND r.created_at<=? AND r.updated_at<=?${resolutionDimensions.sql}
      ) OR EXISTS (
        SELECT 1 FROM accounting_contracts contract
        WHERE contract.vendor_id=${alias}.id AND contract.contract_date<=? AND contract.end_date>=?
          AND contract.created_at<=? AND contract.updated_at<=?${contractDimensions.sql}
      )
    )`,
    values: [
      context.periodStart,context.periodEnd,context.snapshotAt,context.snapshotAt,...resolutionDimensions.values,
      context.periodEnd,context.periodStart,context.snapshotAt,context.snapshotAt,...contractDimensions.values,
    ],
  };
};

const attachmentQuery = (context: ExportContext): SqlQuery => {
  const conditions: string[] = [];
  const values: unknown[] = [context.snapshotAt,context.snapshotAt];
  const add = (referenceTypes: string[], predicate: string, bindings: unknown[]) => {
    const typeSql = referenceTypes.length === 1
      ? `a.reference_type='${referenceTypes[0]}'`
      : `a.reference_type IN (${referenceTypes.map((type) => `'${type}'`).join(',')})`;
    conditions.push(`(${typeSql} AND ${predicate})`);
    values.push(...bindings);
  };

  const budgetDimensions = dimensionFilter('b',context);
  add(['budget'],`EXISTS (
    SELECT 1 FROM accounting_budget_plans b WHERE b.id=a.reference_id AND b.fiscal_year=?
      AND b.created_at<=? AND b.updated_at<=?${budgetDimensions.sql}
  )`,[context.year,context.snapshotAt,context.snapshotAt,...budgetDimensions.values]);

  const resolutionDimensions = dimensionFilter('rd',context);
  add(['resolution'],`EXISTS (
    SELECT 1 FROM accounting_resolutions r
    LEFT JOIN accounting_resolution_dimensions rd ON rd.resolution_id=r.id
    WHERE r.id=a.reference_id AND r.resolution_date>=? AND r.resolution_date<=?
      AND r.created_at<=? AND r.updated_at<=?${resolutionDimensions.sql}
  )`,[context.periodStart,context.periodEnd,context.snapshotAt,context.snapshotAt,...resolutionDimensions.values]);

  const journalDimensions = dimensionFilter('jd',context);
  add(['journal'],`EXISTS (
    SELECT 1 FROM accounting_journals j JOIN accounting_journal_lines jl ON jl.journal_id=j.id
    LEFT JOIN accounting_journal_line_dimensions jd ON jd.journal_line_id=jl.id
    WHERE j.id=a.reference_id AND j.journal_date>=? AND j.journal_date<=? AND j.status IN ('posted','reversed')
      AND j.created_at<=? AND COALESCE(j.updated_at,j.created_at)<=?${journalDimensions.sql}
  )`,[context.periodStart,context.periodEnd,context.snapshotAt,context.snapshotAt,...journalDimensions.values]);

  const donationDimensions = dimensionFilter('donation',context);
  add(['donation','receipt'],`EXISTS (
    SELECT 1 FROM accounting_donations donation WHERE donation.id=a.reference_id
      AND donation.donation_date>=? AND donation.donation_date<=?
      AND donation.created_at<=? AND donation.updated_at<=?${donationDimensions.sql}
  )`,[context.periodStart,context.periodEnd,context.snapshotAt,context.snapshotAt,...donationDimensions.values]);

  const assetDimensions = dimensionFilter('asset',context);
  add(['asset'],`EXISTS (
    SELECT 1 FROM accounting_assets asset WHERE asset.id=a.reference_id AND asset.acquisition_date<=?
      AND (asset.disposal_date IS NULL OR asset.disposal_date>=?)
      AND asset.created_at<=? AND asset.updated_at<=?${assetDimensions.sql}
  )`,[context.periodEnd,context.periodStart,context.snapshotAt,context.snapshotAt,...assetDimensions.values]);

  const transactionDimensions = dimensionFilter('card_tx',context);
  add(['card_transaction'],`EXISTS (
    SELECT 1 FROM accounting_card_transactions card_tx WHERE card_tx.id=a.reference_id
      AND card_tx.transaction_date>=? AND card_tx.transaction_date<=?
      AND card_tx.created_at<=? AND card_tx.updated_at<=?${transactionDimensions.sql}
  )`,[context.periodStart,context.periodEnd,context.snapshotAt,context.snapshotAt,...transactionDimensions.values]);
  add(['card'],`EXISTS (
    SELECT 1 FROM accounting_cards card JOIN accounting_card_transactions card_tx ON card_tx.card_id=card.id
    WHERE card.id=a.reference_id AND card_tx.transaction_date>=? AND card_tx.transaction_date<=?
      AND card.created_at<=? AND card.updated_at<=? AND card_tx.created_at<=? AND card_tx.updated_at<=?${transactionDimensions.sql}
  )`,[context.periodStart,context.periodEnd,context.snapshotAt,context.snapshotAt,context.snapshotAt,context.snapshotAt,...transactionDimensions.values]);

  const contractDimensions = dimensionFilter('contract',context);
  add(['contract'],`EXISTS (
    SELECT 1 FROM accounting_contracts contract WHERE contract.id=a.reference_id
      AND contract.contract_date<=? AND contract.end_date>=?
      AND contract.created_at<=? AND contract.updated_at<=?${contractDimensions.sql}
  )`,[context.periodEnd,context.periodStart,context.snapshotAt,context.snapshotAt,...contractDimensions.values]);

  const importDimensions = dimensionFilter('imported',context);
  add(['import_batch'],`EXISTS (
    SELECT 1 FROM (
      SELECT ib.id,COALESCE(NULLIF(ba.book_type_code,''),NULLIF(card.book_type_code,''),'general') AS book_type_code,
        COALESCE(NULLIF(ba.entity_id,''),NULLIF(card.entity_id,''),'ENTITY-HQ') AS entity_id,COALESCE(ba.fund_id,'') AS fund_id
      FROM accounting_import_batches ib JOIN accounting_import_transactions it ON it.batch_id=ib.id
      LEFT JOIN accounting_bank_accounts ba ON ib.source_type='bank' AND ba.id=ib.source_account_id
      LEFT JOIN accounting_cards card ON ib.source_type='card' AND card.id=ib.source_account_id
      WHERE it.transaction_date>=? AND it.transaction_date<=? AND it.created_at<=? AND it.updated_at<=?
        AND ib.created_at<=? AND ib.updated_at<=?
    ) imported WHERE imported.id=a.reference_id${importDimensions.sql}
  )`,[context.periodStart,context.periodEnd,context.snapshotAt,context.snapshotAt,context.snapshotAt,context.snapshotAt,...importDimensions.values]);

  const bankDimensions = dimensionFilter('bank',context);
  add(['bank_account'],`EXISTS (
    SELECT 1 FROM accounting_bank_accounts bank WHERE bank.id=a.reference_id
      AND bank.created_at<=? AND bank.updated_at<=?${bankDimensions.sql}
      AND EXISTS (
        SELECT 1 FROM accounting_import_batches ib JOIN accounting_import_transactions it ON it.batch_id=ib.id
        WHERE ib.source_type='bank' AND ib.source_account_id=bank.id
          AND it.transaction_date>=? AND it.transaction_date<=? AND it.created_at<=? AND it.updated_at<=?
          AND ib.created_at<=? AND ib.updated_at<=?
      )
  )`,[context.snapshotAt,context.snapshotAt,...bankDimensions.values,context.periodStart,context.periodEnd,
    context.snapshotAt,context.snapshotAt,context.snapshotAt,context.snapshotAt]);

  const vendorScope = scopedVendorPredicate('vendor',context);
  add(['vendor'],`EXISTS (
    SELECT 1 FROM accounting_vendors vendor WHERE vendor.id=a.reference_id
      AND vendor.created_at<=? AND vendor.updated_at<=? AND ${vendorScope.sql}
  )`,[context.snapshotAt,context.snapshotAt,...vendorScope.values]);

  const budgetChangeDimensions = dimensionFilter('b',context);
  add(['budget_change'],`EXISTS (
    SELECT 1 FROM accounting_budget_change_requests change_request
    JOIN accounting_budget_plans b ON b.id=change_request.target_budget_id OR b.id=change_request.source_budget_id
    WHERE change_request.id=a.reference_id AND change_request.fiscal_year=?
      AND change_request.created_at<=? AND change_request.updated_at<=?
      AND b.created_at<=? AND b.updated_at<=?${budgetChangeDimensions.sql}
  )`,[context.year,context.snapshotAt,context.snapshotAt,context.snapshotAt,context.snapshotAt,...budgetChangeDimensions.values]);

  if (!context.fundId) {
    const branchConditions: string[] = [];
    const branchValues: unknown[] = [context.year,context.snapshotAt,context.snapshotAt];
    if (context.bookTypeCode) { branchConditions.push(`report.book_type_code=?`); branchValues.push(context.bookTypeCode); }
    if (context.entityId) { branchConditions.push(`report.entity_id=?`); branchValues.push(context.entityId); }
    add(['branch_report'],`EXISTS (
      SELECT 1 FROM accounting_branch_reports report WHERE report.id=a.reference_id AND report.fiscal_year=?
        AND report.created_at<=? AND report.updated_at<=?${branchConditions.length ? ` AND ${branchConditions.join(' AND ')}` : ''}
    )`,branchValues);
  }

  if (!context.bookTypeCode && !context.entityId && !context.fundId) {
    add(['closing'],`EXISTS (
      SELECT 1 FROM accounting_closings closing WHERE closing.id=a.reference_id AND closing.fiscal_year=? AND closing.closed_at<=?
    )`,[context.year,context.snapshotAt]);
    add(['donation_export'],`EXISTS (
      SELECT 1 FROM accounting_donation_export_batches batch
      WHERE batch.id=a.reference_id AND batch.fiscal_year=? AND batch.created_at<=? AND batch.updated_at<=?
    )`,[context.year,context.snapshotAt,context.snapshotAt]);
  }

  return {
    sql: `SELECT printf('%020d',a.id) AS row_key,a.*
      FROM accounting_attachments a
      WHERE a.uploaded_at<=? AND (a.deleted_at IS NULL OR a.deleted_at>?)
        AND (${conditions.join(' OR ')})`,
    values,
  };
};

const DATASETS: Dataset[] = [
  {
    key: 'cover', fileName: '00_제출자료_표지.csv', contentType: 'text/csv; charset=utf-8',
    columns: columns(['항목','item'],['내용','value']),
    staticText: (c) => {
      const rows = [
        ['자료명','대한불교밀교종 세무사 제출 패키지'],['생성번호',c.exportNo],['회계연도',c.year],
        ['제출기간',`${c.periodStart} ~ ${c.periodEnd}`],['스냅샷시각(UTC)',c.snapshotAt],['생성자',c.generatedBy],
        ['회계구분',c.bookTypeCode || '전체'],['회계조직',c.entityId || '전체'],['재원',c.fundId || '전체'],
        ['차변합계',c.totalDebit],['대변합계',c.totalCredit],
        ['자동검증 오류',c.validation.filter((v) => v.severity === 'error').length],
        ['자동검증 경고',c.validation.filter((v) => v.severity === 'warning').length],
        ['증빙파일','원본 미포함 · 연결목록과 SHA-256 제공'],
      ];
      return csvFromRows(columns(['항목','item'],['내용','value']), rows.map(([item,value]) => ({ item,value })));
    },
    staticRowCount: () => 14,
  },
  {
    key: 'profile', fileName: '01_세무기본정보.csv', contentType: 'text/csv; charset=utf-8',
    columns: columns(['회계연도','fiscal_year'],['회계조직','entity_name'],['법인·단체명','legal_name'],['단체유형','organization_type'],
      ['등록번호','registration_no'],['법인등록번호','corporate_registration_no'],['공익법인','public_interest_status'],
      ['기부금단체자격','qualified_donation_status'],['자격시작','qualified_from'],['자격종료','qualified_to'],
      ['수익사업','revenue_business_enabled'],['부가가치세유형','vat_business_type'],['신고주기','vat_reporting_cycle'],
      ['원천징수','withholding_enabled'],['종교인소득처리','religious_income_method'],['전자기부금의무','electronic_donation_required'],
      ['세무대리인','tax_agent_name'],['연락처','tax_agent_contact'],['전자우편','tax_agent_email'],['상태','profile_status'],
      ['개정번호','revision_no'],['변경사유','change_reason']),
    query: (c) => ({
      sql: `SELECT p.id AS row_key,p.*,COALESCE(e.name,p.entity_id) AS entity_name
        FROM accounting_tax_profiles p LEFT JOIN accounting_entities e ON e.id=p.entity_id
        WHERE p.fiscal_year=? AND p.created_at<=? AND p.updated_at<=?${c.entityId ? ' AND p.entity_id=?' : ''}`,
      values: [c.year,c.snapshotAt,c.snapshotAt,...(c.entityId ? [c.entityId] : [])],
    }),
  },
  {
    key: 'budget', fileName: '02_예산집행.csv', contentType: 'text/csv; charset=utf-8',
    columns: columns(['회계구분','book_type_name'],['회계조직','entity_name'],['재원','fund_name'],['부서','department'],['사업','project'],
      ['계정코드','account_code'],['계정과목','account_name'],['본예산','original_amount'],['추경','supplementary_amount'],
      ['전용증가','transfer_in'],['전용감소','transfer_out'],['현예산','revised_amount'],['집행액','executed_amount'],['잔액','remaining_amount']),
    query: (c) => { const d=dimensionFilter('b',c),execution=journalBase(c,c.balanceStart); return {
      sql: `WITH execution AS (
          SELECT book_type_code,entity_id,fund_id,account_code,department,project,SUM(debit-credit) AS executed_amount
          FROM (${execution.sql}) GROUP BY book_type_code,entity_id,fund_id,account_code,department,project
        ) SELECT b.id AS row_key,b.*,a.name AS account_name,COALESCE(bt.name,b.book_type_code) AS book_type_name,
        COALESCE(e.name,b.entity_id) AS entity_name,COALESCE(f.name,b.fund_id) AS fund_name,
        (b.original_amount+b.supplementary_amount+b.transfer_in-b.transfer_out) AS revised_amount,
        COALESCE(x.executed_amount,0) AS executed_amount,
        (b.original_amount+b.supplementary_amount+b.transfer_in-b.transfer_out)-COALESCE(x.executed_amount,0) AS remaining_amount
        FROM accounting_budget_plans b JOIN accounting_accounts a ON a.code=b.account_code
        LEFT JOIN execution x ON x.book_type_code=b.book_type_code AND x.entity_id=b.entity_id AND x.fund_id=b.fund_id
          AND x.account_code=b.account_code AND x.department=b.department AND x.project=b.project
        LEFT JOIN accounting_book_types bt ON bt.code=b.book_type_code LEFT JOIN accounting_entities e ON e.id=b.entity_id
        LEFT JOIN accounting_funds f ON f.id=b.fund_id
        WHERE b.fiscal_year=? AND b.created_at<=? AND b.updated_at<=?${d.sql}`,
      values: [...execution.values,c.year,c.snapshotAt,c.snapshotAt,...d.values],
    }; },
  },
  {
    key: 'resolutions', fileName: '03_결의서.csv', contentType: 'text/csv; charset=utf-8',
    columns: columns(['결의번호','resolution_no'],['구분','resolution_type'],['일자','resolution_date'],['제목','title'],['거래처·납부자','counterparty'],
      ['회계구분','book_type_name'],['회계조직','entity_name'],['재원','fund_name'],['부서','department'],['사업','project'],
      ['계정코드','account_code'],['계정과목','account_name'],['입출금·미지급계정','settlement_account'],['금액','amount'],
      ['세액','tax_amount'],['지급방법','payment_method'],['문서번호','document_id'],['상태','status'],['전표ID','journal_id']),
    query: (c) => { const d=dimensionFilter('d',c); return {
      sql: `SELECT r.id AS row_key,r.*,a.name AS account_name,
        r.settlement_account_code||' '||COALESCE(s.name,'') AS settlement_account,
        COALESCE(bt.name,COALESCE(NULLIF(d.book_type_code,''),'general')) AS book_type_name,
        COALESCE(e.name,COALESCE(NULLIF(d.entity_id,''),'ENTITY-HQ')) AS entity_name,COALESCE(f.name,COALESCE(d.fund_id,'')) AS fund_name
        FROM accounting_resolutions r LEFT JOIN accounting_resolution_dimensions d ON d.resolution_id=r.id
        LEFT JOIN accounting_accounts a ON a.code=r.account_code LEFT JOIN accounting_accounts s ON s.code=r.settlement_account_code
        LEFT JOIN accounting_book_types bt ON bt.code=COALESCE(NULLIF(d.book_type_code,''),'general')
        LEFT JOIN accounting_entities e ON e.id=COALESCE(NULLIF(d.entity_id,''),'ENTITY-HQ') LEFT JOIN accounting_funds f ON f.id=d.fund_id
        WHERE r.resolution_date>=? AND r.resolution_date<=? AND r.created_at<=? AND r.updated_at<=?${d.sql}`,
      values: [c.periodStart,c.periodEnd,c.snapshotAt,c.snapshotAt,...d.values],
    }; },
  },
  {
    key: 'journal', fileName: '04_분개장.csv', contentType: 'text/csv; charset=utf-8',
    columns: columns(['전표번호','journal_no'],['일자','journal_date'],['원천구분','source_type'],['원천번호','source_id'],['적요','description'],
      ['행번호','line_no'],['계정코드','account_code'],['계정과목','account_name'],['계정유형','account_type'],['회계구분','book_type_name'],
      ['회계조직','entity_name'],['재원','fund_name'],['부서','department'],['사업','project'],['거래처','counterparty'],
      ['차변','debit'],['대변','credit'],['문서번호','document_id'],['전표상태','status']),
    query: (c) => journalBase(c,c.periodStart),
  },
  {
    key: 'ledger', fileName: '05_총계정원장.csv', contentType: 'text/csv; charset=utf-8',
    columns: columns(['전표번호','journal_no'],['일자','journal_date'],['원천구분','source_type'],['원천번호','source_id'],['적요','description'],
      ['행번호','line_no'],['계정코드','account_code'],['계정과목','account_name'],['계정유형','account_type'],['회계구분','book_type_name'],
      ['회계조직','entity_name'],['재원','fund_name'],['부서','department'],['사업','project'],['거래처','counterparty'],
      ['차변','debit'],['대변','credit'],['기간초잔액','opening_balance'],['누계잔액','running_balance'],['전표상태','status']),
    query: (c) => { const base=journalBase(c,c.balanceStart); return {
      sql: `WITH base AS (${base.sql}), calculated AS (
        SELECT base.*,
          SUM(CASE WHEN normal_side='debit' THEN debit-credit ELSE credit-debit END)
            OVER (PARTITION BY account_code ORDER BY journal_date,created_at,journal_no,line_no,line_id ROWS UNBOUNDED PRECEDING) AS running_balance,
          SUM(CASE WHEN journal_date<? THEN CASE WHEN normal_side='debit' THEN debit-credit ELSE credit-debit END ELSE 0 END)
            OVER (PARTITION BY account_code) AS opening_balance
        FROM base
      ) SELECT * FROM calculated WHERE journal_date>=?`,
      values: [...base.values,c.periodStart,c.periodStart],
    }; },
  },
  {
    key: 'trial', fileName: '06_합계잔액시산표.csv', contentType: 'text/csv; charset=utf-8',
    columns: columns(['계정코드','code'],['계정과목','name'],['계정유형','account_type'],['정상잔액','normal_side'],['차변합계','debit'],['대변합계','credit'],['잔액','balance']),
    query: (c) => { const base=journalBase(c,c.balanceStart); return {
      sql: `WITH base AS (${base.sql}), totals AS (SELECT account_code,SUM(debit) AS debit,SUM(credit) AS credit FROM base GROUP BY account_code)
        SELECT a.code AS row_key,a.code,a.name,a.account_type,a.normal_side,COALESCE(t.debit,0) AS debit,COALESCE(t.credit,0) AS credit,
          CASE WHEN a.normal_side='debit' THEN COALESCE(t.debit,0)-COALESCE(t.credit,0) ELSE COALESCE(t.credit,0)-COALESCE(t.debit,0) END AS balance
        FROM accounting_accounts a LEFT JOIN totals t ON t.account_code=a.code WHERE a.active=1 AND a.updated_at<=?`,
      values: [...base.values,c.snapshotAt],
    }; },
  },
  {
    key: 'balance-sheet', fileName: '07_재무상태표.csv', contentType: 'text/csv; charset=utf-8',
    columns: columns(['구분','account_type'],['계정코드','code'],['계정과목','name'],['차변합계','debit'],['대변합계','credit'],['잔액','balance']),
    query: (c) => { const base=journalBase(c,c.balanceStart); return {
      sql: `WITH base AS (${base.sql}), totals AS (SELECT account_code,SUM(debit) AS debit,SUM(credit) AS credit FROM base GROUP BY account_code)
        SELECT a.code AS row_key,a.code,a.name,a.account_type,COALESCE(t.debit,0) AS debit,COALESCE(t.credit,0) AS credit,
          CASE WHEN a.normal_side='debit' THEN COALESCE(t.debit,0)-COALESCE(t.credit,0) ELSE COALESCE(t.credit,0)-COALESCE(t.debit,0) END AS balance
        FROM accounting_accounts a LEFT JOIN totals t ON t.account_code=a.code
        WHERE a.active=1 AND a.account_type IN ('asset','liability','equity') AND a.updated_at<=?`,
      values: [...base.values,c.snapshotAt],
    }; },
  },
  {
    key: 'performance', fileName: '08_운영성과표.csv', contentType: 'text/csv; charset=utf-8',
    columns: columns(['구분','account_type'],['계정코드','code'],['계정과목','name'],['금액','balance']),
    query: (c) => { const base=journalBase(c,c.periodStart); return {
      sql: `WITH base AS (${base.sql}), totals AS (
          SELECT account_code,SUM(debit) AS debit,SUM(credit) AS credit FROM base GROUP BY account_code
        ), rows AS (
          SELECT 'A|'||a.code AS row_key,a.code,a.name,a.account_type,
            CASE WHEN a.normal_side='debit' THEN COALESCE(t.debit,0)-COALESCE(t.credit,0) ELSE COALESCE(t.credit,0)-COALESCE(t.debit,0) END AS balance
          FROM accounting_accounts a LEFT JOIN totals t ON t.account_code=a.code
          WHERE a.active=1 AND a.account_type IN ('revenue','expense') AND a.updated_at<=?
        ) SELECT * FROM rows UNION ALL SELECT 'Z|NET','', '수입 합계 - 지출 합계','당기수지',
          COALESCE(SUM(CASE WHEN account_type='revenue' THEN balance ELSE -balance END),0) FROM rows`,
      values: [...base.values,c.snapshotAt],
    }; },
  },
  {
    key: 'dimensions', fileName: '09_회계구분조직재원_요약.csv', contentType: 'text/csv; charset=utf-8',
    columns: columns(['회계구분','book_type_name'],['회계조직','entity_name'],['재원','fund_name'],['수입','income'],['지출','expense'],
      ['당기수지','net'],['자산','asset'],['부채','liability'],['순자산','equity']),
    query: (c) => { const base=journalBase(c,c.periodStart); return {
      sql: `WITH base AS (${base.sql}) SELECT json_array(book_type_code,entity_id,fund_id) AS row_key,
        MAX(book_type_name) AS book_type_name,MAX(entity_name) AS entity_name,MAX(fund_name) AS fund_name,
        SUM(CASE WHEN account_type='revenue' THEN credit-debit ELSE 0 END) AS income,
        SUM(CASE WHEN account_type='expense' THEN debit-credit ELSE 0 END) AS expense,
        SUM(CASE WHEN account_type='revenue' THEN credit-debit WHEN account_type='expense' THEN credit-debit ELSE 0 END) AS net,
        SUM(CASE WHEN account_type='asset' THEN debit-credit ELSE 0 END) AS asset,
        SUM(CASE WHEN account_type='liability' THEN credit-debit ELSE 0 END) AS liability,
        SUM(CASE WHEN account_type='equity' THEN credit-debit ELSE 0 END) AS equity
        FROM base GROUP BY book_type_code,entity_id,fund_id`, values: base.values,
    }; },
  },
  {
    key: 'reconciliation', fileName: '10_통장카드_대사.csv', contentType: 'text/csv; charset=utf-8',
    columns: columns(['가져오기번호','batch_no'],['원본파일','original_filename'],['자료유형','source_type'],['거래일','transaction_date'],
      ['입출금','direction'],['거래내용','description'],['거래처','counterparty'],['금액','amount'],['세액','tax_amount'],['잔액','balance'],
      ['승인번호','approval_no'],['분류계정','classification_account_code'],['대사상태','status'],['연결유형','matched_type'],
      ['연결번호','matched_id'],['대사자','matched_by'],['대사일','matched_at']),
    query: (c) => { const d=dimensionFilter('x',c); return {
      sql: `SELECT x.id AS row_key,x.* FROM (SELECT t.*,ib.batch_no,ib.original_filename,
        COALESCE(NULLIF(ba.book_type_code,''),NULLIF(card.book_type_code,''),'general') AS book_type_code,
        COALESCE(NULLIF(ba.entity_id,''),NULLIF(card.entity_id,''),'ENTITY-HQ') AS entity_id,COALESCE(ba.fund_id,'') AS fund_id
        FROM accounting_import_transactions t JOIN accounting_import_batches ib ON ib.id=t.batch_id
        LEFT JOIN accounting_bank_accounts ba ON t.source_type='bank' AND ba.id=ib.source_account_id
        LEFT JOIN accounting_cards card ON t.source_type='card' AND card.id=ib.source_account_id
        WHERE t.transaction_date>=? AND t.transaction_date<=? AND t.created_at<=? AND t.updated_at<=?) x WHERE 1=1${d.sql}`,
      values: [c.periodStart,c.periodEnd,c.snapshotAt,c.snapshotAt,...d.values],
    }; },
  },
  {
    key: 'card-use', fileName: '11_법인카드사용.csv', contentType: 'text/csv; charset=utf-8',
    columns: columns(['사용번호','transaction_no'],['사용일','transaction_date'],['카드코드','card_code'],['카드명','card_label'],['카드사','issuer'],
      ['마스킹번호','masked_number'],['가맹점','merchant'],['합계금액','amount'],['세액','tax_amount'],['지출계정','account_code'],
      ['미지급계정','settlement_account_code'],['회계조직','entity_name'],['재원','fund_name'],['부서','department'],['사업','project'],
      ['전표번호','journal_id'],['사용상태','status'],['전표상태','journal_status']),
    query: (c) => { const d=dimensionFilter('t',c); return {
      sql: `SELECT t.id AS row_key,t.*,card.card_code,card.card_label,card.issuer,card.masked_number,card.settlement_account_code,
        COALESCE(e.name,t.entity_id) AS entity_name,COALESCE(f.name,t.fund_id) AS fund_name,j.status AS journal_status
        FROM accounting_card_transactions t JOIN accounting_cards card ON card.id=t.card_id
        LEFT JOIN accounting_entities e ON e.id=t.entity_id LEFT JOIN accounting_funds f ON f.id=t.fund_id
        LEFT JOIN accounting_journals j ON j.id=t.journal_id
        WHERE t.transaction_date>=? AND t.transaction_date<=? AND t.created_at<=? AND t.updated_at<=?${d.sql}`,
      values: [c.periodStart,c.periodEnd,c.snapshotAt,c.snapshotAt,...d.values],
    }; },
  },
  {
    key: 'card-payment', fileName: '12_법인카드대금결제.csv', contentType: 'text/csv; charset=utf-8',
    columns: columns(['결제번호','payment_no'],['결제일','payment_date'],['카드코드','card_code'],['카드명','card_label'],['카드사','issuer'],
      ['마스킹번호','masked_number'],['결제금액','amount'],['미지급계정','payable_account_code'],['출금계정','bank_account_code'],
      ['회계조직','entity_name'],['재원','fund_name'],['전표번호','journal_id'],['전표상태','journal_status'],['메모','memo'],['등록자','created_by']),
    query: (c) => { const d=dimensionFilter('p',c); return {
      sql: `SELECT p.id AS row_key,p.*,card.card_code,card.card_label,card.issuer,card.masked_number,
        COALESCE(e.name,p.entity_id) AS entity_name,COALESCE(f.name,p.fund_id) AS fund_name,j.status AS journal_status
        FROM accounting_card_payments p JOIN accounting_cards card ON card.id=p.card_id
        LEFT JOIN accounting_entities e ON e.id=p.entity_id LEFT JOIN accounting_funds f ON f.id=p.fund_id
        JOIN accounting_journals j ON j.id=p.journal_id
        WHERE p.payment_date>=? AND p.payment_date<=? AND p.created_at<=?${d.sql}`,
      values: [c.periodStart,c.periodEnd,c.snapshotAt,...d.values],
    }; },
  },
  {
    key: 'vendors', fileName: '13_거래처.csv', contentType: 'text/csv; charset=utf-8',
    columns: columns(['거래처코드','vendor_code'],['거래처명','name'],['사업자번호','business_no'],['대표자','representative'],['담당자','contact_name'],
      ['연락처','phone'],['전자우편','email'],['주소','address'],['은행','bank_name'],['마스킹계좌','bank_account_masked'],
      ['예금주','bank_account_holder'],['이해충돌확인일','conflict_checked_at'],['이해충돌메모','conflict_note'],['활성','active']),
    query: (c) => { const scoped=scopedVendorPredicate('vendor',c); return {
      sql: `SELECT vendor.id AS row_key,vendor.* FROM accounting_vendors vendor
        WHERE vendor.created_at<=? AND vendor.updated_at<=? AND ${scoped.sql}`,
      values: [c.snapshotAt,c.snapshotAt,...scoped.values],
    }; },
  },
  {
    key: 'contracts', fileName: '14_계약지급.csv', contentType: 'text/csv; charset=utf-8',
    columns: columns(['계약번호','contract_no'],['거래처코드','vendor_code'],['거래처명','vendor_name'],['사업자번호','business_no'],['계약명','title'],
      ['계약유형','contract_type'],['계약방법','procurement_method'],['계약금액','contract_amount'],['계약일','contract_date'],['시작일','start_date'],
      ['종료일','end_date'],['부서','department'],['사업','project'],['계정코드','account_code'],['회계구분','book_type_code'],
      ['회계조직','entity_id'],['재원','fund_id'],['계약상태','status'],['지급회차','payment_seq'],['지급명','payment_name'],
      ['지급예정일','due_date'],['지급금액','payment_amount'],['검수일','inspection_date'],['계산서일','invoice_date'],
      ['결의번호','resolution_id'],['전표번호','journal_id'],['지급상태','payment_status'],['지급일','paid_at']),
    query: (c) => { const d=dimensionFilter('contract',c); return {
      sql: `SELECT contract.id||'|'||COALESCE(payment.id,'') AS row_key,contract.*,vendor.vendor_code,vendor.name AS vendor_name,vendor.business_no,
        payment.payment_seq,payment.payment_name,payment.due_date,payment.amount AS payment_amount,payment.inspection_date,
        payment.invoice_date,payment.resolution_id,payment.journal_id,payment.status AS payment_status,payment.paid_at
        FROM accounting_contracts contract JOIN accounting_vendors vendor ON vendor.id=contract.vendor_id
        LEFT JOIN accounting_contract_payments payment ON payment.contract_id=contract.id AND payment.created_at<=? AND payment.updated_at<=?
        WHERE contract.contract_date<=? AND contract.end_date>=? AND contract.created_at<=? AND contract.updated_at<=?${d.sql}`,
      values: [c.snapshotAt,c.snapshotAt,c.periodEnd,c.periodStart,c.snapshotAt,c.snapshotAt,...d.values],
    }; },
  },
  {
    key: 'donations', fileName: '15_기부금영수증.csv', contentType: 'text/csv; charset=utf-8',
    columns: columns(['기부번호','donation_no'],['기부일','donation_date'],['후원자번호','donor_no'],['후원자유형','donor_type'],['후원자명','donor_name'],
      ['식별번호(마스킹)','identifier_masked','mask'],['영수증동의','receipt_consent'],['기부유형','donation_category'],['회계구분','book_type_name'],
      ['회계조직','entity_name'],['재원','fund_name'],['금액','amount'],['수납방법','payment_method'],['목적','purpose'],
      ['영수증요청','receipt_requested'],['영수증상태','receipt_status'],['영수증번호','receipt_no'],['발급일','receipt_issued_at'],
      ['취소일','receipt_cancelled_at'],['기부금코드','receipt_donation_code'],['전표번호','journal_id']),
    query: (c) => { const d=dimensionFilter('donation',c); return {
      sql: `SELECT donation.id AS row_key,donation.*,donor.donor_no,donor.donor_type,donor.name AS donor_name,donor.identifier_masked,donor.receipt_consent,
        COALESCE(e.name,donation.entity_id) AS entity_name,COALESCE(f.name,donation.fund_id) AS fund_name,
        COALESCE(b.name,donation.book_type_code) AS book_type_name
        FROM accounting_donations donation LEFT JOIN accounting_donors donor ON donor.id=donation.donor_id
        LEFT JOIN accounting_entities e ON e.id=donation.entity_id LEFT JOIN accounting_funds f ON f.id=donation.fund_id
        LEFT JOIN accounting_book_types b ON b.code=donation.book_type_code
        WHERE donation.donation_date>=? AND donation.donation_date<=? AND donation.created_at<=? AND donation.updated_at<=?${d.sql}`,
      values: [c.periodStart,c.periodEnd,c.snapshotAt,c.snapshotAt,...d.values],
    }; },
  },
  {
    key: 'assets', fileName: '16_자산감가상각.csv', contentType: 'text/csv; charset=utf-8',
    columns: columns(['자산번호','asset_no'],['자산명','name'],['분류','category'],['취득일','acquisition_date'],['취득가액','acquisition_cost'],
      ['내용연수개월','useful_life_months'],['감가상각방법','depreciation_method'],['잔존가액','residual_value'],
      ['감가상각누계추정','estimated_accumulated'],['장부가액추정','estimated_book_value'],['회계구분','book_type_name'],
      ['회계조직','entity_name'],['재원','fund_name'],['부서','department'],['보관장소','location'],['관리책임자','custodian'],
      ['자산계정','asset_account_code'],['상태','status'],['처분일','disposal_date'],['처분금액','disposal_amount']),
    query: (c) => { const d=dimensionFilter('asset',c); return {
      sql: `SELECT asset.id AS row_key,asset.*,COALESCE(e.name,asset.entity_id) AS entity_name,COALESCE(f.name,asset.fund_id) AS fund_name,
        COALESCE(b.name,asset.book_type_code) AS book_type_name,
        CASE WHEN asset.depreciation_method='nondepreciable' OR asset.useful_life_months<=0 THEN 0 ELSE MIN(asset.acquisition_cost-asset.residual_value,
          ROUND((asset.acquisition_cost-asset.residual_value)*MIN(asset.useful_life_months,MAX(0,
            (CAST(substr(?,1,4) AS INTEGER)-CAST(substr(asset.acquisition_date,1,4) AS INTEGER))*12
            +CAST(substr(?,6,2) AS INTEGER)-CAST(substr(asset.acquisition_date,6,2) AS INTEGER)+1))*1.0/asset.useful_life_months)) END AS estimated_accumulated,
        asset.acquisition_cost-CASE WHEN asset.depreciation_method='nondepreciable' OR asset.useful_life_months<=0 THEN 0 ELSE MIN(asset.acquisition_cost-asset.residual_value,
          ROUND((asset.acquisition_cost-asset.residual_value)*MIN(asset.useful_life_months,MAX(0,
            (CAST(substr(?,1,4) AS INTEGER)-CAST(substr(asset.acquisition_date,1,4) AS INTEGER))*12
            +CAST(substr(?,6,2) AS INTEGER)-CAST(substr(asset.acquisition_date,6,2) AS INTEGER)+1))*1.0/asset.useful_life_months)) END AS estimated_book_value
        FROM accounting_assets asset LEFT JOIN accounting_entities e ON e.id=asset.entity_id LEFT JOIN accounting_funds f ON f.id=asset.fund_id
        LEFT JOIN accounting_book_types b ON b.code=asset.book_type_code
        WHERE asset.acquisition_date<=? AND (asset.disposal_date IS NULL OR asset.disposal_date>=?)
          AND asset.created_at<=? AND asset.updated_at<=?${d.sql}`,
      values: [c.periodEnd,c.periodEnd,c.periodEnd,c.periodEnd,c.periodEnd,c.periodStart,c.snapshotAt,c.snapshotAt,...d.values],
    }; },
  },
  {
    key: 'vat', fileName: '17_부가가치세.csv', contentType: 'text/csv; charset=utf-8',
    columns: columns(['거래일','transaction_date'],['매입매출','direction'],['원자료유형','source_type'],['원자료번호','source_id'],
      ['분할순번','source_line_no'],['정정대상','supersedes_id'],['버전','version_no'],['회계구분','book_type_name'],['회계조직','entity_name'],
      ['재원','fund_name'],['거래처','counterparty_name'],['사업자번호','counterparty_business_no'],['증빙유형','evidence_type'],
      ['증빙번호','evidence_no'],['합계금액','total_amount'],['공급가액','supply_amount'],['부가가치세','vat_amount'],['과세유형','tax_type'],
      ['공제여부','deduction_status'],['불공제사유','non_deductible_reason'],['신고기간','filing_period'],['상태','status'],
      ['조정전표','adjustment_journal_id'],['취소사유','cancellation_reason'],['확정자','confirmed_by'],['확정일','confirmed_at']),
    query: (c) => { const d=dimensionFilter('vat',c); return {
      sql: `SELECT vat.id AS row_key,vat.*,COALESCE(e.name,vat.entity_id) AS entity_name,COALESCE(f.name,vat.fund_id) AS fund_name,
        COALESCE(b.name,vat.book_type_code) AS book_type_name FROM accounting_vat_records vat
        LEFT JOIN accounting_entities e ON e.id=vat.entity_id LEFT JOIN accounting_funds f ON f.id=vat.fund_id
        LEFT JOIN accounting_book_types b ON b.code=vat.book_type_code
        WHERE vat.transaction_date>=? AND vat.transaction_date<=? AND vat.created_at<=? AND vat.updated_at<=?${d.sql}`,
      values: [c.periodStart,c.periodEnd,c.snapshotAt,c.snapshotAt,...d.values],
    }; },
  },
  {
    key: 'withholding', fileName: '18_원천징수.csv', contentType: 'text/csv; charset=utf-8',
    columns: columns(['지급번호','payment_no'],['지급일','payment_date'],['지급대상자번호','payee_no'],['유형','payee_type'],['성명','payee_name'],
      ['식별번호(마스킹)','identifier_masked','mask'],['사업자번호','business_no'],['거주구분','resident_status'],['소득구분','income_type'],
      ['종교인소득처리','religious_income_method'],['결의번호','resolution_no'],['회계구분','book_type_name'],['회계조직','entity_name'],
      ['재원','fund_name'],['총지급액','gross_amount'],['비과세액','tax_exempt_amount'],['필요경비','necessary_expense'],
      ['과세대상액','taxable_amount'],['소득세','income_tax'],['지방소득세','local_income_tax'],['기타공제','other_deduction'],
      ['실지급액','net_amount'],['귀속신고월','filing_month'],['신고납부기한','filing_due_date'],['신고상태','filing_status'],
      ['공제계상전표','accrual_journal_id'],['세금납부전표','payment_journal_id'],['세금출금계정','tax_payment_bank_account_code'],
      ['정정대상','supersedes_id'],['버전','version_no'],['연결확인메모','source_verification_note'],['취소사유','cancellation_reason'],
      ['신고일','filed_at'],['납부일','paid_at']),
    query: (c) => { const d=dimensionFilter('w',c); return {
      sql: `SELECT w.id AS row_key,w.*,p.payee_no,p.payee_type,p.name AS payee_name,p.identifier_masked,p.business_no,p.resident_status,
        COALESCE(e.name,w.entity_id) AS entity_name,COALESCE(f.name,w.fund_id) AS fund_name,
        COALESCE(b.name,w.book_type_code) AS book_type_name,r.resolution_no
        FROM accounting_withholding_records w JOIN accounting_tax_payees p ON p.id=w.payee_id
        LEFT JOIN accounting_entities e ON e.id=w.entity_id LEFT JOIN accounting_funds f ON f.id=w.fund_id
        LEFT JOIN accounting_book_types b ON b.code=w.book_type_code LEFT JOIN accounting_resolutions r ON r.id=w.source_resolution_id
        WHERE w.payment_date>=? AND w.payment_date<=? AND w.created_at<=? AND w.updated_at<=?${d.sql}`,
      values: [c.periodStart,c.periodEnd,c.snapshotAt,c.snapshotAt,...d.values],
    }; },
  },
  {
    key: 'attachments', fileName: '19_증빙연결목록.csv', contentType: 'text/csv; charset=utf-8',
    columns: columns(['자료유형','reference_type'],['자료ID','reference_id'],['파일명','original_filename'],['파일분류','file_category'],
      ['콘텐츠유형','content_type'],['크기Byte','size_bytes'],['SHA-256','checksum_sha256'],['등록자','uploaded_by'],['등록일','uploaded_at'],
      ['보존기한','retention_until'],['검사상태','scan_status'],['검사메시지','scan_message']),
    query: attachmentQuery,
  },
  {
    key: 'validation', fileName: '20_자동검증결과.csv', contentType: 'text/csv; charset=utf-8',
    columns: columns(['심각도','severity'],['검증코드','code'],['검증항목','title'],['건수','count'],['상세','detail']),
    staticText: (c) => csvFromRows(columns(['심각도','severity'],['검증코드','code'],['검증항목','title'],['건수','count'],['상세','detail']), c.validation as any[]),
    staticRowCount: (c) => c.validation.length,
  },
  {
    key: 'readme', fileName: 'README.txt', contentType: 'text/plain; charset=utf-8',
    staticText: (c) => [
      '대한불교밀교종 세무사 제출 패키지',
      `생성번호: ${c.exportNo}`,
      `스냅샷시각(UTC): ${c.snapshotAt}`,
      `대상기간: ${c.periodStart} ~ ${c.periodEnd}`,
      `조회범위: 회계구분 ${c.bookTypeCode || '전체'} · 회계조직 ${c.entityId || '전체'} · 재원 ${c.fundId || '전체'}`,
      '',
      '1. 이 패키지는 세무검토와 신고자료 작성을 돕는 표준 CSV 묶음이며 홈택스 전자신고 파일 자체가 아닙니다.',
      '2. 개인 식별번호 원문은 포함하지 않으며 CSV 수식 실행 문자를 이스케이프했습니다.',
      '3. 증빙 원본은 ZIP에 넣지 않고 연결목록의 파일명·크기·SHA-256으로 대조합니다.',
      '4. 모든 자료는 작업 등록 시각의 스냅샷 경계를 사용하며, 생성 중 변경이 발견되면 패키지를 실패 처리합니다.',
      '5. 각 파일의 전체 행 수·CRC32·SHA-256과 최종 ZIP SHA-256은 manifest.json에서 확인할 수 있습니다.',
      '6. 신고 전 최신 세법·홈택스 서식 및 세무대리인의 최종 분류 판단을 확인하십시오.',
      `7. 시산표 누계기간은 ${c.balanceStart} ~ ${c.periodEnd}, 운영성과표는 ${c.periodStart} ~ ${c.periodEnd}입니다.`,
      '',`차변합계: ${c.totalDebit}`,`대변합계: ${c.totalCredit}`,
    ].join('\r\n'),
    staticRowCount: () => 0,
  },
];

function csvFromRows(csvColumns: CsvColumn[], rows: Array<Record<string, unknown>>) {
  const header = csvColumns.map((column) => csvCell(column.header)).join(',');
  const body = rows.map((row) => csvColumns.map((column) => csvCell(column.maskIdentifier
    ? safePersonalIdentifier(row[column.key]) : row[column.key])).join(',')).join('\r\n');
  return `\uFEFF${header}${body ? `\r\n${body}` : ''}`;
}

const parseContext = (batch: any): ExportContext => {
  const filter = JSON.parse(String(batch.filters_json || '{}'));
  const seed = JSON.parse(String(batch.manifest_json || '{}'));
  return {
    year: Number(batch.fiscal_year), periodStart: String(batch.period_start), periodEnd: String(batch.period_end),
    bookTypeCode: String(batch.book_type_code || ''), entityId: String(batch.entity_id || ''), fundId: String(batch.fund_id || ''),
    allowValidationErrors: filter.allowValidationErrors === true, requestId: String(batch.request_id || ''),
    batchId: String(batch.id), exportNo: String(batch.export_no), snapshotAt: String(batch.snapshot_at),
    balanceStart: String(seed.balanceStart || `${batch.fiscal_year}-01-01`), generatedBy: String(batch.created_by || ''),
    validation: Array.isArray(seed.validation) ? seed.validation : [], totalDebit: Number(batch.total_debit || 0),
    totalCredit: Number(batch.total_credit || 0), asOfDebit: Number(seed.asOfDebit || 0), asOfCredit: Number(seed.asOfCredit || 0),
  };
};

const countDataset = async (db: D1Database, dataset: Dataset, context: ExportContext) => {
  if (dataset.staticText) return Number(dataset.staticRowCount?.(context) || 0);
  const query = dataset.query!(context);
  const row = await db.prepare(`SELECT COUNT(*) AS count FROM (${query.sql}) export_count`)
    .bind(...query.values).first<{ count: number }>();
  return Number(row?.count || 0);
};

const countSnapshotMasterMutations = async (db: D1Database, snapshotAt: string) => {
  const tables = [
    'accounting_book_types','accounting_entities','accounting_funds','accounting_accounts',
    'accounting_resolution_dimensions','accounting_donors','accounting_cards','accounting_bank_accounts',
    'accounting_contract_payments','accounting_tax_payees',
  ];
  const sql = tables.map((table) => `SELECT COUNT(*) AS count FROM ${table} WHERE created_at<=? AND updated_at>?`).join(' UNION ALL ');
  const values = tables.flatMap(() => [snapshotAt,snapshotAt]);
  const row = await db.prepare(`SELECT COALESCE(SUM(count),0) AS count FROM (${sql})`)
    .bind(...values).first<{ count: number }>();
  return Number(row?.count || 0);
};

const streamStatic = (text: string) => {
  const bytes = strToU8(text);
  return { stream: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } }), bytes };
};

const streamQueryCsv = (db: D1Database, dataset: Dataset, context: ExportContext) => {
  const query = dataset.query!(context);
  const csvColumns = dataset.columns || [];
  let lastKey = '';
  let headerSent = false;
  let closed = false;
  let rowCount = 0;
  const sha = new IncrementalSha256();
  let crc32 = 0, sizeBytes = 0;
  const record = (bytes: Uint8Array) => { sha.update(bytes); crc32=updateCrc32(crc32,bytes);sizeBytes+=bytes.byteLength;return bytes; };
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (closed) return;
      if (!headerSent) {
        headerSent = true;
        controller.enqueue(record(encoder.encode(`\uFEFF${csvColumns.map((column) => csvCell(column.header)).join(',')}`)));
        return;
      }
      try {
        const page = await db.prepare(`SELECT * FROM (${query.sql}) export_rows
          WHERE CAST(row_key AS TEXT)>? ORDER BY CAST(row_key AS TEXT) LIMIT ?`)
          .bind(...query.values,lastKey,PAGE_SIZE).all<Record<string,unknown>>();
        const rows = page.results || [];
        if (!rows.length) { closed=true;controller.close();return; }
        const text = rows.map((row) => csvColumns.map((column) => csvCell(column.maskIdentifier
          ? safePersonalIdentifier(row[column.key]) : row[column.key])).join(',')).join('\r\n');
        lastKey = String(rows[rows.length-1].row_key || '');
        rowCount += rows.length;
        controller.enqueue(record(encoder.encode(`\r\n${text}`)));
        if (rows.length < PAGE_SIZE) { closed=true;controller.close(); }
      } catch (error) { closed=true;controller.error(error); }
    },
  });
  return { stream, stats: () => ({ rowCount,sizeBytes,crc32,sha256:sha.digestHex() }) };
};

const sha256Bytes = async (bytes: Uint8Array) => {
  const copy = new Uint8Array(bytes.byteLength); copy.set(bytes);
  const digest = await crypto.subtle.digest('SHA-256',copy.buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2,'0')).join('');
};

const logEvent = (db: D1Database, batchId: string, eventType: string, detail: unknown, now: string) =>
  db.prepare(`INSERT INTO accounting_tax_export_events (id,batch_id,event_type,detail_json,created_at) VALUES (?,?,?,?,?)`)
    .bind(`TAXEV-${randomHex(20)}`,batchId,eventType,JSON.stringify(detail || {}),now);

export const queueTaxExport = async (
  db: D1Database,
  request: TaxExportRequest,
  actor: Pick<SessionUser,'id'|'name'>,
) => {
  const existing = await db.prepare(`SELECT id,export_no,status FROM accounting_tax_export_batches WHERE request_id=?`)
    .bind(request.requestId).first<any>();
  if (existing) return { id: existing.id, exportNo: existing.export_no, status: existing.status, duplicate: true };
  if (!validTaxDate(request.periodStart) || !validTaxDate(request.periodEnd)
    || request.periodStart>request.periodEnd || Number(request.periodStart.slice(0,4))!==request.year
    || Number(request.periodEnd.slice(0,4))!==request.year) {
    throw new Error('회계연도와 제출기간을 같은 연도 안에서 정확히 확인해 주세요.');
  }
  const fiscalYear = await db.prepare(`SELECT start_date,end_date FROM accounting_fiscal_years WHERE year=?`)
    .bind(request.year).first<{ start_date: string; end_date: string }>();
  if (!fiscalYear || request.periodStart<fiscalYear.start_date || request.periodEnd>fiscalYear.end_date) {
    throw new Error('등록된 회계연도 범위 안에서 제출기간을 확인해 주세요.');
  }
  const dimensionStatements: D1PreparedStatement[] = [];
  if (request.bookTypeCode) dimensionStatements.push(db.prepare(`SELECT COUNT(*) AS count FROM accounting_book_types WHERE code=? AND active=1`).bind(request.bookTypeCode));
  if (request.entityId) dimensionStatements.push(db.prepare(`SELECT COUNT(*) AS count FROM accounting_entities WHERE id=? AND active=1`).bind(request.entityId));
  if (request.fundId) dimensionStatements.push(db.prepare(`SELECT COUNT(*) AS count FROM accounting_funds WHERE id=? AND active=1`).bind(request.fundId));
  if (dimensionStatements.length) {
    const checks=await db.batch(dimensionStatements);
    if (checks.some((result)=>Number((result.results?.[0] as any)?.count||0)!==1)) {
      throw new Error('제출범위의 회계구분·회계조직·재원을 확인해 주세요.');
    }
  }
  const snapshotAt = new Date().toISOString();
  const validation = await getTaxValidation(db,request.year,request.entityId);
  const errors = validation.filter((item) => item.severity === 'error');
  const warnings = validation.filter((item) => item.severity === 'warning');
  if (errors.length) {
    const error = new Error(`자동검증 오류 ${errors.length}개를 모두 해결한 뒤 제출 패키지를 생성해 주세요.`) as Error & { validation?: TaxValidationItem[] };
    error.validation = validation;
    throw error;
  }
  const balanceStart = String(fiscalYear?.start_date || `${request.year}-01-01`);
  const context: ExportContext = {
    ...request,batchId:`TAXEXP-${randomHex(20)}`,exportNo:await nextTaxNumber(db,'tax-export',request.year),
    snapshotAt,balanceStart,generatedBy:actor.name,validation,totalDebit:0,totalCredit:0,asOfDebit:0,asOfCredit:0,
  };
  const periodJournal = journalBase(context,request.periodStart);
  const asOfJournal = journalBase(context,balanceStart);
  const [periodTotals,asOfTotals] = await db.batch([
    db.prepare(`SELECT COALESCE(SUM(debit),0) AS debit,COALESCE(SUM(credit),0) AS credit FROM (${periodJournal.sql})`).bind(...periodJournal.values),
    db.prepare(`SELECT COALESCE(SUM(debit),0) AS debit,COALESCE(SUM(credit),0) AS credit FROM (${asOfJournal.sql})`).bind(...asOfJournal.values),
  ]);
  context.totalDebit=Number((periodTotals.results?.[0] as any)?.debit || 0);
  context.totalCredit=Number((periodTotals.results?.[0] as any)?.credit || 0);
  context.asOfDebit=Number((asOfTotals.results?.[0] as any)?.debit || 0);
  context.asOfCredit=Number((asOfTotals.results?.[0] as any)?.credit || 0);
  if (context.totalDebit !== context.totalCredit || context.asOfDebit !== context.asOfCredit) {
    throw new Error('제출범위 전표의 차변·대변 합계가 일치하지 않아 패키지 작업을 등록할 수 없습니다.');
  }
  const expectedCounts = await Promise.all(DATASETS.map((dataset) => countDataset(db,dataset,context)));
  const now = snapshotAt;
  const statements: D1PreparedStatement[] = [
    db.prepare(`INSERT INTO accounting_tax_export_batches
      (id,export_no,fiscal_year,period_start,period_end,book_type_code,entity_id,fund_id,filters_json,file_count,row_count,
       total_debit,total_credit,validation_error_count,validation_warning_count,manifest_json,created_by,created_at,request_id,status,
       snapshot_at,progress_current,progress_total,requested_by_user_id,retention_until)
      VALUES (?,?,?,?,?,?,?,?,?,0,0,?,?,?,?,?,?,?,?,'queued',?,0,?,?,?)`)
      .bind(context.batchId,context.exportNo,request.year,request.periodStart,request.periodEnd,request.bookTypeCode,request.entityId,request.fundId,
        JSON.stringify({ validationErrorsAllowed:false }),context.totalDebit,context.totalCredit,errors.length,warnings.length,
        JSON.stringify({ schemaVersion:TAX_SCHEMA_VERSION,balanceStart,asOfDebit:context.asOfDebit,asOfCredit:context.asOfCredit,validation }),
        actor.name,now,request.requestId,snapshotAt,DATASETS.length+1,actor.id,
        new Date(Date.UTC(request.year+RETENTION_YEARS,11,31,14,59,59)).toISOString()),
    logEvent(db,context.batchId,'queued',{ expectedCounts,snapshotAt },now),
  ];
  DATASETS.forEach((dataset,index) => {
    const objectKey=`${EXPORT_PREFIX}/${request.year}/${context.batchId}/files/${String(index).padStart(2,'0')}-${dataset.key}`;
    statements.push(db.prepare(`INSERT INTO accounting_tax_export_files
      (id,batch_id,sequence_no,dataset_key,file_name,object_key,content_type,expected_row_count,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?, 'pending',?,?)`)
      .bind(`TAXFILE-${randomHex(20)}`,context.batchId,index,dataset.key,dataset.fileName,objectKey,dataset.contentType,expectedCounts[index],now,now));
  });
  await db.batch(statements);
  return { id:context.batchId,exportNo:context.exportNo,status:'queued',duplicate:false,progressCurrent:0,progressTotal:DATASETS.length+1 };
};

const processDataset = async (db: D1Database,bucket:R2Bucket,batch:any,file:any) => {
  const context=parseContext(batch);
  const dataset=DATASETS.find((item) => item.key===file.dataset_key);
  if (!dataset) throw new Error(`알 수 없는 제출자료 데이터셋입니다: ${file.dataset_key}`);
  const now=new Date().toISOString();
  await db.prepare(`UPDATE accounting_tax_export_files SET status='processing',updated_at=?,error_message=NULL WHERE id=? AND status='pending'`)
    .bind(now,file.id).run();
  let rowCount=0,sizeBytes=0,crc32=0,sha256='';
  try {
    if (dataset.staticText) {
      const {stream,bytes}=streamStatic(dataset.staticText(context));
      const object=await bucket.put(file.object_key,stream,{httpMetadata:{contentType:dataset.contentType}});
      rowCount=Number(dataset.staticRowCount?.(context)||0);sizeBytes=bytes.byteLength;crc32=updateCrc32(0,bytes);sha256=await sha256Bytes(bytes);
      file.etag=object?.etag || object?.httpEtag || '';
    } else {
      const generated=streamQueryCsv(db,dataset,context);
      const object=await bucket.put(file.object_key,generated.stream,{httpMetadata:{contentType:dataset.contentType}});
      const stats=generated.stats();rowCount=stats.rowCount;sizeBytes=stats.sizeBytes;crc32=stats.crc32;sha256=stats.sha256;
      file.etag=object?.etag || object?.httpEtag || '';
    }
    if (rowCount!==Number(file.expected_row_count||0)) {
      throw new Error(`${dataset.fileName} 스냅샷 행 수가 변경되었습니다. 예상 ${file.expected_row_count}건, 생성 ${rowCount}건입니다.`);
    }
    const completedAt=new Date().toISOString();
    await db.batch([
      db.prepare(`UPDATE accounting_tax_export_files SET status='ready',row_count=?,size_bytes=?,crc32=?,sha256=?,etag=?,
        updated_at=?,completed_at=? WHERE id=?`).bind(rowCount,sizeBytes,crc32,sha256,file.etag||null,completedAt,completedAt,file.id),
      db.prepare(`UPDATE accounting_tax_export_batches SET progress_current=progress_current+1,last_heartbeat_at=? WHERE id=?`)
        .bind(completedAt,batch.id),
      logEvent(db,batch.id,'file-ready',{dataset:dataset.key,rowCount,sizeBytes,sha256},completedAt),
    ]);
  } catch (error) {
    await bucket.delete(file.object_key).catch(()=>undefined);
    throw error;
  }
};

const zipFiles = (bucket:R2Bucket,files:any[]) => {
  const sha=new IncrementalSha256();let sizeBytes=0;
  const stream=new ReadableStream<Uint8Array>({
    start(controller) {
      const zip=new Zip((error,data,final) => {
        if (error) { controller.error(error);return; }
        if (data?.byteLength) { sha.update(data);sizeBytes+=data.byteLength;controller.enqueue(data); }
        if (final) controller.close();
      });
      void (async()=>{
        for (const file of files) {
          const objectKey=assertR2KeyWithinPrefixes(file.object_key,[TAX_EXPORT_R2_PREFIX],'세무 패키지 구성파일 읽기');
          const object=await bucket.get(objectKey);
          if (!object) throw new Error(`패키지 구성파일이 R2에서 누락되었습니다: ${file.file_name}`);
          const entry=new ZipPassThrough(file.file_name);
          zip.add(entry);
          const reader=object.body.getReader();
          while (true) { const part=await reader.read();if(part.done)break;if(part.value)entry.push(part.value,false); }
          entry.push(new Uint8Array(0),true);
        }
        zip.end();
      })().catch((error)=>controller.error(error));
    },
  });
  return {stream,stats:()=>({sizeBytes,sha256:sha.digestHex()})};
};

const finalizeBatch = async (db:D1Database,bucket:R2Bucket,batch:any) => {
  const context=parseContext(batch);
  const existingFiles=await db.prepare(`SELECT * FROM accounting_tax_export_files
    WHERE batch_id=? AND status='ready' AND dataset_key<>'manifest' ORDER BY sequence_no`)
    .bind(batch.id).all<any>();
  const files=existingFiles.results||[];
  if (files.length!==DATASETS.length) throw new Error('제출자료 파일 생성 상태가 완전하지 않아 패키지를 확정할 수 없습니다.');
  const masterMutations=await countSnapshotMasterMutations(db,context.snapshotAt);
  if (masterMutations) {
    throw new Error(`스냅샷 기준시각 이전 원본·코드자료 ${masterMutations}건이 생성 중 변경되어 패키지를 확정할 수 없습니다.`);
  }
  for (let index=0;index<DATASETS.length;index+=1) {
    const current=await countDataset(db,DATASETS[index],context);
    if (current!==Number(files[index].expected_row_count||0)) {
      throw new Error(`${files[index].file_name} 원자료가 스냅샷 생성 후 변경되어 패키지를 확정할 수 없습니다.`);
    }
  }
  const rowCount=files.reduce((sum,file)=>sum+Number(file.row_count||0),0);
  const manifest={
    schemaVersion:TAX_SCHEMA_VERSION,exportNo:context.exportNo,snapshotAt:context.snapshotAt,generatedBy:context.generatedBy,
    fiscalYear:context.year,periodStart:context.periodStart,periodEnd:context.periodEnd,
    filters:{bookTypeCode:context.bookTypeCode,entityId:context.entityId,fundId:context.fundId},
    integrity:{totalDebit:context.totalDebit,totalCredit:context.totalCredit,balanced:context.totalDebit===context.totalCredit,
      asOfDebit:context.asOfDebit,asOfCredit:context.asOfCredit,balanceStart:context.balanceStart,balanceEnd:context.periodEnd,rowCount,
      validationErrors:context.validation.filter((item)=>item.severity==='error').length,
      validationWarnings:context.validation.filter((item)=>item.severity==='warning').length},
    files:files.map((file)=>({name:file.file_name,sizeBytes:Number(file.size_bytes),rowCount:Number(file.row_count),
      crc32:Number(file.crc32)>>>0,sha256:file.sha256,etag:file.etag})),
  };
  const manifestBytes=strToU8(JSON.stringify(manifest,null,2));
  const manifestKey=`${EXPORT_PREFIX}/${context.year}/${batch.id}/files/22-manifest`;
  const manifestObject=await bucket.put(manifestKey,manifestBytes,{httpMetadata:{contentType:'application/json; charset=utf-8'}});
  const manifestFile={
    id:`TAXFILE-${randomHex(20)}`,batch_id:batch.id,sequence_no:DATASETS.length,dataset_key:'manifest',file_name:'manifest.json',
    object_key:manifestKey,content_type:'application/json; charset=utf-8',expected_row_count:0,row_count:0,size_bytes:manifestBytes.byteLength,
    crc32:updateCrc32(0,manifestBytes),sha256:await sha256Bytes(manifestBytes),etag:manifestObject?.etag||manifestObject?.httpEtag||'',status:'ready',
  };
  const completedAt=new Date().toISOString();
  await db.prepare(`INSERT INTO accounting_tax_export_files
    (id,batch_id,sequence_no,dataset_key,file_name,object_key,content_type,expected_row_count,row_count,size_bytes,crc32,sha256,etag,status,created_at,updated_at,completed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'ready',?,?,?) ON CONFLICT(batch_id,dataset_key) DO UPDATE SET
    object_key=excluded.object_key,size_bytes=excluded.size_bytes,crc32=excluded.crc32,sha256=excluded.sha256,etag=excluded.etag,
    status='ready',updated_at=excluded.updated_at,completed_at=excluded.completed_at`)
    .bind(manifestFile.id,batch.id,manifestFile.sequence_no,manifestFile.dataset_key,manifestFile.file_name,manifestFile.object_key,
      manifestFile.content_type,0,0,manifestFile.size_bytes,manifestFile.crc32,manifestFile.sha256,manifestFile.etag,completedAt,completedAt,completedAt).run();
  const allFiles=[...files,manifestFile];
  const packageKey=`${EXPORT_PREFIX}/${context.year}/${batch.id}/${context.exportNo}.zip`;
  const zipped=zipFiles(bucket,allFiles);
  const packageObject=await bucket.put(packageKey,zipped.stream,{httpMetadata:{contentType:'application/zip',
    contentDisposition:`attachment; filename="tax-package-${context.year}.zip"`},customMetadata:{exportNo:context.exportNo,snapshotAt:context.snapshotAt}});
  const packageStats=zipped.stats();
  const readyAt=new Date().toISOString();
  await db.batch([
    db.prepare(`UPDATE accounting_tax_export_batches SET status='ready',file_count=?,row_count=?,manifest_json=?,package_sha256=?,
      package_size_bytes=?,package_object_key=?,package_etag=?,completed_at=?,progress_current=progress_total,
      lease_token=NULL,lease_expires_at=NULL,last_heartbeat_at=? WHERE id=?`)
      .bind(allFiles.length,rowCount,JSON.stringify(manifest),packageStats.sha256,packageStats.sizeBytes,packageKey,
        packageObject?.etag||packageObject?.httpEtag||null,readyAt,readyAt,batch.id),
    logEvent(db,batch.id,'ready',{fileCount:allFiles.length,rowCount,packageSize:packageStats.sizeBytes,packageSha256:packageStats.sha256},readyAt),
  ]);
};

const cleanupTaxExportBatch = async (db:D1Database,bucket:R2Bucket,batch:any) => {
  const files=await db.prepare(`SELECT object_key FROM accounting_tax_export_files WHERE batch_id=?`)
    .bind(batch.id).all<{object_key:string}>();
  const packageKey=String(batch.package_object_key||`${EXPORT_PREFIX}/${batch.fiscal_year}/${batch.id}/${batch.export_no}.zip`);
  const rawKeys=[...new Set([...(files.results||[]).map((row)=>String(row.object_key||'')),packageKey].filter(Boolean))];
  const now=new Date().toISOString();
  try {
    const keys=assertR2KeysWithinPrefixes(rawKeys,[TAX_EXPORT_R2_PREFIX],'실패 세무 패키지 조각 정리');
    if (keys.length) await bucket.delete(keys);
    await db.batch([
      db.prepare(`UPDATE accounting_tax_export_batches SET cleanup_at=?,cleanup_error=NULL WHERE id=?`).bind(now,batch.id),
      logEvent(db,batch.id,'cleanup-ready',{objectCount:keys.length},now),
    ]);
    return true;
  } catch (error) {
    const message=error instanceof Error?error.message:String(error);
    await db.batch([
      db.prepare(`UPDATE accounting_tax_export_batches SET cleanup_error=? WHERE id=?`).bind(message.slice(0,1000),batch.id),
      logEvent(db,batch.id,'cleanup-failed',{message:message.slice(0,1000)},now),
    ]).catch(()=>undefined);
    return false;
  }
};

export const cleanupFailedTaxExportArtifacts = async (db:D1Database,bucket:R2Bucket,limit=10) => {
  const rows=await db.prepare(`SELECT id,export_no,fiscal_year,package_object_key FROM accounting_tax_export_batches
    WHERE status='failed' AND cleanup_at IS NULL ORDER BY failed_at LIMIT ${Math.max(1,Math.min(50,Math.round(limit)))}`)
    .all<any>();
  let cleaned=0,failed=0;
  for (const batch of rows.results||[]) {
    if (await cleanupTaxExportBatch(db,bucket,batch)) cleaned+=1; else failed+=1;
  }
  return {processed:(rows.results||[]).length,cleaned,failed};
};

export const processNextTaxExport = async (db:D1Database,bucket:R2Bucket,requestedBatchId='') => {
  const now=new Date(),nowIso=now.toISOString(),leaseToken=`LEASE-${randomHex(24)}`;
  const leaseUntil=new Date(now.getTime()+LEASE_SECONDS*1000).toISOString();
  const batch=await db.prepare(`UPDATE accounting_tax_export_batches SET status='processing',started_at=COALESCE(started_at,?),
    lease_token=?,lease_expires_at=?,last_heartbeat_at=? WHERE id=(
      SELECT id FROM accounting_tax_export_batches WHERE status IN ('queued','processing')
        AND (?='' OR id=?) AND (lease_expires_at IS NULL OR lease_expires_at<?)
      ORDER BY created_at LIMIT 1
    ) RETURNING *`).bind(nowIso,leaseToken,leaseUntil,nowIso,requestedBatchId,requestedBatchId,nowIso).first<any>();
  if (!batch) return {idle:true};
  try {
    await db.prepare(`UPDATE accounting_tax_export_files SET status='pending',updated_at=?,error_message='중단 작업 자동 재시도'
      WHERE batch_id=? AND status='processing' AND updated_at<?`)
      .bind(nowIso,batch.id,new Date(now.getTime()-LEASE_SECONDS*1000).toISOString()).run();
    const file=await db.prepare(`SELECT * FROM accounting_tax_export_files WHERE batch_id=? AND status='pending' ORDER BY sequence_no LIMIT 1`)
      .bind(batch.id).first<any>();
    if (file) {
      await processDataset(db,bucket,batch,file);
      await db.prepare(`UPDATE accounting_tax_export_batches SET lease_token=NULL,lease_expires_at=NULL WHERE id=? AND lease_token=?`)
        .bind(batch.id,leaseToken).run();
      const status=await getTaxExportStatus(db,batch.id);
      return {idle:false,processed:file.dataset_key,...status};
    }
    const unfinished=await db.prepare(`SELECT COUNT(*) AS count FROM accounting_tax_export_files WHERE batch_id=? AND status<>'ready'`)
      .bind(batch.id).first<{count:number}>();
    if (Number(unfinished?.count||0)) throw new Error('제출자료 일부가 실패 또는 처리 중 상태로 남아 있습니다.');
    await finalizeBatch(db,bucket,batch);
    return {idle:false,processed:'package',...(await getTaxExportStatus(db,batch.id))};
  } catch (error) {
    const message=error instanceof Error?error.message:'제출 패키지 비동기 처리 중 오류가 발생했습니다.';
    const failedAt=new Date().toISOString();
    await db.batch([
      db.prepare(`UPDATE accounting_tax_export_batches SET status='failed',error_message=?,failed_at=?,lease_token=NULL,
        lease_expires_at=NULL,last_heartbeat_at=? WHERE id=?`).bind(message,failedAt,failedAt,batch.id),
      db.prepare(`UPDATE accounting_tax_export_files SET status='failed',error_message=?,updated_at=?
        WHERE batch_id=? AND status<>'failed'`).bind(message,failedAt,batch.id),
      logEvent(db,batch.id,'failed',{message},failedAt),
    ]);
    await cleanupTaxExportBatch(db,bucket,batch);
    return {idle:false,id:batch.id,status:'failed',message};
  }
};

export const processTaxExportQueue = async (db:D1Database,bucket:R2Bucket,maxSteps=6) => {
  await cleanupFailedTaxExportArtifacts(db,bucket,4);
  const results:unknown[]=[];
  for(let index=0;index<Math.max(1,Math.min(20,maxSteps));index+=1){const result=await processNextTaxExport(db,bucket);results.push(result);if((result as any).idle)break;}
  return results;
};

export const getTaxExportStatus = async (db:D1Database,batchId:string) => {
  const row=await db.prepare(`SELECT id,export_no,status,progress_current,progress_total,file_count,row_count,package_sha256,
    package_size_bytes,package_object_key,error_message,snapshot_at,created_at,started_at,completed_at,failed_at
    FROM accounting_tax_export_batches WHERE id=?`).bind(batchId).first<any>();
  if (!row) throw new Error('제출 패키지 작업을 찾을 수 없습니다.');
  return {id:row.id,exportNo:row.export_no,status:row.status,progressCurrent:Number(row.progress_current||0),
    progressTotal:Number(row.progress_total||0),fileCount:Number(row.file_count||0),rowCount:Number(row.row_count||0),
    packageSha256:row.package_sha256||'',packageSizeBytes:Number(row.package_size_bytes||0),
    ready:row.status==='ready'&&!!row.package_object_key,errorMessage:row.error_message||'',snapshotAt:row.snapshot_at,
    createdAt:row.created_at,startedAt:row.started_at,completedAt:row.completed_at,failedAt:row.failed_at};
};

export const getTaxExportDownload = async (db:D1Database,bucket:R2Bucket,batchId:string) => {
  const row=await db.prepare(`SELECT export_no,fiscal_year,status,package_object_key,package_sha256,row_count FROM accounting_tax_export_batches WHERE id=?`)
    .bind(batchId).first<any>();
  if (!row || row.status!=='ready' || !row.package_object_key) throw new Error('다운로드할 수 있는 완료 패키지를 찾을 수 없습니다.');
  const objectKey=assertR2KeyWithinPrefixes(row.package_object_key,[TAX_EXPORT_R2_PREFIX],'세무 패키지 다운로드');
  const object=await bucket.get(objectKey);
  if (!object) throw new Error('보관된 제출 패키지 파일이 누락되었습니다. 관리자에게 무결성 점검을 요청해 주세요.');
  const filename=`${row.export_no}_${row.fiscal_year}_세무사_제출패키지.zip`;
  return new Response(object.body,{status:200,headers:{'Content-Type':'application/zip',
    'Content-Disposition':`attachment; filename="tax-package-${row.fiscal_year}.zip"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'Cache-Control':'private, no-store','X-Export-No':encodeURIComponent(String(row.export_no)),
    'X-Package-SHA256':String(row.package_sha256||''),'X-Export-Row-Count':String(row.row_count||0)}});
};
