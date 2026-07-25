// 종단관리시스템 공용 헬퍼

export const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
    },
  });

export const clean = (value: unknown, maxLength: number) => {
  if (typeof value !== 'string') return '';
  const stripped = Array.from(value)
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      return code === 9 || code === 10 || code === 13 || code >= 32;
    })
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
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

export const getClientIp = (request: Request) => {
  const cfIp = request.headers.get('CF-Connecting-IP');
  if (cfIp) return cfIp;
  const forwardedFor = request.headers.get('X-Forwarded-For');
  if (forwardedFor) return forwardedFor.split(',')[0].trim();
  return 'unknown';
};

const bytesToBase64 = (bytes: Uint8Array) => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const base64ToBytes = (value: string) => {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
};

// 새 비밀번호는 PBKDF2로 저장합니다. 기존 salt:sha256 형식도 계속 검증해 자동 호환합니다.
const PBKDF2_ITERATIONS = 120_000;
export const hashPassword = async (password: string) => {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS },
    key,
    256,
  );
  return `pbkdf2$${PBKDF2_ITERATIONS}$${bytesToBase64(salt)}$${bytesToBase64(new Uint8Array(bits))}`;
};

export const verifyPassword = async (password: string, stored: string) => {
  if (!stored) return false;
  if (stored.startsWith('pbkdf2$')) {
    const [, iterationText, saltText, expectedText] = stored.split('$');
    const iterations = Number(iterationText);
    if (!iterations || !saltText || !expectedText) return false;
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: base64ToBytes(saltText), iterations },
      key,
      256,
    );
    return timingSafeEqual(bytesToBase64(new Uint8Array(bits)), expectedText);
  }
  if (!stored.includes(':')) return false;
  const [salt, expectedHash] = stored.split(':');
  const actualHash = await sha256(`${salt}:${password}`);
  return timingSafeEqual(actualHash, expectedHash);
};

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

export type TemplateField = {
  id: string;
  label: string;
  type: 'text' | 'textarea' | 'number' | 'date' | 'time' | 'select' | 'checkbox';
  required?: boolean;
  options?: string[];
  placeholder?: string;
  defaultValue?: string;
  width?: 'full' | 'half';
};

