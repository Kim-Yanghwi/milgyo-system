import { authenticateSession, clean, ensureTables, isValidIsoDate, json, randomHex } from '../../_shared/helpers';
import {
  ensureAccountingTables,
  hasAccountingAccess,
  isAccountingManager,
  isPeriodClosed,
  nextAccountingNumber,
  parseMoney,
  monthlySummaryStatement,
} from '../../_shared/accounting';
import {
  ensureAccountingSpecialTables,
  nextAvailableCardNumber,
  nextSpecialNumber,
  nextSpecialSequence,
  validateDimensions,
} from '../../_shared/accounting-special';

interface Env { DB: D1Database; ACCOUNTING_DB: D1Database; }
type Payload = Record<string, unknown> & { token?: string; action?: string };
const validYear = (value: unknown) => {
  const year = Number(value);
  return Number.isInteger(year) && year >= 2000 && year <= 2200 ? year : 0;
};

type ReceiptItem = { date: string; description: string; amount: number };
const receiptItemsFromPayload = (
  value: unknown,
  fallbackDate: string,
  fallbackDescription: string,
  totalAmount: number,
): ReceiptItem[] => {
  let source: unknown = value;
  if (typeof source === 'string') {
    try { source = JSON.parse(source); } catch { source = []; }
  }
  const raw = Array.isArray(source) ? source : [];
  const items = raw.map((item) => {
    const row = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    return {
      date: clean(row.date, 10),
      description: clean(row.description, 200),
      amount: Math.abs(parseMoney(row.amount)),
    };
  }).filter((item) => item.date || item.description || item.amount);
  if (!items.length) items.push({
    date: fallbackDate,
    description: fallbackDescription || '기부금',
    amount: totalAmount,
  });
  if (items.length > 5) throw new Error('기부내용은 최대 5건까지 입력할 수 있습니다.');
  for (const item of items) {
    if (!isValidIsoDate(item.date)) throw new Error('기부내용의 년월일을 확인해 주세요.');
    if (!item.description) throw new Error('기부내용의 적요를 입력해 주세요.');
    if (item.amount <= 0) throw new Error('기부내용의 금액은 0원보다 커야 합니다.');
  }
  const itemTotal = items.reduce((sum, item) => sum + item.amount, 0);
  if (itemTotal !== totalAmount) {
    throw new Error(`기부내용 합계 ${itemTotal.toLocaleString('ko-KR')}원이 등록금액 ${totalAmount.toLocaleString('ko-KR')}원과 일치하지 않습니다.`);
  }
  return items;
};
const audit = (
  db: D1Database,
  action: string,
  type: string,
  id: string,
  userId: string,
  userName: string,
  detail: unknown,
  now: string,
) => db.prepare(`INSERT INTO accounting_audit_logs
  (id,action,entity_type,entity_id,actor_user_id,actor_name,detail_json,created_at)
  VALUES (?,?,?,?,?,?,?,?)`).bind(
    `LOG-${randomHex(20)}`, action, type, id, userId, userName, JSON.stringify(detail || {}), now,
  );

