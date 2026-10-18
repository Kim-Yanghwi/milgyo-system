/** 승적정보는 종단 내부용입니다. 공개 응답·발급증명서에 내부 필드를 섞지 마세요. */
import { clean, isValidIsoDate } from './helpers';

export const MONASTIC_STATUSES = ['재적', '제적', '기타'] as const;
export const MONASTIC_CHANGE_TYPES = ['최초 취적', '재적 변경', '법명 변경', '수계 정정', '법계 변경', '제적', '복적', '입적(入寂)', '기타 정정'] as const;
export const MONASTIC_ORDINATION_TYPES = ['사미·사미니계', '구족계', '기타 수계', '법계 / 품수'] as const;
export const MONASTIC_CONSENT_CHOICES = ['동의', '비동의'] as const;
export const MONASTIC_RETENTION_CHOICES = ['1년', '2년', '3년', '4년', '5년', '10년', '준영구', '영구'] as const;
export const MONASTIC_USER_REF = /^user:[A-Za-z0-9_-]{1,70}$/;
export const MONASTIC_ROUNDS = Array.from({ length: 30 }, (_, i) => String(i + 1).padStart(2, '0'));
export const isMonasticRound = (value: unknown): value is string => typeof value === 'string' && MONASTIC_ROUNDS.includes(value);

/** 수계·취득 연도에 따른 승적번호. 수계 기록의 첫 연도를 우선하며, 기록이 없으면 승적 취득일을 사용합니다. */
export const monasticYearFromContent = (data: Pick<RegistryContent, 'ordination' | 'acquiredDate'>): string => {
  const suGye = data.ordination
    .filter((row) => row.date && isValidIsoDate(row.date) && row.kind !== '법계 / 품수')
    .map((row) => row.date).sort();
  const date = suGye[0] || data.acquiredDate;
  if (!isValidIsoDate(date)) throw new Error('수계·승적 취득일이 올바르지 않습니다.');
  return date.slice(0, 4);
};

export const monasticNumberPrefix = (round: string, year: string): string => {
  if (!isMonasticRound(round) || !/^\d{4}$/.test(year)) throw new Error('계단 회차 또는 수계 연도가 올바르지 않습니다.');
  return `${round}${year.slice(-2)}-`;
};

/** 기존 수기 번호도 보존하면서, 새 형식의 채번은 D1 시퀀스로 원자적 예약합니다. */
export const nextMonasticNumber = async (db: D1Database, round: string, year: string, reserve: boolean): Promise<string> => {
  const prefix = monasticNumberPrefix(round, year);
  const suffixStart = prefix.length + 1;
  const maxRow = await db.prepare(`SELECT MAX(CAST(SUBSTR(monastic_no, ?) AS INTEGER)) AS last_num
    FROM monastic_registry WHERE monastic_no LIKE ? AND SUBSTR(monastic_no, ?) <> ''
    AND SUBSTR(monastic_no, ?) NOT GLOB '*[^0-9]*'`)
    .bind(suffixStart, `${prefix}%`, suffixStart, suffixStart).first<{ last_num: number | null }>();
  const key = `MONASTIC:NO:${prefix.slice(0, 4)}`; // two digits of round + two digits of year
  const initial = Number(maxRow?.last_num || 0);
  if (!reserve) {
    const sequence = await db.prepare('SELECT last_seq FROM document_sequences WHERE seq_key=?')
      .bind(key).first<{ last_seq: number }>();
    return `${prefix}${String(Math.max(initial, Number(sequence?.last_seq || 0)) + 1).padStart(3, '0')}`;
  }
  await db.prepare(`INSERT INTO document_sequences(seq_key,last_seq) VALUES(?,?)
    ON CONFLICT(seq_key) DO UPDATE SET last_seq=MAX(document_sequences.last_seq,excluded.last_seq)`)
    .bind(key, initial).run();
  const result = await db.prepare('UPDATE document_sequences SET last_seq=last_seq+1 WHERE seq_key=? RETURNING last_seq')
    .bind(key).first<{ last_seq: number }>();
  if (!Number.isSafeInteger(result?.last_seq) || Number(result!.last_seq) < 1) throw new Error('승적번호 채번에 실패했습니다.');
  return `${prefix}${String(result!.last_seq).padStart(3, '0')}`;
};