const BUILT_IN_TEMPLATES = [
  {
    id: 'TPL-GENERAL', name: '일반 기안서(내부결재)', description: '업무계획, 협조요청, 승인요청, 개선안 등 일반 내부기안',
    docType: '기안', category: ROUTINE_CATEGORY, titlePrefix: '[일반기안] ',
    fields: [
      { id: 'proposalType', label: '기안구분', type: 'select', required: true, options: ['업무계획', '협조요청', '승인요청', '개선안', '기타'], width: 'half' },
      { id: 'subject', label: '건명', type: 'text', required: true, placeholder: '기안 건명을 입력해 주세요.', width: 'full' },
      { id: 'background', label: '추진배경', type: 'textarea', required: true, width: 'full' },
      { id: 'mainContent', label: '주요내용', type: 'textarea', required: true, width: 'full' },
      { id: 'schedule', label: '추진 일정', type: 'textarea', required: false, placeholder: '구분 / 일시 / 내용 / 담당 / 비고', width: 'full' },
      { id: 'budgetAmount', label: '소요 예산(원)', type: 'number', required: false, defaultValue: '0', width: 'half' },
      { id: 'budgetSource', label: '예산과목 또는 재원', type: 'text', required: false, width: 'half' },
      { id: 'basis', label: '관련 근거', type: 'textarea', required: false, width: 'full' },
      { id: 'cooperation', label: '협조사항', type: 'textarea', required: false, width: 'full' },
    ],
    bodyTemplate: '1. 기안 구분: {{proposalType}}\n2. 건명: {{subject}}\n3. 추진 배경\n{{background}}\n\n4. 주요 내용\n{{mainContent}}\n\n5. 추진 일정\n{{schedule}}\n\n6. 소요 예산\n  - 금액: {{budgetAmount}}원\n  - 예산과목 또는 재원: {{budgetSource}}\n7. 관련 근거\n{{basis}}\n\n8. 협조 사항\n{{cooperation}}',
  },
  {
    id: 'TPL-EXPENSE-REQUEST', name: '지출품의서', description: '지출 전 필요성·예산·거래처·금액을 승인받는 서식',
    docType: '기안', category: '예산·결산·사업계획·사업실적 관련 문서', titlePrefix: '[지출품의] ',
    fields: [
      { id: 'fiscalYear', label: '회계연도', type: 'number', required: true, defaultValue: '{{CURRENT_YEAR}}', width: 'half' },
      { id: 'businessName', label: '사업·업무명', type: 'text', required: true, width: 'half' },
      { id: 'expenseType', label: '지출 구분', type: 'select', required: true, options: ['운영비', '사업비', '인건비', '시설비', '기타'], width: 'half' },
      { id: 'budgetItem', label: '예산과목', type: 'text', required: true, width: 'half' },
      { id: 'basis', label: '관련근거', type: 'text', required: false, width: 'full' },
      { id: 'purpose', label: '지출 목적·필요성', type: 'textarea', required: true, width: 'full' },
      { id: 'payee', label: '거래처·지급예정대상', type: 'text', required: true, width: 'half' },
      { id: 'paymentDate', label: '지급 예정일', type: 'date', required: true, width: 'half' },
      { id: 'supplyAmount', label: '공급가액(원)', type: 'number', required: true, defaultValue: '0', width: 'half' },
      { id: 'vatAmount', label: '부가세(원)', type: 'number', required: true, defaultValue: '0', width: 'half' },
      { id: 'totalAmount', label: '합계(원)', type: 'number', required: false, defaultValue: '0', width: 'half' },
      { id: 'contractType', label: '구매·계약 여부', type: 'select', required: true, options: ['단순지급', '물품구매', '용역계약', '임차', '공사', '기타'], width: 'half' },
      { id: 'priceCheck', label: '견적·가격조사 결과', type: 'textarea', required: false, width: 'full' },
      { id: 'importantAsset', label: '기본재산·중요재산 관련 여부', type: 'select', required: true, options: ['미해당', '해당'], width: 'half' },
    ],
    bodyTemplate: '1. 회계연도: {{fiscalYear}}\n2. 사업·업무명: {{businessName}}\n3. 지출 구분 / 예산과목: {{expenseType}} / {{budgetItem}}\n4. 관련 근거: {{basis}}\n5. 지출 목적·필요성\n{{purpose}}\n\n6. 거래처·지급예정대상: {{payee}}\n7. 지급 예정일: {{paymentDate}}\n8. 금액내역\n  - 공급가액: {{supplyAmount}}원\n  - 부가세: {{vatAmount}}원\n  - 합계: {{totalAmount}}원\n9. 구매·계약 여부: {{contractType}}\n10. 견적·가격조사 결과\n{{priceCheck}}\n11. 기본재산·중요재산 관련 여부: {{importantAsset}}',
  },
  {
    id: 'TPL-EXPENSE-RESOLUTION', name: '지출결의서', description: '승인된 지출의 실제 지급 및 증빙을 확정하는 서식',
    docType: '기안', category: '예산·결산·사업계획·사업실적 관련 문서', titlePrefix: '[지출결의] ',
    fields: [
      { id: 'fiscalYear', label: '회계연도', type: 'number', required: true, defaultValue: '{{CURRENT_YEAR}}', width: 'half' },
      { id: 'businessName', label: '사업·업무명', type: 'text', required: true, width: 'half' },
      { id: 'expenseType', label: '지출 구분', type: 'select', required: true, options: ['운영비', '사업비', '인건비', '시설비', '기타'], width: 'half' },
      { id: 'budgetItem', label: '예산과목', type: 'text', required: true, width: 'half' },
      { id: 'basis', label: '관련근거', type: 'text', required: false, width: 'full' },
      { id: 'purpose', label: '지출 목적·필요성', type: 'textarea', required: true, width: 'full' },
      { id: 'payee', label: '거래처·지급대상', type: 'text', required: true, width: 'half' },
      { id: 'paymentDate', label: '지급일', type: 'date', required: true, width: 'half' },
      { id: 'supplyAmount', label: '공급가액(원)', type: 'number', required: true, defaultValue: '0', width: 'half' },
      { id: 'vatAmount', label: '부가세(원)', type: 'number', required: true, defaultValue: '0', width: 'half' },
      { id: 'totalAmount', label: '합계(원)', type: 'number', required: false, defaultValue: '0', width: 'half' },
      { id: 'paymentMethod', label: '지급방법', type: 'select', required: true, options: ['계좌이체', '법인카드', '현금', '기타'], width: 'half' },
      { id: 'contractType', label: '구매·계약 여부', type: 'select', required: true, options: ['단순지급', '물품구매', '용역계약', '임차', '공사', '기타'], width: 'half' },
      { id: 'priceCheck', label: '견적·가격조사 결과', type: 'textarea', required: false, width: 'full' },
      { id: 'importantAsset', label: '기본재산·중요재산 관련 여부', type: 'select', required: true, options: ['미해당', '해당'], width: 'half' },
    ],
    bodyTemplate: '1. 회계연도: {{fiscalYear}}\n2. 사업·업무명: {{businessName}}\n3. 지출 구분 / 예산과목: {{expenseType}} / {{budgetItem}}\n4. 관련 근거: {{basis}}\n5. 지출 목적·필요성\n{{purpose}}\n\n6. 거래처·지급대상: {{payee}}\n7. 지급일: {{paymentDate}}\n8. 금액내역\n  - 공급가액: {{supplyAmount}}원\n  - 부가세: {{vatAmount}}원\n  - 합계: {{totalAmount}}원\n9. 지급방법: {{paymentMethod}}\n10. 구매·계약 여부: {{contractType}}\n11. 견적·가격조사 결과\n{{priceCheck}}\n12. 기본재산·중요재산 관련 여부: {{importantAsset}}',
  },
  {
    id: 'TPL-MEETING-PLAN', name: '회의 개최 계획서', description: '총회·이사회·업무회의 등 개최계획과 안건을 사전 승인받는 서식',
    docType: '기안', category: '총회·이사회 안건 및 의사록', titlePrefix: '[회의계획] ',
    fields: [
      { id: 'meetingName', label: '회의명', type: 'text', required: true, width: 'full' },
      { id: 'meetingType', label: '회의 구분', type: 'select', required: true, options: ['업무회의', '정기이사회', '임시이사회', '정기총회', '임시총회', '위원회', '기타'], width: 'half' },
      { id: 'purpose', label: '개최 목적', type: 'textarea', required: true, width: 'full' },
      { id: 'startDate', label: '시작일', type: 'date', required: true, width: 'half' },
      { id: 'endDate', label: '종료일', type: 'date', required: true, width: 'half' },
      { id: 'startTime', label: '시작시간', type: 'time', required: true, width: 'half' },
      { id: 'endTime', label: '종료시간', type: 'time', required: true, width: 'half' },
      { id: 'place', label: '장소·접속방법', type: 'text', required: true, width: 'full' },
      { id: 'attendees', label: '참석 대상', type: 'textarea', required: true, width: 'full' },
      { id: 'agenda', label: '주요 안건', type: 'textarea', required: true, placeholder: '1. 안건명 / 설명자 / 배정시간', width: 'full' },
    ],
    bodyTemplate: '1. 회의명: {{meetingName}}\n2. 회의 구분: {{meetingType}}\n3. 개최 목적\n{{purpose}}\n\n4. 일시: {{startDate}} {{startTime}} ~ {{endDate}} {{endTime}}\n5. 장소·접속방법: {{place}}\n6. 참석 대상\n{{attendees}}\n\n7. 주요 안건\n{{agenda}}',
  },
] as const;

