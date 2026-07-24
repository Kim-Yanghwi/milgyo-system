// 종단관리시스템 공용 헬퍼 (documents, received 두 API 그룹이 공유)

export const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });

// NUL 문자 등 제어문자를 정규식 이스케이프 없이 문자 코드 비교로 걸러낸다.
export const clean = (value: unknown, maxLength: number) => {
  if (typeof value !== 'string') return '';
  const stripped = Array.from(value)
    .filter((ch) => ch.charCodeAt(0) !== 0)
    .join('');
  return stripped.trim().slice(0, maxLength);
};

export const toHex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');

export const sha256 = async (value: string) => {
  const encoded = new TextEncoder().encode(value);
  return toHex(await crypto.subtle.digest('SHA-256', encoded));
};

export const randomHex = (length = 16) => {
  const bytes = new Uint8Array(Math.ceil(length / 2));
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, length);
};

export const timingSafeEqual = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
};

export const getClientIp = (request: Request) => {
  const cfIp = request.headers.get('CF-Connecting-IP');
  if (cfIp) return cfIp;
  const forwardedFor = request.headers.get('X-Forwarded-For');
  if (forwardedFor) return forwardedFor.split(',')[0].trim();
  return 'unknown';
};

let tablesEnsured = false;
let lastRateLimitCleanupAt = 0;
const MAINTENANCE_COOLDOWN_MS = 10 * 60 * 1000;