const postDonation = async (db: D1Database, donation: any, approvedBy: string) => {
  if (donation.journal_id) return { journalId: donation.journal_id, journalNo: '', duplicate: true };
  if (await isPeriodClosed(db, donation.donation_date)) {
    throw new Error('해당 회계기간은 마감되어 기부금 전표를 생성할 수 없습니다.');
  }
  const journalId = `JRN-${randomHex(24)}`;
  const journalNo = await nextAccountingNumber(db, 'journal', Number(donation.fiscal_year));
  const now = new Date().toISOString();
  const amount = Math.abs(Number(donation.amount || 0));
  const debitLineId = `JL-${randomHex(20)}`;
  const creditLineId = `JL-${randomHex(20)}`;
  await db.batch([
    db.prepare(`INSERT INTO accounting_journals
      (id,journal_no,fiscal_year,journal_date,source_type,source_id,description,status,created_by,approved_by,created_at)
      VALUES (?,?,?,?, 'donation',?,?, 'posted',?,?,?)`)
      .bind(
        journalId, journalNo, donation.fiscal_year, donation.donation_date, donation.id,
        `[기부·후원] ${donation.donor_name || '익명'} ${donation.purpose || donation.donation_category}`,
        donation.created_by || approvedBy, approvedBy, now,
      ),
    db.prepare(`INSERT INTO accounting_journal_lines
      (id,journal_id,line_no,account_code,debit,credit,department,project,counterparty,memo)
      VALUES (?,?,?,?,?,0,?,?,?,?)`)
      .bind(
        debitLineId, journalId, 1, donation.settlement_account_code, amount,
        donation.department || '', donation.purpose || '', donation.donor_name || '익명', donation.memo || null,
      ),
    db.prepare(`INSERT INTO accounting_journal_lines
      (id,journal_id,line_no,account_code,debit,credit,department,project,counterparty,memo)
      VALUES (?,?,?,?,0,?,?,?,?,?)`)
      .bind(
        creditLineId, journalId, 2, donation.account_code, amount,
        donation.department || '', donation.purpose || '', donation.donor_name || '익명', donation.memo || null,
      ),
    db.prepare(`INSERT INTO accounting_journal_line_dimensions
      (journal_line_id,book_type_code,entity_id,fund_id,created_at) VALUES (?,?,?,?,?)`)
      .bind(debitLineId, donation.book_type_code, donation.entity_id, donation.fund_id || '', now),
    db.prepare(`INSERT INTO accounting_journal_line_dimensions
      (journal_line_id,book_type_code,entity_id,fund_id,created_at) VALUES (?,?,?,?,?)`)
      .bind(creditLineId, donation.book_type_code, donation.entity_id, donation.fund_id || '', now),
    monthlySummaryStatement(db, donation.donation_date, {
      accountCode: donation.settlement_account_code, debit: amount, credit: 0,
      department: donation.department || '', project: donation.purpose || '',
    }, { bookTypeCode: donation.book_type_code, entityId: donation.entity_id, fundId: donation.fund_id || '' }, now),
    monthlySummaryStatement(db, donation.donation_date, {
      accountCode: donation.account_code, debit: 0, credit: amount,
      department: donation.department || '', project: donation.purpose || '',
    }, { bookTypeCode: donation.book_type_code, entityId: donation.entity_id, fundId: donation.fund_id || '' }, now),
    db.prepare(`UPDATE accounting_donations SET journal_id=?,status='posted',updated_at=? WHERE id=?`)
      .bind(journalId, now, donation.id),
  ]);
  return { journalId, journalNo, duplicate: false };
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB || !env.ACCOUNTING_DB) return json({ ok: false, message: '전자문서 DB 또는 회계 전용 DB가 연결되지 않았습니다.' }, 500);
  let payload: Payload;
  try { payload = await request.json(); }
  catch { return json({ ok: false, message: '요청 형식이 올바르지 않습니다.' }, 400); }

  const accountingDb=env.ACCOUNTING_DB;
  await ensureTables(env.DB);
  const auth = await authenticateSession(env.DB, clean(payload.token, 200));
  if (!auth.ok) return json({ ok: false, message: auth.message }, auth.status);
  if (!hasAccountingAccess(auth.user)) return json({ ok: false, message: '종단 회계관리 접속 권한이 없습니다. 관리자에게 회계권한 부여를 요청해 주세요.' }, 403);
  await ensureAccountingTables(accountingDb);
  await ensureAccountingSpecialTables(accountingDb);
  const me = auth.user;
  const manager = isAccountingManager(me);
  const action = clean(payload.action, 60);
  if (me.role === 'audit') {
    return json({ ok: false, message: '감사 계정은 자료를 열람할 수 있지만 등록·수정할 수 없습니다.' }, 403);
  }

  try {
    const now = new Date().toISOString();

    if (action === 'save-book-type') {
      if (!manager) return json({ ok: false, message: '회계구분 관리 권한이 없습니다.' }, 403);
      const code = clean(payload.code, 30).replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase();
      const name = clean(payload.name, 80);
      if (!code || !name) return json({ ok: false, message: '회계구분 코드와 명칭을 입력해 주세요.' }, 400);
      const system = await accountingDb.prepare(`SELECT system_type FROM accounting_book_types WHERE code=?`)
        .bind(code).first<{ system_type: number }>();
      if (system?.system_type) return json({ ok: false, message: '기본 회계구분은 변경할 수 없습니다.' }, 400);
      await accountingDb.batch([
        accountingDb.prepare(`INSERT INTO accounting_book_types
          (code,name,description,active,system_type,created_at,updated_at)
          VALUES (?,?,?,1,0,?,?)
          ON CONFLICT(code) DO UPDATE SET name=excluded.name,description=excluded.description,active=1,updated_at=excluded.updated_at`)
          .bind(code, name, clean(payload.description, 500) || null, now, now),
        audit(accountingDb, 'save', 'book-type', code, me.id, me.name, { code, name }, now),
      ]);
      return json({ ok: true, message: '회계구분을 저장했습니다.' });
    }

    if (action === 'save-entity') {
      if (!manager) return json({ ok: false, message: '회계조직 관리 권한이 없습니다.' }, 403);
      const id = clean(payload.id, 80) || `ENT-${randomHex(20)}`;
      const entityCode = clean(payload.entityCode, 30).replace(/[^0-9A-Za-z_-]/g, '').toUpperCase();
      const name = clean(payload.name, 100);
      const entityType = clean(payload.entityType, 30);
      if (!entityCode || !name || !['headquarters', 'diocese', 'temple', 'affiliate'].includes(entityType)) {
        return json({ ok: false, message: '조직 코드·명칭·유형을 정확히 입력해 주세요.' }, 400);
      }
      const parentId = clean(payload.parentId, 80);
      if (parentId === id) return json({ ok: false, message: '자기 자신을 상위조직으로 지정할 수 없습니다.' }, 400);
      await accountingDb.batch([
        accountingDb.prepare(`INSERT INTO accounting_entities
          (id,entity_code,name,entity_type,parent_id,department_path,registration_no,representative,address,
           affiliation_registered_at,consolidation_enabled,active,created_by,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?,?)
          ON CONFLICT(id) DO UPDATE SET entity_code=excluded.entity_code,name=excluded.name,entity_type=excluded.entity_type,
          parent_id=excluded.parent_id,department_path=excluded.department_path,registration_no=excluded.registration_no,
          representative=excluded.representative,address=excluded.address,
          affiliation_registered_at=excluded.affiliation_registered_at,
          consolidation_enabled=excluded.consolidation_enabled,active=1,updated_at=excluded.updated_at`)
          .bind(
            id, entityCode, name, entityType, parentId || null, clean(payload.departmentPath, 120) || null,
            clean(payload.registrationNo, 40) || null, clean(payload.representative, 80) || null,
            clean(payload.address, 300) || null,
            isValidIsoDate(clean(payload.affiliationRegisteredAt, 10)) ? clean(payload.affiliationRegisteredAt, 10) : null,
            payload.consolidationEnabled === false ? 0 : 1,
            me.name, now, now,
          ),
        audit(accountingDb, 'save', 'entity', id, me.id, me.name, { entityCode, name, entityType }, now),
      ]);
      return json({ ok: true, id, message: '회계조직을 저장했습니다.' });
    }

    if (action === 'issue-entity-certificate') {
      if (!manager) return json({ ok: false, message: '소속증명원 발급 권한이 없습니다.' }, 403);
      const entityId = clean(payload.entityId, 80);
      const entity = await accountingDb.prepare(`SELECT id,entity_code,name,registration_no,address,representative,affiliation_registered_at
        FROM accounting_entities WHERE id=? AND active=1`).bind(entityId).first<any>();
      if (!entity) return json({ ok: false, message: '회계조직을 찾을 수 없습니다.' }, 404);
      const issueDate = clean(payload.issueDate, 10);
      const registrationDate = clean(payload.registrationDate, 10) || clean(entity.affiliation_registered_at, 10);
      if (!isValidIsoDate(issueDate)) return json({ ok: false, message: '발급일을 확인해 주세요.' }, 400);
      if (!isValidIsoDate(registrationDate)) return json({ ok: false, message: '등록년월일을 입력해 주세요.' }, 400);
      const headquartersAddress = clean(payload.headquartersAddress, 300) || '경상북도 성주군 대가면 도남4길 26-33';
      const templeDisplayName = clean(payload.templeDisplayName, 240) || `대한불교밀교종 ${entity.name}${entity.registration_no ? `(${entity.registration_no})` : ''}`;
      const purpose = clean(payload.purpose, 200) || '연말정산 확인용';
      const confirmationChairman = clean(payload.confirmationChairman, 100) || clean(payload.issuingChairman, 100) || me.name;
      const issuingChairman = clean(payload.issuingChairman, 100) || confirmationChairman;
      const issueYear = Number(issueDate.slice(0, 4));
      const buddhistYear = issueYear + 544;
      const validDate = new Date(`${issueDate}T00:00:00Z`);
      validDate.setUTCMonth(validDate.getUTCMonth() + 3);
      const validUntil = validDate.toISOString().slice(0, 10);
      const sequence = await nextSpecialSequence(accountingDb, `entity-certificate:${issueYear}`);
      const certificateNo = `제${issueYear}-${sequence}호`;
      const id = `CERT-${randomHex(20)}`;
      await accountingDb.batch([
        accountingDb.prepare(`INSERT INTO accounting_entity_certificates
          (id,certificate_no,entity_id,affiliation_name,headquarters_address,temple_display_name,registration_date,purpose,
           confirmation_chairman,issuing_chairman,issue_date,buddhist_year,valid_until,issued_by,issued_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
            id, certificateNo, entity.id, '대한불교밀교종', headquartersAddress, templeDisplayName, registrationDate, purpose,
            confirmationChairman, issuingChairman, issueDate, buddhistYear, validUntil, me.name, now,
          ),
        accountingDb.prepare(`UPDATE accounting_entities SET affiliation_registered_at=?,updated_at=? WHERE id=?`)
          .bind(registrationDate, now, entity.id),
        audit(accountingDb, 'issue', 'entity-certificate', id, me.id, me.name, {
          certificateNo, entityId: entity.id, entityName: entity.name, issueDate, validUntil,
        }, now),
      ]);
      return json({ ok: true, message: '소속증명원을 발급했습니다.', certificate: {
        id, certificateNo, affiliationName: '대한불교밀교종', headquartersAddress, templeDisplayName,
        registrationDate, purpose, confirmationChairman, issuingChairman, issueDate, buddhistYear, validUntil,
        entityName: entity.name, registrationNo: entity.registration_no || '', representative: entity.representative || '',
      }});
    }

    if (action === 'save-fund') {
      if (!manager) return json({ ok: false, message: '재원 관리 권한이 없습니다.' }, 403);
      const id = clean(payload.id, 80) || `FUND-${randomHex(18)}`;
      const fundCode = clean(payload.fundCode, 40).replace(/[^0-9A-Za-z_-]/g, '').toUpperCase();
      const name = clean(payload.name, 100);
      const fundType = clean(payload.fundType, 40);
      if (!fundCode || !name || !['unrestricted', 'designated_donation', 'grant', 'project', 'reserve'].includes(fundType)) {
        return json({ ok: false, message: '재원 코드·명칭·유형을 정확히 입력해 주세요.' }, 400);
      }
      await accountingDb.batch([
        accountingDb.prepare(`INSERT INTO accounting_funds
          (id,fund_code,name,fund_type,purpose,restriction_note,active,system_fund,created_by,created_at,updated_at)
          VALUES (?,?,?,?,?,?,1,0,?,?,?)
          ON CONFLICT(id) DO UPDATE SET fund_code=excluded.fund_code,name=excluded.name,fund_type=excluded.fund_type,
          purpose=excluded.purpose,restriction_note=excluded.restriction_note,active=1,updated_at=excluded.updated_at`)
          .bind(
            id, fundCode, name, fundType, clean(payload.purpose, 500) || null,
            clean(payload.restrictionNote, 1000) || null, me.name, now, now,
          ),
        audit(accountingDb, 'save', 'fund', id, me.id, me.name, { fundCode, name, fundType }, now),
      ]);
      return json({ ok: true, id, message: '재원을 저장했습니다.' });
    }

    if (action === 'save-donor') {
      const id = clean(payload.id, 80) || `DONOR-${randomHex(20)}`;
      const donorType = clean(payload.donorType, 30);
      const name = clean(payload.name, 100);
      if (!name || !['individual', 'corporate', 'temple', 'anonymous'].includes(donorType)) {
        return json({ ok: false, message: '후원자 유형과 명칭을 입력해 주세요.' }, 400);
      }
      const existing = await accountingDb.prepare(`SELECT donor_no FROM accounting_donors WHERE id=?`)
        .bind(id).first<{ donor_no: string }>();
      const donorNo = existing?.donor_no || await nextSpecialNumber(accountingDb, 'donor');
      await accountingDb.batch([
        accountingDb.prepare(`INSERT INTO accounting_donors
          (id,donor_no,donor_type,name,identifier_masked,phone,email,address,receipt_consent,memo,
           active,created_by,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?,?)
          ON CONFLICT(id) DO UPDATE SET donor_type=excluded.donor_type,name=excluded.name,
          identifier_masked=excluded.identifier_masked,phone=excluded.phone,email=excluded.email,address=excluded.address,
          receipt_consent=excluded.receipt_consent,memo=excluded.memo,active=1,updated_at=excluded.updated_at`)
          .bind(
            id, donorNo, donorType, name, clean(payload.identifierMasked, 60) || null,
            clean(payload.phone, 40) || null, clean(payload.email, 120) || null,
            clean(payload.address, 300) || null, payload.receiptConsent === true ? 1 : 0,
            clean(payload.memo, 1000) || null, me.name, now, now,
          ),
        audit(accountingDb, 'save', 'donor', id, me.id, me.name, { donorNo, donorType, name }, now),
      ]);
      return json({ ok: true, id, donorNo, message: '후원자 정보를 저장했습니다.' });
    }

    if (action === 'save-donation') {
      const date = clean(payload.donationDate, 10);
      const amount = parseMoney(payload.amount);
      if (!isValidIsoDate(date) || amount <= 0) return json({ ok: false, message: '기부일자와 금액을 확인해 주세요.' }, 400);
      const dimensions = await validateDimensions(accountingDb, payload);
      const anonymousDonation = payload.anonymousDonation === true;
      const donorName = clean(payload.donorName, 100);
      let donorId = anonymousDonation ? '' : clean(payload.donorId, 80);
      let donorInsert: D1PreparedStatement | null = null;
      if (!anonymousDonation) {
        if (donorId) {
          const donor = await accountingDb.prepare(`SELECT id FROM accounting_donors WHERE id=? AND active=1`).bind(donorId).first();
          if (!donor) return json({ ok: false, message: '후원자를 확인해 주세요.' }, 400);
        } else {
          if (!donorName) return json({ ok: false, message: '후원자명을 입력하거나 익명 기부를 선택해 주세요.' }, 400);
          const existingDonor = await accountingDb.prepare(`SELECT id FROM accounting_donors WHERE active=1 AND TRIM(name)=TRIM(?) ORDER BY created_at LIMIT 1`)
            .bind(donorName).first<{ id: string }>();
          if (existingDonor?.id) {
            donorId = existingDonor.id;
          } else {
            donorId = `DONOR-${randomHex(20)}`;
            const donorNo = await nextSpecialNumber(accountingDb, 'donor');
            donorInsert = accountingDb.prepare(`INSERT INTO accounting_donors
              (id,donor_no,donor_type,name,identifier_masked,phone,email,address,receipt_consent,memo,
               active,created_by,created_at,updated_at)
              VALUES (?,?,'individual',?,NULL,NULL,NULL,NULL,0,'기부금 등록 화면에서 자동 생성',1,?,?,?)`)
              .bind(donorId, donorNo, donorName, me.name, now, now);
          }
        }
      }
      const category = clean(payload.donationCategory, 40) || 'general';
      const receiptEntity = await accountingDb.prepare(`SELECT name,registration_no,representative,address FROM accounting_entities WHERE id=? AND active=1`)
        .bind(dimensions.entityId).first<any>();
      const receiptDonationType = clean(payload.receiptDonationType, 300) || '소득세법 제34조 제1항 기부금중 종교단체 기부금';
      const receiptDonationCode = clean(payload.receiptDonationCode, 20) || '41';
      const fallbackReceiptDescription = clean(payload.receiptDescription, 200) || clean(payload.purpose, 300) || '기부금';
      const receiptItems = receiptItemsFromPayload(payload.receiptItems, date, fallbackReceiptDescription, amount);
      const receiptDescription = receiptItems[0]?.description || fallbackReceiptDescription;
      const receiptItemsJson = JSON.stringify(receiptItems);
      const receiptOrgName = clean(payload.receiptOrgName, 160) || clean(receiptEntity?.name, 160) || null;
      const receiptOrgRegistrationNo = clean(payload.receiptOrgRegistrationNo, 60) || clean(receiptEntity?.registration_no, 60) || null;
      const receiptOrgAddress = clean(payload.receiptOrgAddress, 400) || clean(receiptEntity?.address, 400) || null;
      const receiptCollectorName = clean(payload.receiptCollectorName, 160) || null;
      const receiptCollectorRegistrationNo = clean(payload.receiptCollectorRegistrationNo, 60) || null;
      const receiptCollectorAddress = clean(payload.receiptCollectorAddress, 400) || null;
      const receiptIssuerTitle = clean(payload.receiptIssuerTitle, 60) || '주지';
      const receiptIssuerName = clean(payload.receiptIssuerName, 100) || clean(receiptEntity?.representative, 100) || null;
      const receiptIssuerPhone = clean(payload.receiptIssuerPhone, 60) || null;
      const accountCode = clean(payload.accountCode, 20) || (category === 'designated' ? '4210' : '4200');
      const settlement = clean(payload.settlementAccountCode, 20) || '1120';
      const accounts = await accountingDb.prepare(`SELECT code,account_type FROM accounting_accounts WHERE code IN (?,?) AND active=1`)
        .bind(accountCode, settlement).all<{ code: string; account_type: string }>();
      const map = new Map((accounts.results || []).map((row) => [row.code, row.account_type]));
      if (map.get(accountCode) !== 'revenue' || map.get(settlement) !== 'asset') {
        return json({ ok: false, message: '기부금 수입계정과 입금계정을 확인해 주세요.' }, 400);
      }
      const id = `DON-${randomHex(20)}`;
      const year = Number(date.slice(0, 4));
      const donationNo = await nextSpecialNumber(accountingDb, 'donation', year);
      const receiptRequested = 0;
      const statements: D1PreparedStatement[] = [];
      if (donorInsert) statements.push(donorInsert);
      statements.push(
        accountingDb.prepare(`INSERT INTO accounting_donations
          (id,donation_no,fiscal_year,donation_date,donor_id,donation_category,book_type_code,entity_id,fund_id,
           amount,payment_method,account_code,settlement_account_code,purpose,memo,receipt_requested,receipt_status,
           status,created_by,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'registered',?,?,?)`)
          .bind(
            id, donationNo, year, date, donorId || null, category,
            dimensions.bookTypeCode, dimensions.entityId, dimensions.fundId,
            amount, clean(payload.paymentMethod, 40) || null, accountCode, settlement,
            clean(payload.purpose, 300) || null, clean(payload.memo, 1000) || null,
            receiptRequested, receiptRequested ? 'requested' : 'not_requested', me.name, now, now,
          ),
        accountingDb.prepare(`UPDATE accounting_donations SET
          receipt_donation_type=?,receipt_donation_code=?,receipt_description=?,receipt_items_json=?,
          receipt_org_name=?,receipt_org_registration_no=?,receipt_org_address=?,
          receipt_collector_name=?,receipt_collector_registration_no=?,receipt_collector_address=?,
          receipt_issuer_title=?,receipt_issuer_name=?,receipt_issuer_phone=? WHERE id=?`)
          .bind(
            receiptDonationType, receiptDonationCode, receiptDescription, receiptItemsJson,
            receiptOrgName, receiptOrgRegistrationNo, receiptOrgAddress,
            receiptCollectorName, receiptCollectorRegistrationNo, receiptCollectorAddress,
            receiptIssuerTitle, receiptIssuerName, receiptIssuerPhone, id,
          ),
        audit(accountingDb, 'create', 'donation', id, me.id, me.name, {
          donationNo, amount, donorId, anonymousDonation, donorName: anonymousDonation ? '익명' : donorName,
          receiptDonationType, receiptDonationCode, receiptOrgName, receiptItemCount: receiptItems.length, ...dimensions,
        }, now),
      );
      await accountingDb.batch(statements);
      let posting: any = null;
      if (payload.postNow === true && manager) {
        const donation = await accountingDb.prepare(`SELECT d.*,COALESCE(o.name,'익명') AS donor_name,e.department_path AS department
          FROM accounting_donations d
          LEFT JOIN accounting_donors o ON o.id=d.donor_id
          LEFT JOIN accounting_entities e ON e.id=d.entity_id
          WHERE d.id=?`).bind(id).first<any>();
        posting = await postDonation(accountingDb, donation, me.name);
      }
      return json({ ok: true, id, donationNo, posting, message: posting ? '기부금을 등록하고 전표를 생성했습니다.' : '기부금을 등록했습니다.' });
    }

    if (action === 'post-donation') {
      if (!manager) return json({ ok: false, message: '기부금 전표처리 권한이 없습니다.' }, 403);
      const id = clean(payload.id, 80);
      const donation = await accountingDb.prepare(`SELECT d.*,COALESCE(o.name,'익명') AS donor_name,e.department_path AS department
        FROM accounting_donations d
        LEFT JOIN accounting_donors o ON o.id=d.donor_id
        LEFT JOIN accounting_entities e ON e.id=d.entity_id
        WHERE d.id=?`).bind(id).first<any>();
      if (!donation) return json({ ok: false, message: '기부금 내역을 찾을 수 없습니다.' }, 404);
      const posting = await postDonation(accountingDb, donation, me.name);
      await audit(accountingDb, 'post', 'donation', id, me.id, me.name, posting, now).run();
      return json({ ok: true, ...posting, message: posting.duplicate ? '이미 전표처리된 기부금입니다.' : '기부금 전표를 생성했습니다.' });
    }

    if (action === 'issue-receipt' || action === 'cancel-receipt') {
      const id = clean(payload.id, 80);
      const donation = await accountingDb.prepare(`SELECT d.*,o.name AS donor_name FROM accounting_donations d
        LEFT JOIN accounting_donors o ON o.id=d.donor_id WHERE d.id=?`).bind(id).first<any>();
      if (!donation) return json({ ok: false, message: '기부금 내역을 찾을 수 없습니다.' }, 404);
      if (!donation.donor_id) return json({ ok: false, message: '익명 기부에는 영수증을 발급할 수 없습니다.' }, 400);
      if (action === 'issue-receipt') {
        const receiptNo = donation.receipt_no || await nextSpecialNumber(accountingDb, 'receipt', Number(donation.fiscal_year));
        await accountingDb.batch([
          accountingDb.prepare(`UPDATE accounting_donations
            SET receipt_requested=1,receipt_status='issued',receipt_no=?,receipt_issued_at=?,receipt_cancelled_at=NULL,updated_at=?
            WHERE id=?`).bind(receiptNo, now, now, id),
          audit(accountingDb, 'issue', 'donation-receipt', id, me.id, me.name, { receiptNo }, now),
        ]);
        return json({ ok: true, receiptNo, message: '기부금영수증 발급내역을 등록했습니다.' });
      }
      await accountingDb.batch([
        accountingDb.prepare(`UPDATE accounting_donations SET receipt_status='cancelled',receipt_cancelled_at=?,updated_at=? WHERE id=?`)
          .bind(now, now, id),
        audit(accountingDb, 'cancel', 'donation-receipt', id, me.id, me.name, { receiptNo: donation.receipt_no }, now),
      ]);
      return json({ ok: true, message: '기부금영수증 발급을 취소했습니다.' });
    }

    if (action === 'save-asset') {
      if (!manager) return json({ ok: false, message: '자산·비품 관리 권한이 없습니다.' }, 403);
      const id = clean(payload.id, 80) || `AST-${randomHex(20)}`;
      const existing = await accountingDb.prepare(`SELECT asset_no FROM accounting_assets WHERE id=?`)
        .bind(id).first<{ asset_no: string }>();
      const date = clean(payload.acquisitionDate, 10);
      const name = clean(payload.name, 120);
      const cost = parseMoney(payload.acquisitionCost);
      if (!isValidIsoDate(date) || !name || cost < 0) return json({ ok: false, message: '자산명·취득일자·취득가액을 확인해 주세요.' }, 400);
      const dimensions = await validateDimensions(accountingDb, payload);
      const assetNo = existing?.asset_no || await nextSpecialNumber(accountingDb, 'asset', Number(date.slice(0, 4)));
      await accountingDb.batch([
        accountingDb.prepare(`INSERT INTO accounting_assets
          (id,asset_no,name,category,acquisition_date,acquisition_cost,useful_life_months,depreciation_method,residual_value,
           book_type_code,entity_id,fund_id,department,location,custodian,asset_account_code,status,memo,created_by,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'in_use',?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET name=excluded.name,category=excluded.category,acquisition_date=excluded.acquisition_date,
          acquisition_cost=excluded.acquisition_cost,useful_life_months=excluded.useful_life_months,
          depreciation_method=excluded.depreciation_method,residual_value=excluded.residual_value,
          book_type_code=excluded.book_type_code,entity_id=excluded.entity_id,fund_id=excluded.fund_id,
          department=excluded.department,location=excluded.location,custodian=excluded.custodian,
          asset_account_code=excluded.asset_account_code,memo=excluded.memo,updated_at=excluded.updated_at`)
          .bind(
            id, assetNo, name, clean(payload.category, 60) || '비품', date, cost,
            Math.max(0, Math.min(1200, Number(payload.usefulLifeMonths) || 0)),
            clean(payload.depreciationMethod, 30) || 'straight_line', Math.max(0, parseMoney(payload.residualValue)),
            dimensions.bookTypeCode, dimensions.entityId, dimensions.fundId, clean(payload.department, 100),
            clean(payload.location, 150) || null, clean(payload.custodian, 80) || null,
            clean(payload.assetAccountCode, 20) || '1500', clean(payload.memo, 1000) || null,
            me.name, now, now,
          ),
        audit(accountingDb, 'save', 'asset', id, me.id, me.name, { assetNo, name, cost }, now),
      ]);
      return json({ ok: true, id, assetNo, message: '자산·비품을 저장했습니다.' });
    }

    if (action === 'dispose-asset') {
      if (!manager) return json({ ok: false, message: '자산 처분 권한이 없습니다.' }, 403);
      const id = clean(payload.id, 80);
      const date = clean(payload.disposalDate, 10);
      if (!isValidIsoDate(date)) return json({ ok: false, message: '처분일자를 확인해 주세요.' }, 400);
      await accountingDb.batch([
        accountingDb.prepare(`UPDATE accounting_assets
          SET status='disposed',disposal_date=?,disposal_amount=?,memo=COALESCE(?,memo),updated_at=? WHERE id=?`)
          .bind(date, parseMoney(payload.disposalAmount), clean(payload.memo, 1000) || null, now, id),
        audit(accountingDb, 'dispose', 'asset', id, me.id, me.name, payload, now),
      ]);
      return json({ ok: true, message: '자산을 처분 처리했습니다.' });
    }

    if (action === 'save-card') {
      if (!manager) return json({ ok: false, message: '법인카드 관리 권한이 없습니다.' }, 403);
      const id = clean(payload.id, 80) || `CARD-${randomHex(18)}`;
      const existing = await accountingDb.prepare(`SELECT card_code FROM accounting_cards WHERE id=?`)
        .bind(id).first<{ card_code: string }>();
      const label = clean(payload.cardLabel, 100);
      if (!label) return json({ ok: false, message: '카드명을 입력해 주세요.' }, 400);
      const dimensions = await validateDimensions(accountingDb, payload);
      const cardYear = validYear(payload.year) || new Date(Date.now() + 9 * 60 * 60 * 1000).getUTCFullYear();
      const cardCode = existing?.card_code || await nextAvailableCardNumber(accountingDb, cardYear);
      await accountingDb.batch([
        accountingDb.prepare(`INSERT INTO accounting_cards
          (id,card_code,card_label,issuer,masked_number,holder,book_type_code,entity_id,department,
           settlement_account_code,active,created_by,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?,?)
          ON CONFLICT(id) DO UPDATE SET card_label=excluded.card_label,issuer=excluded.issuer,
          masked_number=excluded.masked_number,holder=excluded.holder,book_type_code=excluded.book_type_code,
          entity_id=excluded.entity_id,department=excluded.department,
          settlement_account_code=excluded.settlement_account_code,active=1,updated_at=excluded.updated_at`)
          .bind(
            id, cardCode, label, clean(payload.issuer, 80) || null, clean(payload.maskedNumber, 40) || null,
            clean(payload.holder, 80) || null, dimensions.bookTypeCode, dimensions.entityId,
            clean(payload.department, 100), clean(payload.settlementAccountCode, 20) || '1130', me.name, now, now,
          ),
        audit(accountingDb, 'save', 'card', id, me.id, me.name, { cardCode, label }, now),
      ]);
      return json({ ok: true, id, cardCode, message: '법인카드를 저장했습니다.' });
    }

    if (action === 'delete-card') {
      if (!manager) return json({ ok: false, message: '법인카드 삭제 권한이 없습니다.' }, 403);
      const id = clean(payload.id, 80);
      const card = await accountingDb.prepare(`SELECT c.id,c.card_code,c.card_label,
          (SELECT COUNT(*) FROM accounting_card_transactions t WHERE t.card_id=c.id) AS transaction_count,
          (SELECT COUNT(*) FROM accounting_attachments a WHERE a.reference_type='card' AND a.reference_id=c.id AND a.deleted_at IS NULL) AS attachment_count
        FROM accounting_cards c WHERE c.id=?`).bind(id).first<any>();
      if (!card) return json({ ok: false, message: '삭제할 법인카드를 찾을 수 없습니다.' }, 404);
      if (Number(card.transaction_count || 0) > 0) {
        return json({ ok: false, message: `카드 사용내역 ${Number(card.transaction_count)}건이 있어 삭제할 수 없습니다. 회계이력 보존을 위해 사용내역이 없는 카드만 삭제할 수 있습니다.` }, 409);
      }
      if (Number(card.attachment_count || 0) > 0) {
        return json({ ok: false, message: '카드에 첨부파일이 있어 삭제할 수 없습니다. 첨부파일을 먼저 삭제해 주세요.' }, 409);
      }
      await accountingDb.batch([
        accountingDb.prepare(`DELETE FROM accounting_attachments WHERE reference_type='card' AND reference_id=? AND deleted_at IS NOT NULL`).bind(id),
        accountingDb.prepare(`DELETE FROM accounting_cards WHERE id=?`).bind(id),
        audit(accountingDb, 'delete', 'card', id, me.id, me.name, { cardCode: card.card_code, cardLabel: card.card_label }, now),
      ]);
      return json({ ok: true, cardCode: card.card_code, message: `${card.card_code} 법인카드를 삭제했습니다. 해당 코드는 다음 카드 등록 시 다시 사용됩니다.` });
    }

    if (action === 'save-card-transaction') {
      const cardId = clean(payload.cardId, 80);
      const card = await accountingDb.prepare(`SELECT * FROM accounting_cards WHERE id=? AND active=1`).bind(cardId).first<any>();
      if (!card) return json({ ok: false, message: '법인카드를 선택해 주세요.' }, 400);
      const date = clean(payload.transactionDate, 10);
      const merchant = clean(payload.merchant, 120);
      const amount = parseMoney(payload.amount);
      const taxMode = clean(payload.taxMode, 20) || 'taxable';
      if (!isValidIsoDate(date) || !merchant || amount <= 0) return json({ ok: false, message: '사용일자·가맹점·금액을 확인해 주세요.' }, 400);
      if (!['taxable', 'exempt', 'manual'].includes(taxMode)) return json({ ok: false, message: '세액 처리방식을 확인해 주세요.' }, 400);
      const taxAmount = taxMode === 'taxable' ? Math.round(amount * 0.1) : taxMode === 'exempt' ? 0 : Math.max(0, parseMoney(payload.taxAmount));
      if (taxAmount > amount) return json({ ok: false, message: '세액은 결제금액보다 클 수 없습니다.' }, 400);
      const dimensions = await validateDimensions(accountingDb, {
        bookTypeCode: payload.bookTypeCode || card.book_type_code,
        entityId: payload.entityId || card.entity_id,
        fundId: payload.fundId,
      });
      const id = `CTX-${randomHex(20)}`;
      const txNo = await nextSpecialNumber(accountingDb, 'card-tx', Number(date.slice(0, 4)));
      await accountingDb.batch([
        accountingDb.prepare(`INSERT INTO accounting_card_transactions
          (id,transaction_no,card_id,transaction_date,merchant,amount,tax_amount,account_code,
           book_type_code,entity_id,fund_id,department,project,memo,status,created_by,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'unmatched',?,?,?)`)
          .bind(
            id, txNo, cardId, date, merchant, amount, taxAmount,
            clean(payload.accountCode, 20) || null, dimensions.bookTypeCode, dimensions.entityId, dimensions.fundId,
            clean(payload.department, 100) || card.department || '', clean(payload.project, 100),
            clean(payload.memo, 1000) || null, me.name, now, now,
          ),
        audit(accountingDb, 'create', 'card-transaction', id, me.id, me.name, { txNo, amount, merchant }, now),
      ]);
      return json({ ok: true, id, transactionNo: txNo, message: '법인카드 사용내역을 등록했습니다.' });
    }

    if (action === 'post-card-transaction') {
      if (!manager) return json({ ok: false, message: '법인카드 전표처리 권한이 없습니다.' }, 403);
      const id = clean(payload.id, 80);
      const tx = await accountingDb.prepare(`SELECT t.*,c.settlement_account_code FROM accounting_card_transactions t
        JOIN accounting_cards c ON c.id=t.card_id WHERE t.id=?`).bind(id).first<any>();
      if (!tx) return json({ ok: false, message: '카드 사용내역을 찾을 수 없습니다.' }, 404);
      if (tx.journal_id) return json({ ok: true, message: '이미 전표처리된 카드 사용내역입니다.' });
      if (!tx.account_code) return json({ ok: false, message: '지출 계정과목을 먼저 지정해 주세요.' }, 400);
      if (await isPeriodClosed(accountingDb, tx.transaction_date)) {
        return json({ ok: false, message: '마감된 기간의 카드 사용내역은 전표처리할 수 없습니다.' }, 400);
      }
      const year = Number(tx.transaction_date.slice(0, 4));
      const journalId = `JRN-${randomHex(24)}`;
      const journalNo = await nextAccountingNumber(accountingDb, 'journal', year);
      const debitId = `JL-${randomHex(20)}`;
      const creditId = `JL-${randomHex(20)}`;
      await accountingDb.batch([
        accountingDb.prepare(`INSERT INTO accounting_journals
          (id,journal_no,fiscal_year,journal_date,source_type,source_id,description,status,created_by,approved_by,created_at)
          VALUES (?,?,?,?, 'card',?,?, 'posted',?,?,?)`)
          .bind(journalId, journalNo, year, tx.transaction_date, id, `[법인카드] ${tx.merchant}`, me.name, me.name, now),
        accountingDb.prepare(`INSERT INTO accounting_journal_lines
          (id,journal_id,line_no,account_code,debit,credit,department,project,counterparty,memo)
          VALUES (?,?,?,?,?,0,?,?,?,?)`)
          .bind(debitId, journalId, 1, tx.account_code, tx.amount, tx.department, tx.project, tx.merchant, tx.memo || null),
        accountingDb.prepare(`INSERT INTO accounting_journal_lines
          (id,journal_id,line_no,account_code,debit,credit,department,project,counterparty,memo)
          VALUES (?,?,?,?,0,?,?,?,?,?)`)
          .bind(creditId, journalId, 2, tx.settlement_account_code, tx.amount, tx.department, tx.project, tx.merchant, tx.memo || null),
        accountingDb.prepare(`INSERT INTO accounting_journal_line_dimensions
          (journal_line_id,book_type_code,entity_id,fund_id,created_at) VALUES (?,?,?,?,?)`)
          .bind(debitId, tx.book_type_code, tx.entity_id, tx.fund_id || '', now),
        accountingDb.prepare(`INSERT INTO accounting_journal_line_dimensions
          (journal_line_id,book_type_code,entity_id,fund_id,created_at) VALUES (?,?,?,?,?)`)
          .bind(creditId, tx.book_type_code, tx.entity_id, tx.fund_id || '', now),
        monthlySummaryStatement(accountingDb, tx.transaction_date, {
          accountCode: tx.account_code, debit: Number(tx.amount || 0), credit: 0,
          department: tx.department || '', project: tx.project || '',
        }, { bookTypeCode: tx.book_type_code, entityId: tx.entity_id, fundId: tx.fund_id || '' }, now),
        monthlySummaryStatement(accountingDb, tx.transaction_date, {
          accountCode: tx.settlement_account_code, debit: 0, credit: Number(tx.amount || 0),
          department: tx.department || '', project: tx.project || '',
        }, { bookTypeCode: tx.book_type_code, entityId: tx.entity_id, fundId: tx.fund_id || '' }, now),
        accountingDb.prepare(`UPDATE accounting_card_transactions SET journal_id=?,status='posted',updated_at=? WHERE id=?`)
          .bind(journalId, now, id),
        audit(accountingDb, 'post', 'card-transaction', id, me.id, me.name, { journalNo }, now),
      ]);
      return json({ ok: true, journalNo, message: '법인카드 사용내역을 전표처리했습니다.' });
    }

    if (action === 'save-branch-report') {
      const year = validYear(payload.year);
      const periodType = clean(payload.periodType, 20);
      const periodKey = clean(payload.periodKey, 20);
      const dimensions = await validateDimensions(accountingDb, payload);
      if (!year || !['month', 'quarter', 'annual'].includes(periodType) || !periodKey) {
        return json({ ok: false, message: '보고기간을 확인해 주세요.' }, 400);
      }
      const id = clean(payload.id, 80) || `BRP-${randomHex(20)}`;
      const status = payload.submit === true ? 'submitted' : 'draft';
      await accountingDb.batch([
        accountingDb.prepare(`INSERT INTO accounting_branch_reports
          (id,fiscal_year,period_type,period_key,entity_id,book_type_code,income_total,expense_total,
           asset_total,liability_total,cash_balance,donation_total,status,detail_json,memo,
           submitted_by,submitted_at,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(fiscal_year,period_type,period_key,entity_id,book_type_code) DO UPDATE SET
          income_total=excluded.income_total,expense_total=excluded.expense_total,
          asset_total=excluded.asset_total,liability_total=excluded.liability_total,
          cash_balance=excluded.cash_balance,donation_total=excluded.donation_total,
          status=excluded.status,detail_json=excluded.detail_json,memo=excluded.memo,
          submitted_by=excluded.submitted_by,submitted_at=excluded.submitted_at,updated_at=excluded.updated_at`)
          .bind(
            id, year, periodType, periodKey, dimensions.entityId, dimensions.bookTypeCode,
            parseMoney(payload.incomeTotal), parseMoney(payload.expenseTotal), parseMoney(payload.assetTotal),
            parseMoney(payload.liabilityTotal), parseMoney(payload.cashBalance), parseMoney(payload.donationTotal),
            status, JSON.stringify(payload.detail || {}), clean(payload.memo, 1000) || null,
            status === 'submitted' ? me.name : null, status === 'submitted' ? now : null, now, now,
          ),
        audit(accountingDb, status === 'submitted' ? 'submit' : 'save', 'branch-report', id, me.id, me.name,
          { year, periodType, periodKey, ...dimensions }, now),
      ]);
      return json({ ok: true, id, message: status === 'submitted' ? '회계자료를 제출했습니다.' : '회계자료를 임시저장했습니다.' });
    }

    if (action === 'review-branch-report') {
      if (!manager) return json({ ok: false, message: '취합자료 검토 권한이 없습니다.' }, 403);
      const id = clean(payload.id, 80);
      const decision = clean(payload.decision, 20);
      if (!['confirmed', 'rejected'].includes(decision)) return json({ ok: false, message: '검토 결과를 선택해 주세요.' }, 400);
      await accountingDb.batch([
        accountingDb.prepare(`UPDATE accounting_branch_reports
          SET status=?,reviewed_by=?,reviewed_at=?,memo=COALESCE(?,memo),updated_at=? WHERE id=?`)
          .bind(decision, me.name, now, clean(payload.memo, 1000) || null, now, id),
        audit(accountingDb, decision, 'branch-report', id, me.id, me.name, { memo: clean(payload.memo, 1000) }, now),
      ]);
      return json({ ok: true, message: decision === 'confirmed' ? '취합자료를 확정했습니다.' : '취합자료를 반려했습니다.' });
    }

    return json({ ok: false, message: '지원하지 않는 종단 특화회계 처리입니다.' }, 400);
  } catch (error) {
    console.error('accounting-special action failed', action, error);
    return json({ ok: false, message: error instanceof Error ? error.message : '종단 특화회계 처리 중 오류가 발생했습니다.' }, 500);
  }
};

export const onRequestGet: PagesFunction = async () => json({ ok: false, message: 'POST 방식으로 요청해 주세요.' }, 405);