let tablesEnsured = false;
let tablesEnsurePromise: Promise<void> | null = null;
let lastRateLimitCleanupAt = 0;
const MAINTENANCE_COOLDOWN_MS = 10 * 60 * 1000;
const SCHEMA_VERSION = '2026-07-25.5';

const ensureColumn = async (db: D1Database, table: string, columnDef: string) => {
  try {
    await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`).run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // 기존 컬럼이 이미 있는 경우만 정상으로 간주합니다. 다른 마이그레이션 오류는 숨기지 않습니다.
    if (!/duplicate column name|already exists/i.test(message)) throw error;
  }
};

const seedTemplates = async (db: D1Database) => {
  const now = new Date().toISOString();
  await db.batch(BUILT_IN_TEMPLATES.map((template) => db.prepare(`
    INSERT INTO document_templates
      (id, name, description, doc_type, category, title_prefix, fields_json, body_template, is_system, active, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 'system', ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, description=excluded.description, doc_type=excluded.doc_type,
      category=excluded.category, title_prefix=excluded.title_prefix,
      fields_json=excluded.fields_json, body_template=excluded.body_template,
      is_system=1, updated_at=excluded.updated_at
  `).bind(
    template.id, template.name, template.description, template.docType, template.category,
    template.titlePrefix, JSON.stringify(template.fields), template.bodyTemplate, now, now,
  )));
};

const runSchemaMigration = async (db: D1Database) => {
  // 1단계: 기존 컬럼 유무와 무관한 기본 테이블만 먼저 준비합니다.
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS system_users (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
      position TEXT, grade TEXT, department TEXT, role TEXT NOT NULL DEFAULT 'user',
      can_approve INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS system_sessions (
      token TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY, doc_type TEXT NOT NULL, category TEXT NOT NULL, title TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '', attachments_note TEXT NOT NULL DEFAULT '',
      drafter TEXT NOT NULL, drafter_user_id TEXT, drafter_position TEXT,
      reviewer_user_id TEXT, reviewer_name TEXT, reviewer_position TEXT,
      approver_user_id TEXT, approver_name TEXT, approver_position TEXT,
      department TEXT, recipient TEXT, via TEXT, approval_track TEXT NOT NULL, approval_mode TEXT NOT NULL DEFAULT '결재',
      status TEXT NOT NULL DEFAULT '결재대기', sent_method TEXT, sent_at TEXT,
      template_id TEXT, template_name TEXT, form_data_json TEXT NOT NULL DEFAULT '{}',
      access_scope TEXT NOT NULL DEFAULT '전체', client_request_id TEXT,
      submitted_at TEXT, completed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS document_approvals (
      id TEXT PRIMARY KEY, document_id TEXT NOT NULL, action TEXT NOT NULL, approver_name TEXT NOT NULL,
      approver_role TEXT, memo TEXT, created_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS document_approval_lines (
      id TEXT PRIMARY KEY, document_id TEXT NOT NULL, line_order INTEGER NOT NULL,
      line_type TEXT NOT NULL, user_id TEXT NOT NULL, user_name TEXT NOT NULL, user_position TEXT,
      status TEXT NOT NULL DEFAULT '예정', acted_at TEXT, memo TEXT, created_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS received_documents (
      id TEXT PRIMARY KEY, direction TEXT NOT NULL, title TEXT NOT NULL, counterparty TEXT NOT NULL,
      source_system TEXT, external_doc_number TEXT, memo TEXT, department TEXT, related_document_id TEXT,
      handled_by TEXT NOT NULL, handled_by_user_id TEXT, received_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS document_attachments (
      id TEXT PRIMARY KEY, document_id TEXT NOT NULL, file_name TEXT NOT NULL,
      mime_type TEXT NOT NULL DEFAULT 'application/octet-stream', size_bytes INTEGER NOT NULL DEFAULT 0,
      data_base64 TEXT NOT NULL DEFAULT '', storage_type TEXT NOT NULL DEFAULT 'd1', r2_key TEXT, created_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS received_attachments (
      id TEXT PRIMARY KEY, received_document_id TEXT NOT NULL, file_name TEXT NOT NULL,
      mime_type TEXT NOT NULL DEFAULT 'application/octet-stream', size_bytes INTEGER NOT NULL DEFAULT 0,
      data_base64 TEXT NOT NULL DEFAULT '', storage_type TEXT NOT NULL DEFAULT 'd1', r2_key TEXT, created_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS document_templates (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', doc_type TEXT NOT NULL DEFAULT '기안',
      category TEXT NOT NULL, title_prefix TEXT NOT NULL DEFAULT '', fields_json TEXT NOT NULL DEFAULT '[]',
      body_template TEXT NOT NULL DEFAULT '', is_system INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
      created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS document_sequences (seq_key TEXT PRIMARY KEY, last_seq INTEGER NOT NULL DEFAULT 0)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS admin_rate_limits (id TEXT PRIMARY KEY, rate_key TEXT NOT NULL, created_at TEXT NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS org_settings (id TEXT PRIMARY KEY, seal_image TEXT, logo_image TEXT, updated_at TEXT NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS system_meta (meta_key TEXT PRIMARY KEY, meta_value TEXT NOT NULL, updated_at TEXT NOT NULL)`),
  ]);

  // 2단계: 운영 중인 구버전 DB에 필요한 컬럼을 순차적으로 추가합니다.
  // Promise.all로 ALTER TABLE을 동시에 실행하면 D1에서 스키마 잠금 충돌이 날 수 있으므로 반드시 순차 실행합니다.
  const columns: Array<[string, string]> = [
    ['documents', `summary TEXT NOT NULL DEFAULT ''`],
    ['documents', 'drafter_user_id TEXT'], ['documents', 'drafter_position TEXT'],
    ['documents', 'reviewer_user_id TEXT'], ['documents', 'reviewer_name TEXT'], ['documents', 'reviewer_position TEXT'],
    ['documents', 'approver_user_id TEXT'], ['documents', 'approver_name TEXT'], ['documents', 'approver_position TEXT'],
    ['documents', 'via TEXT'], ['documents', `approval_mode TEXT NOT NULL DEFAULT '결재'`], ['documents', 'template_id TEXT'], ['documents', 'template_name TEXT'],
    ['documents', `form_data_json TEXT NOT NULL DEFAULT '{}'`], ['documents', `access_scope TEXT NOT NULL DEFAULT '전체'`],
    ['documents', 'client_request_id TEXT'], ['documents', 'submitted_at TEXT'], ['documents', 'completed_at TEXT'],
    ['system_users', 'department TEXT'],
    ['received_documents', 'department TEXT'], ['received_documents', 'related_document_id TEXT'],
    ['received_documents', 'handled_by_user_id TEXT'], ['received_documents', 'updated_at TEXT'],
    ['document_attachments', `storage_type TEXT NOT NULL DEFAULT 'd1'`], ['document_attachments', 'r2_key TEXT'],
    ['received_attachments', `storage_type TEXT NOT NULL DEFAULT 'd1'`], ['received_attachments', 'r2_key TEXT'],
  ];
  for (const [table, column] of columns) await ensureColumn(db, table, column);

  const now = new Date().toISOString();
  await db.prepare(`UPDATE received_documents SET updated_at = COALESCE(updated_at, created_at, ?) WHERE updated_at IS NULL`)
    .bind(now).run();

  // 3단계: 새 컬럼이 준비된 후에만 해당 컬럼을 사용하는 인덱스를 만듭니다.
  await db.batch([
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_documents_status ON documents (status)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_documents_created ON documents (created_at)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_document_approvals_doc ON document_approvals (document_id, created_at)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_document_approval_lines_doc ON document_approval_lines (document_id, line_order)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_document_approval_lines_pending ON document_approval_lines (user_id, status, document_id)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_received_documents_created ON received_documents (created_at)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_received_documents_handler ON received_documents (handled_by_user_id, created_at)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_document_attachments_doc ON document_attachments (document_id, created_at)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_received_attachments_doc ON received_attachments (received_document_id, created_at)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_system_sessions_user ON system_sessions (user_id)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_admin_rate_limits_key_created ON admin_rate_limits (rate_key, created_at)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_documents_approver ON documents (approver_user_id, status)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_documents_reviewer ON documents (reviewer_user_id, status)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_documents_drafter ON documents (drafter_user_id, status)`),
    db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_request_id ON documents (client_request_id) WHERE client_request_id IS NOT NULL`),
  ]);

  await seedTemplates(db);
  await db.prepare(`
    INSERT INTO system_meta (meta_key, meta_value, updated_at)
    VALUES ('schema_version', ?, ?)
    ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value, updated_at=excluded.updated_at
  `).bind(SCHEMA_VERSION, new Date().toISOString()).run();
};