export const ensureTables = async (db: D1Database) => {
  if (tablesEnsured) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      doc_type TEXT NOT NULL,
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      attachments_note TEXT NOT NULL DEFAULT '',
      drafter TEXT NOT NULL,
      department TEXT,
      recipient TEXT,
      approval_track TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT '결재대기',
      sent_method TEXT,
      sent_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS document_approvals (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      action TEXT NOT NULL,
      approver_name TEXT NOT NULL,
      approver_role TEXT,
      memo TEXT,
      created_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS received_documents (
      id TEXT PRIMARY KEY,
      direction TEXT NOT NULL,
      title TEXT NOT NULL,
      counterparty TEXT NOT NULL,
      source_system TEXT,
      external_doc_number TEXT,
      memo TEXT,
      handled_by TEXT NOT NULL,
      received_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS document_attachments (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      file_name TEXT NOT NULL,
      mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
      size_bytes INTEGER NOT NULL DEFAULT 0,
      data_base64 TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_documents_status ON documents (status)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_documents_created ON documents (created_at)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_document_approvals_doc ON document_approvals (document_id, created_at)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_received_documents_created ON received_documents (created_at)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_document_attachments_doc ON document_attachments (document_id, created_at)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS admin_rate_limits (
      id TEXT PRIMARY KEY,
      rate_key TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_admin_rate_limits_key_created
      ON admin_rate_limits (rate_key, created_at)`),
  ]);
  tablesEnsured = true;
};

const getAdminAuthRateKey = async (request: Request) =>
  sha256(`gov-admin-auth-failure:ip:${getClientIp(request)}`);

const cleanupExpiredRateLimits = async (db: D1Database, now: number) => {
  if (now - lastRateLimitCleanupAt <= MAINTENANCE_COOLDOWN_MS) return;
  await db.prepare(`DELETE FROM admin_rate_limits WHERE created_at < ?`)
    .bind(new Date(now - 24 * 60 * 60 * 1000).toISOString())
    .run();
  lastRateLimitCleanupAt = now;
};

export const checkAdminAuthRateLimit = async (db: D1Database, request: Request) => {
  await ensureTables(db);
  const now = Date.now();
  await cleanupExpiredRateLimits(db, now);

  const rateKey = await getAdminAuthRateKey(request);
  const checks = [
    { windowMs: 10 * 60 * 1000, max: 10, message: '관리자 인증 시도가 반복되었습니다. 잠시 후 다시 시도해 주세요.' },
    { windowMs: 24 * 60 * 60 * 1000, max: 30, message: '관리자 인증 시도 한도를 초과했습니다. 나중에 다시 시도해 주세요.' },
  ];

  const rows = await db.batch(
    checks.map((check) =>
      db.prepare(`SELECT COUNT(*) AS count FROM admin_rate_limits WHERE rate_key = ? AND created_at >= ?`)
        .bind(rateKey, new Date(now - check.windowMs).toISOString()),
    ),
  );

  for (let i = 0; i < checks.length; i += 1) {
    const row = (rows[i]?.results?.[0] || null) as Record<string, unknown> | null;
    if (Number(row?.count || 0) >= checks[i].max) {
      return { ok: false as const, message: checks[i].message };
    }
  }

  return { ok: true as const, rateKey };
};

export const recordAdminAuthFailure = async (db: D1Database, rateKey: string) => {
  await db.prepare(`INSERT INTO admin_rate_limits (id, rate_key, created_at) VALUES (?, ?, ?)`)
    .bind(`RL-${randomHex(24)}`, rateKey, new Date().toISOString())
    .run();
};

export const clearAdminAuthFailures = async (db: D1Database, rateKey: string) => {
  await db.prepare(`DELETE FROM admin_rate_limits WHERE rate_key = ?`)
    .bind(rateKey)
    .run();
};

export const verifyAdminToken = async (submittedToken: string, expectedToken: string) => {
  if (!submittedToken || !expectedToken) return false;
  const [submittedDigest, expectedDigest] = await Promise.all([
    sha256(submittedToken),
    sha256(expectedToken),
  ]);
  return timingSafeEqual(submittedDigest, expectedDigest);
};

// 문서관리및사무관리규정 제13조③ — 이사장 결재(또는 이사회 의결)를 원칙으로 하는 중요문서 10개 항목.
export const IMPORTANT_CATEGORIES = [
  '주무관청 제출자료',
  '법인 설립·변경·등기·허가·신고 관련 문서',
  '정관·내부규정 제·개정 자료',
  '총회·이사회 안건 및 의사록',
  '예산·결산·사업계획·사업실적 관련 문서',
  '계약서·협약서·양해각서 및 재산 관련 문서',
  '인사·보수·위촉·해촉·징계 관련 문서',
  '후원금·보시금·목적지정 기부금 관련 중요 문서',
  '법인의 공식 입장 또는 대외 발표자료',
  '그 밖에 법인의 권리·의무에 중요한 영향을 미치는 문서',
] as const;

export const ROUTINE_CATEGORY = '일반(경미한 내부보고·단순사무 — 전결대상)';
export const ALL_CATEGORIES = [...IMPORTANT_CATEGORIES, ROUTINE_CATEGORY];

export const resolveApprovalTrack = (category: string, requestedTrack?: string) => {
  const isImportant = (IMPORTANT_CATEGORIES as readonly string[]).includes(category);
  if (!isImportant) return '전결';
  if (requestedTrack === '이사회의결') return '이사회의결';
  return '이사장결재';
};

export const makeDocumentNumber = async (db: D1Database, now: Date) => {
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const year = kst.getUTCFullYear();
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year + 1}-01-01`;
  const row = await db.prepare(
    `SELECT COUNT(*) AS count FROM documents WHERE created_at >= ? AND created_at < ?`,
  ).bind(yearStart, yearEnd).first<{ count: number }>();
  const seq = Number(row?.count || 0) + 1;
  return `밀교종-${year}-${String(seq).padStart(3, '0')}`;
};

export const makeReceivedNumber = async (db: D1Database, now: Date, direction: string) => {
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const year = kst.getUTCFullYear();
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year + 1}-01-01`;
  const row = await db.prepare(
    `SELECT COUNT(*) AS count FROM received_documents WHERE created_at >= ? AND created_at < ? AND direction = ?`,
  ).bind(yearStart, yearEnd, direction).first<{ count: number }>();
  const seq = Number(row?.count || 0) + 1;
  const prefix = direction === '접수' ? '접수' : '외부발송';
  return `${prefix}-${year}-${String(seq).padStart(3, '0')}`;
};