export type MonasticStatus = typeof MONASTIC_STATUSES[number];
export const monasticToday = () => new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
export const isDateOrEmpty = (s: string) => !s || isValidIsoDate(s);
export const parseArray = (value: unknown): Record<string, string>[] => {
  if (Array.isArray(value)) return value.filter((item) => item && typeof item === 'object') as Record<string, string>[];
  try { const items = JSON.parse(String(value || '[]')); return Array.isArray(items) ? items : []; }
  catch { return []; }
};
const value = (source: Record<string, unknown>, key: string, limit: number) => clean(source[key], limit);
export interface RegistryContent {
  monasticNo: string; dharmaNameKo: string; dharmaNameHanja: string; layName: string;
  birthDate: string; status: MonasticStatus; temple: string; acquiredDate: string;
  mentorName: string; positionTitle: string; contact: string; managingOffice: string;
  firstRegisteredDate: string; lastVerifiedDate: string;
  ordination: Record<string, string>[]; career: Record<string, string>[];
  accessScope: string; processingBasis: string; sensitiveBasis: string;
  retentionPeriod: string; storageLocation: string; preparedBy: string;
  reviewedBy: string; approvedBy: string;
}
export const registryFields = [
  'monastic_no', 'dharma_name_ko', 'dharma_name_hanja', 'lay_name', 'birth_date', 'status',
  'temple', 'acquired_date', 'mentor_name', 'position_title', 'contact', 'managing_office',
  'first_registered_date', 'last_verified_date', 'ordination_json', 'career_json',
  'access_scope', 'processing_basis', 'sensitive_basis', 'retention_period',
  'storage_location', 'prepared_by', 'reviewed_by', 'approved_by',
] as const;
export const serializeRegistry = (v: RegistryContent): unknown[] => [
  v.monasticNo, v.dharmaNameKo, v.dharmaNameHanja, v.layName, v.birthDate, v.status,
  v.temple, v.acquiredDate, v.mentorName, v.positionTitle, v.contact, v.managingOffice,
  v.firstRegisteredDate, v.lastVerifiedDate, JSON.stringify(v.ordination), JSON.stringify(v.career),
  v.accessScope, v.processingBasis, v.sensitiveBasis, v.retentionPeriod,
  v.storageLocation, v.preparedBy, v.reviewedBy, v.approvedBy,
];
export const normalizeRegistryInput = (data: unknown, allowAutoNumber = false): { ok: true; content: RegistryContent } | { ok: false; message: string } => {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, message: '승적원부 입력자료가 올바르지 않습니다.' };
  const s = data as Record<string, unknown>;
  const status = value(s, 'status', 10);
  if (!MONASTIC_STATUSES.includes(status as MonasticStatus)) return { ok: false, message: '승적 상태를 선택해 주세요.' };
  const pickRows = (key: string, fields: [string, number][], max: number) => {
    const incoming = s[key];
    if (!Array.isArray(incoming) || incoming.length > max) return null;
    return incoming.map((entry) => {
      const item: Record<string, unknown> = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {};
      const normalized: Record<string, string> = {};
      for (const [name, length] of fields) normalized[name] = value(item, name, length);
      return normalized;
    });
  };
  const ordination = pickRows('ordination', [['kind', 30], ['date', 10], ['place', 120], ['teacher', 120], ['evidence', 200]], 12);
  const career = pickRows('career', [['period', 100], ['fromDate', 10], ['toDate', 10], ['institution', 120], ['position', 120], ['evidence', 200]], 20);
  if (!ordination || !career) return { ok: false, message: '수계·경력 항목의 최대 개수를 확인해 주세요.' };
  for (const record of ordination) {
    if (record.kind && !MONASTIC_ORDINATION_TYPES.includes(record.kind as typeof MONASTIC_ORDINATION_TYPES[number])) return { ok: false, message: '수계·법계 항목의 종류가 올바르지 않습니다.' };
    if (record.date && !isValidIsoDate(record.date)) return { ok: false, message: '수계·법계 일자를 확인해 주세요.' };
  }
  for (const record of career) {
    if (!record.fromDate && !record.toDate) continue; // 과거 자유 입력 기간도 읽기·정정 시 보존
    if (!isValidIsoDate(record.fromDate) || !isValidIsoDate(record.toDate) || record.fromDate > record.toDate) {
      return { ok: false, message: '활동 시작일과 종료일을 정확히 입력하고 날짜 순서를 확인해 주세요.' };
    }
    record.period = `${record.fromDate} ~ ${record.toDate}`;
  }
  const result: RegistryContent = {
    monasticNo: value(s, 'monasticNo', 60), dharmaNameKo: value(s, 'dharmaNameKo', 80),
    dharmaNameHanja: value(s, 'dharmaNameHanja', 80), layName: value(s, 'layName', 80),
    birthDate: value(s, 'birthDate', 10), status: status as MonasticStatus,
    temple: value(s, 'temple', 120), acquiredDate: value(s, 'acquiredDate', 10),
    mentorName: value(s, 'mentorName', 100), positionTitle: value(s, 'positionTitle', 100),
    contact: value(s, 'contact', 80), managingOffice: value(s, 'managingOffice', 120),
    firstRegisteredDate: value(s, 'firstRegisteredDate', 10) || monasticToday(),
    lastVerifiedDate: value(s, 'lastVerifiedDate', 10) || monasticToday(),
    ordination, career, accessScope: value(s, 'accessScope', 200) || '승적관리 담당자',
    processingBasis: value(s, 'processingBasis', 300), sensitiveBasis: value(s, 'sensitiveBasis', 300),
    retentionPeriod: value(s, 'retentionPeriod', 160), storageLocation: value(s, 'storageLocation', 200),
    preparedBy: value(s, 'preparedBy', 80), reviewedBy: value(s, 'reviewedBy', 80), approvedBy: value(s, 'approvedBy', 80),
  };
  if ((!allowAutoNumber && !/^[^\s\u0000-\u001f]{1,60}$/.test(result.monasticNo)) || !result.dharmaNameKo || !result.acquiredDate) {
    return { ok: false, message: '승적번호·법명(한글)·승적 취득일은 필수입니다.' };
  }
  for (const date of [result.birthDate, result.acquiredDate, result.firstRegisteredDate, result.lastVerifiedDate]) {
    if (!isDateOrEmpty(date)) return { ok: false, message: '날짜를 YYYY-MM-DD로 정확히 입력해 주세요.' };
  }
  if (!MONASTIC_CONSENT_CHOICES.includes(result.processingBasis as typeof MONASTIC_CONSENT_CHOICES[number]) ||
      !MONASTIC_CONSENT_CHOICES.includes(result.sensitiveBasis as typeof MONASTIC_CONSENT_CHOICES[number])) {
    return { ok: false, message: '개인정보·민감정보 항목은 동의 또는 비동의 중 하나를 선택해 주세요.' };
  }
  if (result.retentionPeriod && !MONASTIC_RETENTION_CHOICES.includes(result.retentionPeriod as typeof MONASTIC_RETENTION_CHOICES[number])) {
    return { ok: false, message: '정해진 보유기간 중 하나를 선택해 주세요.' };
  }
  return { ok: true, content: result };
};