const hasCurrentSchema = async (db: D1Database) => {
  try {
    const row = await db.prepare(`SELECT meta_value FROM system_meta WHERE meta_key = 'schema_version'`)
      .first<{ meta_value: string }>();
    return row?.meta_value === SCHEMA_VERSION;
  } catch {
    return false;
  }
};

export const ensureTables = async (db: D1Database) => {
  if (tablesEnsured) return;
  if (!tablesEnsurePromise) {
    tablesEnsurePromise = (async () => {
      // 대부분의 요청에서는 버전 1회 조회만 수행해 로그인·목록 조회 지연을 줄입니다.
      if (!(await hasCurrentSchema(db))) await runSchemaMigration(db);
      tablesEnsured = true;
    })().catch((error) => {
      tablesEnsurePromise = null;
      console.error('D1 schema migration failed', error);
      throw error;
    });
  }
  await tablesEnsurePromise;
};

const getAuthRateKey = async (request: Request, scope: string) => sha256(`gov-auth-failure:${scope}:ip:${getClientIp(request)}`);
const cleanupExpiredRateLimits = async (db: D1Database, now: number) => {
  if (now - lastRateLimitCleanupAt <= MAINTENANCE_COOLDOWN_MS) return;
  await db.prepare(`DELETE FROM admin_rate_limits WHERE created_at < ?`)
    .bind(new Date(now - 24 * 60 * 60 * 1000).toISOString()).run();
  lastRateLimitCleanupAt = now;
};

