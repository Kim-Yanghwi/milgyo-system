import { clean } from './helpers';

export const FOREIGN_FORM_TYPES = [
  '거주숙소제공확인서',
  '통합신청서신고서',
  '사증발급인정신청서',
] as const;

export type ForeignFormType = typeof FOREIGN_FORM_TYPES[number];

export const FOREIGN_FORM_TITLES: Record<ForeignFormType, string> = {
  거주숙소제공확인서: '거주/숙소제공확인서 (Confirmation of Residence/Accommodation)',
  통합신청서신고서: '통합신청서(신고서) APPLICATION FORM (REPORT FORM)',
  사증발급인정신청서: '사증발급인정신청서 APPLICATION FOR CERTIFICATE OF VISA ELIGIBILITY',
};

export const isForeignFormType = (value: string): value is ForeignFormType =>
  FOREIGN_FORM_TYPES.includes(value as ForeignFormType);

const normalizeDateLikeValue = (value: string) =>
  /^(\d{4}-\d{2}-\d{2})(?:\s*\([^)]*\))?$/.test(value) ? value.replace(/\s*\([^)]*\)\s*$/, '') : value;

const sanitizeScalar = (value: unknown, maxLength = 3000) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return normalizeDateLikeValue(clean(value, maxLength));
};

export const sanitizeForeignSnapshot = (input: unknown): Record<string, unknown> => {
  const source = input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  const result: Record<string, unknown> = {};
  for (const [rawKey, rawValue] of Object.entries(source).slice(0, 180)) {
    const key = clean(rawKey, 80).replace(/[^A-Za-z0-9_.-]/g, '');
    if (!key) continue;
    if (Array.isArray(rawValue)) {
      result[key] = rawValue.slice(0, 40).map((value) => sanitizeScalar(value, 300));
    } else {
      result[key] = sanitizeScalar(rawValue);
    }
  }
  return result;
};

export const deriveForeignSubject = (type: ForeignFormType, snapshot: Record<string, unknown>) => {
  const value = (key: string) => clean(snapshot[key], 120);
  if (type === '거주숙소제공확인서') return value('residentFullName') || value('fullName');
  if (type === '통합신청서신고서') return [value('surname'), value('givenNames')].filter(Boolean).join(' ') || value('fullNameEnglish') || value('fullName') || value('name');
  return [value('familyName'), value('givenNames')].filter(Boolean).join(' ') || value('fullName');
};

export const deriveForeignNationality = (snapshot: Record<string, unknown>) =>
  clean(snapshot.nationality, 80);

export const ensureForeignFormTables = async (db: D1Database) => {
  await db.batch([
    db.prepare(`
      CREATE TABLE IF NOT EXISTS foreign_application_forms (
        id TEXT PRIMARY KEY,
        record_no TEXT NOT NULL UNIQUE,
        form_type TEXT NOT NULL,
        subject_name TEXT NOT NULL DEFAULT '',
        nationality TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT '저장',
        snapshot_json TEXT NOT NULL,
        created_by_user_id TEXT NOT NULL,
        created_by_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_printed_at TEXT,
        last_downloaded_at TEXT,
        print_count INTEGER NOT NULL DEFAULT 0,
        download_count INTEGER NOT NULL DEFAULT 0,
        canceled_at TEXT,
        canceled_by_name TEXT
      )
    `),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_foreign_application_forms_type_date ON foreign_application_forms(form_type, created_at DESC)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_foreign_application_forms_subject ON foreign_application_forms(subject_name, nationality)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_foreign_application_forms_creator ON foreign_application_forms(created_by_user_id, created_at DESC)`),
  ]);
};

export const makeForeignRecordNo = () => {
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const date = now.toISOString().slice(0, 10).replaceAll('-', '');
  const random = crypto.getRandomValues(new Uint8Array(4));
  const suffix = Array.from(random, (byte) => byte.toString(16).padStart(2, '0')).join('').toUpperCase();
  return `외국인-${date}-${suffix}`;
};