export const toRegistryResponse = (row: Record<string, unknown>) => ({
  ...row,
  ordination: parseArray(row.ordination_json), career: parseArray(row.career_json),
});

/** 대외발급서에는 서식에 명시된 성명(속명)만 포함하고 생년월일·개인연락처·수계기록은 제외합니다. */
export const toPublicCertificateSnapshot = (row: Record<string, unknown>, options: {
  certificateNo: string; issueDate: string; purpose: string; signatoryTitle: string;
  signatoryName: string; includeLogo: boolean; managerName: string; contact: string;
}) => ({
  certificateNo: options.certificateNo,
  monasticNo: String(row.monastic_no), dharmaName: String(row.dharma_name_ko),
  layName: String(row.lay_name),
  status: String(row.status), organization: '대한불교밀교종', temple: String(row.temple || ''),
  acquiredDate: String(row.acquired_date), verificationDate: String(row.last_verified_date),
  issueDate: options.issueDate, purpose: options.purpose, signatoryTitle: options.signatoryTitle,
  signatoryName: options.signatoryName, includeLogo: options.includeLogo,
  managerName: options.managerName, contact: options.contact,
  templateVersion: 'monastic-v1',
});

export const nextMonasticSequence = async (db: D1Database, kind: 'REGISTRY' | 'CERT', date: string): Promise<string> => {
  const year = date.slice(0, 4);
  const prefix = kind === 'REGISTRY' ? `승적원부-${year}-` : `승적-${year}-`;
  const table = kind === 'REGISTRY' ? 'monastic_registry' : 'monastic_certificates';
  const column = kind === 'REGISTRY' ? 'register_no' : 'certificate_no';
  const last = await db.prepare(`SELECT MAX(CAST(substr(${column},?) AS INTEGER)) AS last_num FROM ${table} WHERE ${column} LIKE ?`)
    .bind(prefix.length + 1, `${prefix}%`).first<{ last_num: number | null }>();
  const key = `MONASTIC:${kind}:${year}`;
  await db.prepare(`INSERT INTO document_sequences(seq_key,last_seq) VALUES(?,?) ON CONFLICT(seq_key) DO UPDATE SET last_seq=MAX(document_sequences.last_seq,excluded.last_seq)`)
    .bind(key, Number(last?.last_num || 0)).run();
  const seq = await db.prepare(`UPDATE document_sequences SET last_seq=last_seq+1 WHERE seq_key=? RETURNING last_seq`)
    .bind(key).first<{ last_seq: number }>();
  return `${prefix}${String(Number(seq?.last_seq || 0)).padStart(5, '0')}`;
};