export const checkAuthRateLimit = async (db: D1Database, request: Request, scope = 'login') => {
  await ensureTables(db);
  const now = Date.now();
  await cleanupExpiredRateLimits(db, now);
  const rateKey = await getAuthRateKey(request, scope);
  const checks = [
    { windowMs: 10 * 60 * 1000, max: 10, message: '인증 시도가 반복되었습니다. 잠시 후 다시 시도해 주세요.' },
    { windowMs: 24 * 60 * 60 * 1000, max: 40, message: '인증 시도 한도를 초과했습니다. 나중에 다시 시도해 주세요.' },
  ];
  const rows = await db.batch(checks.map((check) => db.prepare(
    `SELECT COUNT(*) AS count FROM admin_rate_limits WHERE rate_key = ? AND created_at >= ?`,
  ).bind(rateKey, new Date(now - check.windowMs).toISOString())));
  for (let i = 0; i < checks.length; i += 1) {
    const row = (rows[i]?.results?.[0] || null) as Record<string, unknown> | null;
    if (Number(row?.count || 0) >= checks[i].max) return { ok: false as const, message: checks[i].message };
  }
  return { ok: true as const, rateKey };
};
export const checkAdminAuthRateLimit = (db: D1Database, request: Request) => checkAuthRateLimit(db, request, 'admin');
export const recordAuthFailure = async (db: D1Database, rateKey: string) => {
  await db.prepare(`INSERT INTO admin_rate_limits (id, rate_key, created_at) VALUES (?, ?, ?)`)
    .bind(`RL-${randomHex(24)}`, rateKey, new Date().toISOString()).run();
};
export const clearAuthFailures = async (db: D1Database, rateKey: string) => {
  await db.prepare(`DELETE FROM admin_rate_limits WHERE rate_key = ?`).bind(rateKey).run();
};
export const recordAdminAuthFailure = recordAuthFailure;
export const clearAdminAuthFailures = clearAuthFailures;
export const verifyAdminToken = async (submittedToken: string, expectedToken: string) => {
  if (!submittedToken || !expectedToken) return false;
  const [submittedDigest, expectedDigest] = await Promise.all([sha256(submittedToken), sha256(expectedToken)]);
  return timingSafeEqual(submittedDigest, expectedDigest);
};

