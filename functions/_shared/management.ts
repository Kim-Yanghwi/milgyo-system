import { clean, randomHex, type SessionUser } from './helpers';

export const REGISTER_TYPES = ['공고대장', '관인날인기록부', '인영관리기록부'] as const;
export type RegisterType = typeof REGISTER_TYPES[number];
export const REGISTER_STATUSES = ['신청', '검토중', '완료', '반려', '취소'] as const;

const KST_OFFSET = 9 * 60 * 60 * 1000;
export const kstDate = (date = new Date()) => new Date(date.getTime() + KST_OFFSET).toISOString().slice(0, 10);

export const isRegisterType = (value: string): value is RegisterType => REGISTER_TYPES.includes(value as RegisterType);

const REGISTER_PREFIX: Record<RegisterType, string> = {
  공고대장: '공고',
  관인날인기록부: '관인',
  인영관리기록부: '인영',
};

export const nextManagedNumber = async (
  db: D1Database,
  seqKey: string,
  prefix: string,
  year: number,
  table: 'management_registers' | 'employment_certificates',
  numberColumn: 'request_no' | 'certificate_no',
  width: number,
) => {
  const likePrefix = `${prefix}-${year}-`;
  const startAt = likePrefix.length + 1;
  const existing = await db.prepare(`SELECT MAX(CAST(substr(${numberColumn}, ?) AS INTEGER)) AS max_seq FROM ${table} WHERE ${numberColumn} LIKE ?`)
    .bind(startAt, `${likePrefix}%`).first<{ max_seq?: number | null }>();
  const existingMax = Number(existing?.max_seq || 0);
  await db.prepare(`
    INSERT INTO document_sequences (seq_key, last_seq) VALUES (?, ?)
    ON CONFLICT(seq_key) DO UPDATE SET last_seq = MAX(document_sequences.last_seq, excluded.last_seq)
  `).bind(seqKey, existingMax).run();
  const row = await db.prepare(`UPDATE document_sequences SET last_seq=last_seq+1 WHERE seq_key=? RETURNING last_seq`)
    .bind(seqKey).first<{ last_seq?: number }>();
  const seq = Number(row?.last_seq || existingMax + 1);
  return `${likePrefix}${String(seq).padStart(width, '0')}`;
};

export const makeRegisterNumber = async (db: D1Database, type: RegisterType, requestDate: string) => {
  const year = Number(requestDate.slice(0, 4)) || new Date().getUTCFullYear();
  return nextManagedNumber(db, `REGISTER:${type}:${year}`, REGISTER_PREFIX[type], year, 'management_registers', 'request_no', 4);
};

export const makeEmploymentCertificateNumber = async (db: D1Database, issueDate: string) => {
  const year = Number(issueDate.slice(0, 4)) || new Date().getUTCFullYear();
  return nextManagedNumber(db, `EMPLOYMENT_CERT:${year}`, '재직', year, 'employment_certificates', 'certificate_no', 5);
};

export const makeOrdinationCertificateNumber = async (db: D1Database, ordinationDate: string) => {
  const year = Number(ordinationDate.slice(0, 4)) || new Date().getUTCFullYear();
  const seqKey = `ORDINATION_CERT:${year}`;
  const existing = await db.prepare(`
    SELECT MAX(CAST(substr(certificate_no, 6) AS INTEGER)) AS max_seq
    FROM ordination_certificates
    WHERE certificate_no LIKE ?
  `).bind(`${year}-%`).first<{ max_seq?: number | null }>();
  const existingMax = Number(existing?.max_seq || 0);
  await db.prepare(`
    INSERT INTO document_sequences (seq_key, last_seq) VALUES (?, ?)
    ON CONFLICT(seq_key) DO UPDATE SET last_seq = MAX(document_sequences.last_seq, excluded.last_seq)
  `).bind(seqKey, existingMax).run();
  const row = await db.prepare(`UPDATE document_sequences SET last_seq=last_seq+1 WHERE seq_key=? RETURNING last_seq`)
    .bind(seqKey).first<{ last_seq?: number }>();
  const sequence = Number(row?.last_seq || existingMax + 1);
  return { certificateNo: `${year}-${String(sequence).padStart(2, '0')}`, issueYear: year, sequence };
};

export const writeManagementAudit = async (
  db: D1Database,
  user: SessionUser,
  category: string,
  action: string,
  targetId: string,
  details: Record<string, unknown> = {},
) => {
  await db.prepare(`
    INSERT INTO management_audit_logs
      (id,category,action,target_id,actor_user_id,actor_name,details_json,created_at)
    VALUES(?,?,?,?,?,?,?,?)
  `).bind(
    `MAL-${randomHex(24)}`, clean(category, 40), clean(action, 40), clean(targetId, 80),
    user.id, user.name, JSON.stringify(details).slice(0, 10000), new Date().toISOString(),
  ).run();
};

export const sanitizeRegisterContent = (type: RegisterType, value: unknown) => {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const field = (name: string, max: number) => clean(source[name], max);
  if (type === '공고대장') {
    return {
      noticeDate: field('noticeDate', 10),
      noticeNumber: field('noticeNumber', 60),
      noticeTitle: field('noticeTitle', 200),
      noticeBody: field('noticeBody', 5000),
      remarks: field('remarks', 1000),
    };
  }
  if (type === '관인날인기록부') {
    return {
      subject: field('subject', 200),
      sealCount: field('sealCount', 10),
      relatedBasis: field('relatedBasis', 300),
      sealType: field('sealType', 100),
      purpose: field('purpose', 1000),
      remarks: field('remarks', 1000),
    };
  }
  return {
    referenceDocument: field('referenceDocument', 200),
    purpose: field('purpose', 1000),
    recipientOrganization: field('recipientOrganization', 200),
    representativeName: field('representativeName', 100),
    businessNumber: field('businessNumber', 40),
    usageMethod: field('usageMethod', 200),
    usageStartDate: field('usageStartDate', 10),
    usageEndDate: field('usageEndDate', 10),
    usageCompletionDate: field('usageCompletionDate', 10),
    usageCount: field('usageCount', 10),
    contact: field('contact', 80),
    pledgeAccepted: source.pledgeAccepted === true || source.pledgeAccepted === 'true' || source.pledgeAccepted === 'on',
    remarks: field('remarks', 1000),
  };
};

export const registerTitle = (type: RegisterType, content: Record<string, string>) => {
  if (type === '공고대장') return clean(content.noticeTitle, 200);
  if (type === '관인날인기록부') return clean(content.subject, 200);
  return clean(content.purpose || content.recipientOrganization, 200);
};