export type SessionUser = {
  id: string; name: string; username: string; position: string | null; grade: string | null;
  department: string | null; role: string; can_approve: number;
};
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const createSession = async (db: D1Database, userId: string) => {
  const token = randomHex(48); const now = new Date();
  await db.prepare(`INSERT INTO system_sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`)
    .bind(token, userId, now.toISOString(), new Date(now.getTime() + SESSION_TTL_MS).toISOString()).run();
  return token;
};
export const destroySession = async (db: D1Database, token: string) => {
  if (token) await db.prepare(`DELETE FROM system_sessions WHERE token = ?`).bind(token).run();
};
export const authenticateSession = async (
  db: D1Database, token: string,
): Promise<{ ok: true; user: SessionUser } | { ok: false; message: string; status: number }> => {
  if (!token) return { ok: false, message: '로그인이 필요합니다.', status: 401 };
  const row = await db.prepare(`
    SELECT u.id, u.name, u.username, u.position, u.grade, u.department, u.role, u.can_approve, u.active, s.expires_at
    FROM system_sessions s JOIN system_users u ON u.id = s.user_id WHERE s.token = ?
  `).bind(token).first<SessionUser & { active: number; expires_at: string }>();
  if (!row) return { ok: false, message: '로그인이 만료되었습니다. 다시 로그인해 주세요.', status: 401 };
  if (!row.active) return { ok: false, message: '비활성화된 계정입니다. 관리자에게 문의해 주세요.', status: 403 };
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await destroySession(db, token);
    return { ok: false, message: '로그인이 만료되었습니다. 다시 로그인해 주세요.', status: 401 };
  }
  const { id, name, username, position, grade, department, role, can_approve } = row;
  return { ok: true, user: { id, name, username, position, grade, department, role, can_approve } };
};

export const canReadDocument = (user: SessionUser, document: Record<string, unknown>) => {
  if (user.role === 'admin') return true;
  // 임시저장 문서는 열람범위와 관계없이 작성자만 볼 수 있어야 합니다.
  if (document.status === '임시저장') return document.drafter_user_id === user.id;
  if (document.access_scope !== '관련자') return true;
  return [document.drafter_user_id, document.reviewer_user_id, document.approver_user_id].includes(user.id);
};

const nextSequence = async (db: D1Database, seqKey: string, initialValue = 0) => {
  await db.prepare(`INSERT OR IGNORE INTO document_sequences (seq_key, last_seq) VALUES (?, ?)`)
    .bind(seqKey, initialValue).run();
  const row = await db.prepare(`UPDATE document_sequences SET last_seq = last_seq + 1 WHERE seq_key = ? RETURNING last_seq`)
    .bind(seqKey).first<{ last_seq: number }>();
  return Number(row?.last_seq || initialValue + 1);
};

export const makeDocumentNumber = async (db: D1Database, now: Date) => {
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const year = kst.getUTCFullYear();
  const prefix = `밀교종-${year}-`;
  const existing = await db.prepare(`SELECT MAX(CAST(substr(id, ?) AS INTEGER)) AS max_seq FROM documents WHERE id LIKE ?`)
    .bind(prefix.length + 1, `${prefix}%`).first<{ max_seq: number | null }>();
  const seq = await nextSequence(db, `DOC:${year}`, Number(existing?.max_seq || 0));
  return `${prefix}${String(seq).padStart(3, '0')}`;
};
export const makeReceivedNumber = async (db: D1Database, now: Date, direction: string) => {
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const year = kst.getUTCFullYear();
  const prefix = direction === '접수' ? `접수-${year}-` : `외부발송-${year}-`;
  const existing = await db.prepare(`SELECT MAX(CAST(substr(id, ?) AS INTEGER)) AS max_seq FROM received_documents WHERE id LIKE ?`)
    .bind(prefix.length + 1, `${prefix}%`).first<{ max_seq: number | null }>();
  const seq = await nextSequence(db, `${direction}:${year}`, Number(existing?.max_seq || 0));
  return `${prefix}${String(seq).padStart(3, '0')}`;
};
