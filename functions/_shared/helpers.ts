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


const OFFICE_DEPARTMENTS = new Set(['재정국', '준법윤리국', '국제교류국', '문화홍보국', '사회공헌국']);
const legacyOfficeDepartment = (name: string, position = '') => {
  if (name === '재정·회계') return '재정국';
  if (name === '준법·윤리') return '준법윤리국';
  if (name === '대외협력·사회공헌') return /사회공헌/.test(position) ? '사회공헌국' : '국제교류국';
  if (name === '문화·홍보') return '문화홍보국';
  return name;
};

/**
 * 담당부서의 과거 명칭을 현행 직제 기준으로 정규화합니다.
 * 내부 저장값은 `상위부서 - 하위부서`, 화면 표시값은 각 화면에서 `상위부서(하위부서)`로 변환합니다.
 */
export const normalizeDepartmentValue = (value: unknown, position = '') => {
  let text = clean(value, 120);
  if (!text) return '';
  text = text.replace(/\s*[–—]\s*/g, ' - ');
  const parenthesized = /^(.+?)\s*\(([^()]+)\)\s*$/.exec(text);
  if (parenthesized) text = `${parenthesized[1].trim()} - ${parenthesized[2].trim()}`;

  let parts = text.split(/\s+-\s+/).map((part) => part.trim()).filter(Boolean);
  let primary = parts[0] || '';
  let secondary = parts.slice(1).join(' - ');
  if (primary === '사무국') primary = '사무처';

  if (secondary) secondary = legacyOfficeDepartment(secondary, position);
  if (!secondary) {
    const mapped = legacyOfficeDepartment(primary, position);
    if (mapped !== primary || OFFICE_DEPARTMENTS.has(mapped)) {
      primary = '사무처';
      secondary = mapped;
    }
  }
  if (primary === '사무처' && secondary && OFFICE_DEPARTMENTS.has(secondary)) return `${primary} - ${secondary}`;
  return secondary ? `${primary} - ${secondary}` : primary;
};

export const formatDepartmentDisplay = (value: unknown, position = '') => {
  const normalized = normalizeDepartmentValue(value, position);
  if (!normalized) return '-';
  const parts = normalized.split(/\s+-\s+/).map((part) => part.trim()).filter(Boolean);
  return parts.length > 1 ? `${parts[0]}(${parts.slice(1).join(' - ')})` : parts[0];
};

const DEPARTMENT_HEAD_TITLES: Record<string, string> = {
  '이사장': '이사장',
  '이사회': '이사장',
  '감사': '감사',
  '종정': '종정',
  '사무처': '사무총장',
  '재정국': '재정국장',
  '준법윤리국': '준법윤리국장',
  '국제교류국': '국제교류국장',
  '문화홍보국': '문화홍보국장',
  '사회공헌국': '사회공헌국장',
  '총무원': '총무원장',
  '교육·포교원': '교육·포교원장',
  '람림불교교육원': '람림불교교육원장',
  '신도회': '신도회장',
  '사찰운영위원회': '사찰운영위원장',
};

/** 담당부서 선택값을 문서 발신명의용 부서장 직책으로 변환합니다. */
export const resolveDepartmentHeadTitle = (value: unknown, position = '') => {
  const normalized = normalizeDepartmentValue(value, position);
  if (!normalized) return '';
  const parts = normalized.split(/\s+-\s+/).map((part) => part.trim()).filter(Boolean);
  const target = parts.length > 1 ? parts[parts.length - 1] : parts[0];
  if (!target) return '';
  if (DEPARTMENT_HEAD_TITLES[target]) return DEPARTMENT_HEAD_TITLES[target];
  return target.endsWith('교구') ? `${target}장` : '';
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
const PBKDF2_ITERATIONS = 30_000;
export const hashPassword = async (password: string) => {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  try {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS },
      key,
      256,
    );
    return `pbkdf2$${PBKDF2_ITERATIONS}$${bytesToBase64(salt)}$${bytesToBase64(new Uint8Array(bits))}`;
  } catch (error) {
    // 일부 오래된 Pages Functions 런타임에서 PBKDF2가 제한되는 경우에도 계정 생성을 막지 않습니다.
    // 로그인 검증기는 이 salt:sha256 형식을 계속 지원합니다.
    console.warn('PBKDF2 unavailable; using compatible salted SHA-256 password hash', error);
    const saltText = toHex(salt.buffer);
    return `${saltText}:${await sha256(`${saltText}:${password}`)}`;
  }
};

export const verifyPassword = async (password: string, stored: string) => {
  if (!stored) return false;
  if (stored.startsWith('pbkdf2$')) {
    const [, iterationText, saltText, expectedText] = stored.split('$');
    const iterations = Number(iterationText);
    if (!Number.isInteger(iterations) || iterations < 10_000 || iterations > 1_000_000 || !saltText || !expectedText) return false;
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

export const isValidIsoDate = (value: string) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
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
  type: 'text' | 'textarea' | 'number' | 'money' | 'date' | 'time' | 'select' | 'checkbox';
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
      { id: 'budgetAmount', label: '소요 예산(원)', type: 'money', required: false, defaultValue: '0', width: 'half' },
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
      { id: 'supplyAmount', label: '공급가액(원)', type: 'money', required: true, defaultValue: '0', width: 'half' },
      { id: 'vatAmount', label: '부가세(원)', type: 'money', required: true, defaultValue: '0', width: 'half' },
      { id: 'totalAmount', label: '합계(원)', type: 'money', required: false, defaultValue: '0', width: 'half' },
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
      { id: 'supplyAmount', label: '공급가액(원)', type: 'money', required: true, defaultValue: '0', width: 'half' },
      { id: 'vatAmount', label: '부가세(원)', type: 'money', required: true, defaultValue: '0', width: 'half' },
      { id: 'totalAmount', label: '합계(원)', type: 'money', required: false, defaultValue: '0', width: 'half' },
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

  {
    id: 'TPL-FIN-INCOME-RESOLUTION', name: '수입결의서', description: '재무회계규정 별지 제1호를 반영한 수입 확정 및 증빙 확인 서식',
    docType: '기안', category: '예산·결산·사업계획·사업실적 관련 문서', titlePrefix: '[수입결의] ',
    fields: [
      { id: 'subject', label: '수입 건명', type: 'text', required: true, width: 'full' },
      { id: 'resolutionDate', label: '결의일자', type: 'date', required: true, width: 'half' },
      { id: 'incomeDate', label: '수입일자', type: 'date', required: true, width: 'half' },
      { id: 'incomeType', label: '수입구분', type: 'select', required: true, options: ['회비', '참가비', '교육비', '의례비', '공양비', '실비', '후원금', '보시금', '목적지정 기부금', '불사금', '사업수입', '수익사업수입', '보조금·지원금', '기타'], width: 'half' },
      { id: 'payer', label: '납부자', type: 'text', required: true, width: 'half' },
      { id: 'amount', label: '수입금액(원)', type: 'money', required: true, defaultValue: '0', width: 'half' },
      { id: 'incomeMethod', label: '수입방법', type: 'select', required: true, options: ['계좌입금', '현금', '카드', '기타'], width: 'half' },
      { id: 'businessName', label: '관련 사업명', type: 'text', required: false, width: 'full' },
      { id: 'designated', label: '사용목적 지정 여부', type: 'select', required: true, options: ['없음', '있음'], width: 'half' },
      { id: 'designatedPurpose', label: '지정 목적', type: 'textarea', required: false, width: 'full' },
      { id: 'account', label: '입금계좌', type: 'text', required: true, placeholder: '은행명 / 계좌번호 / 예금주', width: 'full' },
      { id: 'evidence', label: '증빙자료', type: 'textarea', required: true, placeholder: '입금내역, 영수증, 후원신청서 등', width: 'full' },
    ],
    bodyTemplate: '1. 수입 건명: {{subject}}\n2. 결의일자 / 수입일자: {{resolutionDate}} / {{incomeDate}}\n3. 수입구분: {{incomeType}}\n4. 납부자: {{payer}}\n5. 수입금액: {{amount}}원\n6. 수입방법: {{incomeMethod}}\n7. 관련 사업명: {{businessName}}\n8. 사용목적 지정 여부: {{designated}}\n  - 지정 목적: {{designatedPurpose}}\n9. 입금계좌: {{account}}\n10. 증빙자료\n{{evidence}}',
  },
  {
    id: 'TPL-FIN-PAYMENT-REQUEST', name: '지급요청서', description: '재무회계규정 별지 제8호 및 보수·실비 지급규정을 반영한 지급 요청 서식',
    docType: '기안', category: '예산·결산·사업계획·사업실적 관련 문서', titlePrefix: '[지급요청] ',
    fields: [
      { id: 'subject', label: '지급 건명', type: 'text', required: true, width: 'full' },
      { id: 'requestDate', label: '작성일', type: 'date', required: true, width: 'half' },
      { id: 'requester', label: '요청자', type: 'text', required: true, width: 'half' },
      { id: 'requesterRole', label: '소속 또는 역할', type: 'text', required: true, width: 'half' },
      { id: 'payee', label: '지급대상자', type: 'text', required: true, width: 'half' },
      { id: 'amount', label: '지급금액(원)', type: 'money', required: true, defaultValue: '0', width: 'half' },
      { id: 'paymentType', label: '지급유형', type: 'select', required: true, options: ['보수', '급여', '실비', '활동비', '직무수행비', '업무추진비', '직책활동비', '강사료', '법문료', '의례집전비', '수행지도비', '상담지도비', '원고료', '자문료', '용역비', '공양운영비', '이동경비', '체류지원비', '행사운영비', '시설관리비', '기타'], width: 'half' },
      { id: 'reason', label: '지급사유', type: 'textarea', required: true, width: 'full' },
      { id: 'businessName', label: '관련 사업명', type: 'text', required: false, width: 'half' },
      { id: 'budgetItem', label: '예산과목', type: 'text', required: true, width: 'half' },
      { id: 'paymentMethod', label: '지급방법', type: 'select', required: true, options: ['계좌이체', '현금', '기타'], width: 'half' },
      { id: 'account', label: '계좌정보', type: 'text', required: false, placeholder: '은행명 / 계좌번호 / 예금주', width: 'full' },
      { id: 'evidence', label: '증빙자료', type: 'textarea', required: true, placeholder: '영수증, 계약서, 활동내역서, 결과보고서 등', width: 'full' },
      { id: 'relatedParty', label: '이해관계 여부', type: 'select', required: true, options: ['해당 없음', '해당 있음'], width: 'half' },
      { id: 'relatedPartyNote', label: '이해관계 검토내용', type: 'textarea', required: false, width: 'full' },
    ],
    bodyTemplate: '1. 지급 건명: {{subject}}\n2. 작성일: {{requestDate}}\n3. 요청자 / 소속·역할: {{requester}} / {{requesterRole}}\n4. 지급대상자: {{payee}}\n5. 지급유형 / 금액: {{paymentType}} / {{amount}}원\n6. 지급사유\n{{reason}}\n\n7. 관련 사업명 / 예산과목: {{businessName}} / {{budgetItem}}\n8. 지급방법: {{paymentMethod}}\n9. 계좌정보: {{account}}\n10. 증빙자료\n{{evidence}}\n11. 이해관계 여부: {{relatedParty}}\n{{relatedPartyNote}}',
  },
  {
    id: 'TPL-FIN-BUDGET-CHANGE', name: '예산변경 신청서', description: '재무회계규정 별지 제13호를 반영한 예산과목·금액 변경 승인 서식',
    docType: '기안', category: '예산·결산·사업계획·사업실적 관련 문서', titlePrefix: '[예산변경] ',
    fields: [
      { id: 'subject', label: '변경 건명', type: 'text', required: true, width: 'full' },
      { id: 'requestDate', label: '신청일', type: 'date', required: true, width: 'half' },
      { id: 'department', label: '신청부서 또는 기구', type: 'text', required: true, width: 'half' },
      { id: 'requester', label: '신청자', type: 'text', required: true, width: 'half' },
      { id: 'businessName', label: '관련 사업명', type: 'text', required: true, width: 'half' },
      { id: 'reason', label: '변경 사유', type: 'textarea', required: true, width: 'full' },
      { id: 'beforeBudget', label: '변경 전 예산', type: 'textarea', required: true, placeholder: '예산과목 / 예산액', width: 'full' },
      { id: 'afterBudget', label: '변경 후 예산', type: 'textarea', required: true, placeholder: '예산과목 / 예산액', width: 'full' },
      { id: 'changeAmount', label: '증감액(원)', type: 'money', required: true, defaultValue: '0', width: 'half' },
      { id: 'businessPlanChange', label: '사업계획 변경 여부', type: 'select', required: true, options: ['없음', '있음'], width: 'half' },
      { id: 'resolutionNeed', label: '의결 필요 여부', type: 'select', required: true, options: ['없음', '이사회 필요', '총회 필요'], width: 'half' },
      { id: 'attachments', label: '첨부자료', type: 'textarea', required: false, width: 'full' },
    ],
    bodyTemplate: '1. 변경 건명: {{subject}}\n2. 신청일: {{requestDate}}\n3. 신청부서 또는 기구: {{department}}\n4. 신청자: {{requester}}\n5. 관련 사업명: {{businessName}}\n6. 변경 사유\n{{reason}}\n\n7. 변경 전 예산\n{{beforeBudget}}\n\n8. 변경 후 예산\n{{afterBudget}}\n\n9. 증감액: {{changeAmount}}원\n10. 사업계획 변경 여부: {{businessPlanChange}}\n11. 총회·이사회 의결 필요 여부: {{resolutionNeed}}\n12. 첨부자료\n{{attachments}}',
  },
  {
    id: 'TPL-FIN-SETTLEMENT-SUBMIT', name: '결산자료 제출서', description: '재무회계규정 별지 제14호를 반영한 기구·사업별 결산자료 제출 서식',
    docType: '기안', category: '예산·결산·사업계획·사업실적 관련 문서', titlePrefix: '[결산자료] ',
    fields: [
      { id: 'subject', label: '결산 건명', type: 'text', required: true, width: 'full' },
      { id: 'submissionDate', label: '제출일', type: 'date', required: true, width: 'half' },
      { id: 'organization', label: '제출기구', type: 'select', required: true, options: ['사무처', '총무원', '교육·포교원', '재정국', '준법윤리국', '국제교류국', '문화홍보국', '사회공헌국', '활동거점', '기타'], width: 'half' },
      { id: 'submitter', label: '제출자', type: 'text', required: true, width: 'half' },
      { id: 'fiscalYear', label: '사업연도', type: 'number', required: true, defaultValue: '{{CURRENT_YEAR}}', width: 'half' },
      { id: 'businessName', label: '주요 사업명', type: 'text', required: true, width: 'full' },
      { id: 'incomeDetails', label: '수입내역', type: 'textarea', required: true, width: 'full' },
      { id: 'expenseDetails', label: '지출내역', type: 'textarea', required: true, width: 'full' },
      { id: 'balance', label: '잔액 또는 미정산금', type: 'textarea', required: true, width: 'full' },
      { id: 'evidence', label: '증빙자료 목록', type: 'textarea', required: true, placeholder: '수입자료, 지출자료, 계약서, 영수증, 활동보고서 등', width: 'full' },
      { id: 'notes', label: '특이사항', type: 'textarea', required: false, width: 'full' },
    ],
    bodyTemplate: '1. 결산 건명: {{subject}}\n2. 제출일: {{submissionDate}}\n3. 제출기구 / 제출자: {{organization}} / {{submitter}}\n4. 사업연도: {{fiscalYear}}년도\n5. 주요 사업명: {{businessName}}\n6. 수입내역\n{{incomeDetails}}\n\n7. 지출내역\n{{expenseDetails}}\n\n8. 잔액 또는 미정산금\n{{balance}}\n\n9. 증빙자료 목록\n{{evidence}}\n\n10. 특이사항\n{{notes}}',
  },
  {
    id: 'TPL-FIN-RELATED-PARTY', name: '이해관계인 거래 검토서', description: '재무회계규정 별지 제15호를 반영한 특수관계 거래·지급 적정성 검토 서식',
    docType: '기안', category: '계약서·협약서·양해각서 및 재산 관련 문서', titlePrefix: '[이해관계인 거래검토] ',
    fields: [
      { id: 'subject', label: '거래·지급 건명', type: 'text', required: true, width: 'full' },
      { id: 'reviewDate', label: '검토일', type: 'date', required: true, width: 'half' },
      { id: 'counterparty', label: '거래 또는 지급 대상자', type: 'text', required: true, width: 'half' },
      { id: 'relationship', label: '법인과의 관계', type: 'select', required: true, options: ['이사장', '임원', '종정', '회원', '출연자', '소유자', '친족·특수관계인', '관련 단체', '기타'], width: 'half' },
      { id: 'transactionType', label: '거래 유형', type: 'select', required: true, options: ['보수 지급', '실비 지급', '활동비 지급', '용역계약', '자문계약', '재산거래', '사용계약', '기타'], width: 'half' },
      { id: 'reason', label: '거래 또는 지급 사유', type: 'textarea', required: true, width: 'full' },
      { id: 'purposeBusiness', label: '관련 목적사업', type: 'text', required: true, width: 'full' },
      { id: 'amount', label: '지급 또는 계약 금액(원)', type: 'money', required: true, defaultValue: '0', width: 'half' },
      { id: 'calculationBasis', label: '산출근거', type: 'textarea', required: true, width: 'full' },
      { id: 'comparison', label: '비교자료 또는 적정성 검토', type: 'textarea', required: true, width: 'full' },
      { id: 'recusal', label: '이해관계인 의결 참여 제한', type: 'select', required: true, options: ['해당 없음', '해당 있음'], width: 'half' },
      { id: 'evidence', label: '증빙자료', type: 'textarea', required: true, width: 'full' },
      { id: 'opinion', label: '검토의견', type: 'select', required: true, options: ['적정', '조건부 적정', '부적정'], width: 'half' },
      { id: 'auditNeed', label: '감사 확인 필요 여부', type: 'select', required: true, options: ['필요', '불필요'], width: 'half' },
    ],
    bodyTemplate: '1. 거래·지급 건명: {{subject}}\n2. 검토일: {{reviewDate}}\n3. 거래 또는 지급 대상자: {{counterparty}}\n4. 법인과의 관계 / 거래 유형: {{relationship}} / {{transactionType}}\n5. 거래 또는 지급 사유\n{{reason}}\n\n6. 관련 목적사업: {{purposeBusiness}}\n7. 지급 또는 계약 금액: {{amount}}원\n8. 산출근거\n{{calculationBasis}}\n\n9. 비교자료 또는 적정성 검토\n{{comparison}}\n\n10. 이해관계인 의결 참여 제한: {{recusal}}\n11. 증빙자료\n{{evidence}}\n12. 검토의견: {{opinion}}\n13. 감사 확인 필요 여부: {{auditNeed}}',
  },
  {
    id: 'TPL-FIN-REVENUE-BUSINESS', name: '수익사업 시행·변경 검토서', description: '정관 제5조·제6조와 재무회계규정 제10조의2~제10조의4에 따른 수익사업 사전검토 서식',
    docType: '기안', category: '예산·결산·사업계획·사업실적 관련 문서', titlePrefix: '[수익사업 검토] ',
    fields: [
      { id: 'subject', label: '사업명', type: 'text', required: true, width: 'full' },
      { id: 'actionType', label: '검토구분', type: 'select', required: true, options: ['신설', '변경', '중단'], width: 'half' },
      { id: 'businessType', label: '수익사업 유형', type: 'select', required: true, options: ['교육·강좌·수련', '출판·디지털콘텐츠', '종교·문화상품', '체험·명상·마음돌봄', '시설사용·대관', '전시·공연·문화행사', '온라인·전자상거래', '공공조달', '우선구매 인증·지정', '기타'], width: 'half' },
      { id: 'basis', label: '정관·규정 근거', type: 'text', required: true, defaultValue: '정관 제5조·제6조 / 재무회계규정 제10조의2~제10조의4', width: 'full' },
      { id: 'period', label: '운영기간', type: 'text', required: false, placeholder: '시작일 ~ 종료일', width: 'half' },
      { id: 'departmentManager', label: '담당부서·담당자', type: 'text', required: true, width: 'half' },
      { id: 'expectedIncome', label: '예상수입(원)', type: 'money', required: true, defaultValue: '0', width: 'half' },
      { id: 'expectedExpense', label: '예상지출(원)', type: 'money', required: true, defaultValue: '0', width: 'half' },
      { id: 'permitTax', label: '등록·허가·세무 검토', type: 'textarea', required: true, width: 'full' },
      { id: 'facilityContract', label: '시설사용·계약관계', type: 'textarea', required: false, width: 'full' },
      { id: 'risk', label: '위험요인·중단기준', type: 'textarea', required: true, width: 'full' },
      { id: 'approval', label: '승인단계', type: 'select', required: true, options: ['이사장 승인', '이사회 의결', '총회 승인'], width: 'half' },
      { id: 'decisionNo', label: '의결·승인번호', type: 'text', required: false, width: 'half' },
    ],
    bodyTemplate: '1. 사업명: {{subject}}\n2. 검토구분 / 수익사업 유형: {{actionType}} / {{businessType}}\n3. 정관·규정 근거: {{basis}}\n4. 운영기간: {{period}}\n5. 담당부서·담당자: {{departmentManager}}\n6. 예상 수입·지출\n  - 예상수입: {{expectedIncome}}원\n  - 예상지출: {{expectedExpense}}원\n7. 등록·허가·세무 검토\n{{permitTax}}\n\n8. 시설사용·계약관계\n{{facilityContract}}\n\n9. 위험요인·중단기준\n{{risk}}\n\n10. 승인단계 / 의결·승인번호: {{approval}} / {{decisionNo}}',
  },
  {
    id: 'TPL-FIN-PROCUREMENT-REVIEW', name: '입찰참가 검토서', description: '재무회계규정 별지 제21호와 정관 제5조의2·제6조를 반영한 공공조달 사전검토 서식',
    docType: '기안', category: '계약서·협약서·양해각서 및 재산 관련 문서', titlePrefix: '[입찰참가 검토] ',
    fields: [
      { id: 'subject', label: '공고명', type: 'text', required: true, width: 'full' },
      { id: 'agency', label: '발주기관', type: 'text', required: true, width: 'half' },
      { id: 'announcementNo', label: '공고번호', type: 'text', required: false, width: 'half' },
      { id: 'bidInfo', label: '입찰방식·입찰일·개찰일', type: 'textarea', required: true, width: 'full' },
      { id: 'estimatedPrice', label: '추정가격(원)', type: 'money', required: true, defaultValue: '0', width: 'half' },
      { id: 'plannedBidAmount', label: '투찰예정금액(원)', type: 'money', required: true, defaultValue: '0', width: 'half' },
      { id: 'termPlace', label: '계약기간·납품기한·납품장소', type: 'textarea', required: true, width: 'full' },
      { id: 'responsible', label: '책임자(담당자)', type: 'text', required: false, width: 'half' },
      { id: 'qualification', label: '참가자격 확인', type: 'textarea', required: true, placeholder: '사업자등록 / 입찰참가자격 / 면허·인증 / 제한처분 / 정관범위', width: 'full' },
      { id: 'costs', label: '원가 산정내역', type: 'textarea', required: true, width: 'full' },
      { id: 'expectedProfit', label: '예상이익·이익률', type: 'text', required: true, width: 'half' },
      { id: 'guarantees', label: '입찰·이행·선금·하자보증', type: 'textarea', required: false, width: 'full' },
      { id: 'taxReview', label: '부가가치세·법인세·준비금 검토', type: 'textarea', required: true, width: 'full' },
      { id: 'risk', label: '이행실패·이해관계·재정위험 검토', type: 'textarea', required: true, width: 'full' },
      { id: 'annualLimit', label: '직전연도 총수입·50% 총량한도·당해연도 누계', type: 'textarea', required: true, width: 'full' },
      { id: 'approval', label: '결재구분', type: 'select', required: true, options: ['이사장 전결', '이사회 의결', '총회 의결·주무관청 허가'], width: 'half' },
      { id: 'decisionNo', label: '의결·허가번호', type: 'text', required: false, width: 'half' },
      { id: 'opinion', label: '검토의견', type: 'textarea', required: true, width: 'full' },
    ],
    bodyTemplate: '1. 공고 개요\n  - 발주기관: {{agency}}\n  - 공고번호: {{announcementNo}}\n  - 공고명: {{subject}}\n  - 입찰정보: {{bidInfo}}\n  - 추정가격: {{estimatedPrice}}원\n  - 투찰예정금액: {{plannedBidAmount}}원\n  - 계약·납품: {{termPlace}}\n  - 책임자(담당자): {{responsible}}\n2. 참가자격 확인\n{{qualification}}\n\n3. 원가 산정\n{{costs}}\n\n4. 예상이익·이익률: {{expectedProfit}}\n5. 보증 검토\n{{guarantees}}\n\n6. 세무검토\n{{taxReview}}\n\n7. 위험 검토\n{{risk}}\n\n8. 회계연도별 총량 검토\n{{annualLimit}}\n\n9. 결재구분 / 의결·허가번호: {{approval}} / {{decisionNo}}\n10. 검토의견\n{{opinion}}',
  },
  {
    id: 'TPL-FIN-MONTHLY-CHECK', name: '월별·분기별 회계점검 보고서', description: '재무회계규정 제52조의2에 따른 수입·지출, 계좌, 미정산, 증빙, 예산 및 조달 점검 서식',
    docType: '기안', category: '예산·결산·사업계획·사업실적 관련 문서', titlePrefix: '[회계점검] ',
    fields: [
      { id: 'subject', label: '점검명', type: 'text', required: true, width: 'full' },
      { id: 'period', label: '점검기간', type: 'text', required: true, width: 'half' },
      { id: 'accountBalance', label: '계좌잔액 점검', type: 'textarea', required: true, width: 'full' },
      { id: 'unsettled', label: '미대사·미정산 내역', type: 'textarea', required: true, width: 'full' },
      { id: 'donation', label: '후원금·보시금 수입 점검', type: 'textarea', required: false, width: 'full' },
      { id: 'expenseEvidence', label: '주요 지출·증빙 점검', type: 'textarea', required: true, width: 'full' },
      { id: 'budget', label: '예산초과·변경 점검', type: 'textarea', required: true, width: 'full' },
      { id: 'procurement', label: '공공조달·계약 위험 점검', type: 'textarea', required: false, width: 'full' },
      { id: 'findings', label: '이상사항', type: 'textarea', required: false, width: 'full' },
      { id: 'correctiveAction', label: '보완·시정조치', type: 'textarea', required: false, width: 'full' },
      { id: 'reportStatus', label: '이사장·감사 보고 여부', type: 'text', required: true, width: 'half' },
    ],
    bodyTemplate: '1. 점검명: {{subject}}\n2. 점검기간: {{period}}\n3. 계좌잔액 점검\n{{accountBalance}}\n\n4. 미대사·미정산 내역\n{{unsettled}}\n\n5. 후원금·보시금 수입 점검\n{{donation}}\n\n6. 주요 지출·증빙 점검\n{{expenseEvidence}}\n\n7. 예산초과·변경 점검\n{{budget}}\n\n8. 공공조달·계약 위험 점검\n{{procurement}}\n\n9. 이상사항\n{{findings}}\n\n10. 보완·시정조치\n{{correctiveAction}}\n\n11. 이사장·감사 보고 여부: {{reportStatus}}',
  },
  {
    id: 'TPL-FIN-IMMEDIATE-REPORT', name: '중요 회계사항 즉시보고서', description: '재무회계규정 제52조의3의 중요 회계이상 징후를 이사장·감사에게 즉시 보고하는 서식',
    docType: '기안', category: '예산·결산·사업계획·사업실적 관련 문서', titlePrefix: '[회계 즉시보고] ',
    fields: [
      { id: 'subject', label: '보고 제목', type: 'text', required: true, width: 'full' },
      { id: 'occurredAt', label: '발견일시', type: 'text', required: true, width: 'half' },
      { id: 'category', label: '이상사항 유형', type: 'select', required: true, options: ['법인계좌 이상거래', '미정산·증빙누락·목적외사용 우려', '예산 현저 초과', '이해관계인 거래 위험', '후원금·보시금·목적기부금 지정목적 위반 우려', '법인재산·개인재산 혼용 우려', '공공조달 이행지체·계약해지·입찰제한 우려', '기타 중대한 재정사항'], width: 'half' },
      { id: 'detail', label: '상세내용', type: 'textarea', required: true, width: 'full' },
      { id: 'amountScope', label: '관련 금액·범위', type: 'text', required: false, width: 'half' },
      { id: 'immediateAction', label: '즉시조치', type: 'textarea', required: true, width: 'full' },
      { id: 'reportStatus', label: '이사장·감사 보고상태', type: 'text', required: true, width: 'half' },
      { id: 'followUp', label: '추가조치·이사회 보고·감사 필요사항', type: 'textarea', required: false, width: 'full' },
    ],
    bodyTemplate: '1. 보고 제목: {{subject}}\n2. 발견일시: {{occurredAt}}\n3. 이상사항 유형: {{category}}\n4. 상세내용\n{{detail}}\n\n5. 관련 금액·범위: {{amountScope}}\n6. 즉시조치\n{{immediateAction}}\n\n7. 이사장·감사 보고상태: {{reportStatus}}\n8. 추가조치·이사회 보고·감사 필요사항\n{{followUp}}',
  },
  {
    id: 'TPL-FIN-VEHICLE-REVIEW', name: '업무용 차량 임차·구입 검토서', description: '재무회계규정 제35조의2에 따른 업무용 차량 임차·리스·구입 및 관리 검토 서식',
    docType: '기안', category: '계약서·협약서·양해각서 및 재산 관련 문서', titlePrefix: '[업무용 차량 검토] ',
    fields: [
      { id: 'subject', label: '차량·계약명', type: 'text', required: true, width: 'full' },
      { id: 'managementType', label: '관리유형', type: 'select', required: true, options: ['단기렌트', '장기렌트', '리스', '구입'], width: 'half' },
      { id: 'purpose', label: '업무용도', type: 'textarea', required: true, width: 'full' },
      { id: 'user', label: '사용예정자', type: 'text', required: false, width: 'half' },
      { id: 'period', label: '계약·사용기간', type: 'text', required: true, width: 'half' },
      { id: 'cost', label: '임차료·취득가액 및 부대비용', type: 'textarea', required: true, defaultValue: '임차료·취득가액 및 부대비용 산정내역 확인 필요', width: 'full' },
      { id: 'insurance', label: '보험가입·보장범위', type: 'textarea', required: true, defaultValue: '보험가입 여부, 보장범위 및 만료일 확인 필요', width: 'full' },
      { id: 'management', label: '운행일지·주유·정비·보관 계획', type: 'textarea', required: true, defaultValue: '운행일지, 보험증권, 주유·정비 영수증 및 계약 관련 증빙을 관리대장과 연계하여 보관', width: 'full' },
      { id: 'approval', label: '승인단계', type: 'select', required: true, options: ['사무총장 전결', '이사장 승인', '이사회 의결'], width: 'half' },
      { id: 'decisionNo', label: '의결·승인번호', type: 'text', required: false, width: 'half' },
    ],
    bodyTemplate: '1. 차량·계약명: {{subject}}\n2. 관리유형: {{managementType}}\n3. 업무용도\n{{purpose}}\n\n4. 사용예정자 / 계약·사용기간: {{user}} / {{period}}\n5. 임차료·취득가액 및 부대비용\n{{cost}}\n\n6. 보험가입·보장범위\n{{insurance}}\n\n7. 운행일지·주유·정비·보관 계획\n{{management}}\n\n8. 승인단계 / 의결·승인번호: {{approval}} / {{decisionNo}}',
  },
  {
    id: 'TPL-FIN-VEHICLE-SUCCESSION', name: '업무용 차량 임차권 승계 검토서', description: '재무회계규정 제35조의3에 따른 임차·리스 계약 승계 및 이해관계 검토 서식',
    docType: '기안', category: '계약서·협약서·양해각서 및 재산 관련 문서', titlePrefix: '[차량 임차권 승계] ',
    fields: [
      { id: 'subject', label: '차량·계약명', type: 'text', required: true, width: 'full' },
      { id: 'candidate', label: '승계희망자', type: 'text', required: true, width: 'half' },
      { id: 'contractConsent', label: '계약상대방 승계동의·요건', type: 'textarea', required: true, defaultValue: '계약상대방의 승계 가능 여부와 동의 절차 확인 필요', width: 'full' },
      { id: 'remainingValue', label: '잔여리스료·보증금·정산금', type: 'textarea', required: true, defaultValue: '잔여 리스료·보증금·정산금 확인 필요', width: 'full' },
      { id: 'priceBasis', label: '승계대가·시가 산정근거', type: 'textarea', required: true, defaultValue: '객관적 시세와 계약상 잔존가치를 기준으로 산정 필요', width: 'full' },
      { id: 'lossCheck', label: '법인 추가채무·위약금·손해 검토', type: 'textarea', required: true, defaultValue: '법인에 신규 채무·위약금 또는 손해가 발생하지 않는지 확인 필요', width: 'full' },
      { id: 'operationImpact', label: '업무용 차량 운영·대체차량 영향', type: 'textarea', required: true, defaultValue: '승계 후 업무용 차량 운영과 대체차량 필요 여부 검토', width: 'full' },
      { id: 'recusal', label: '이해관계인 의결회피 여부', type: 'text', required: true, defaultValue: '해당 이해관계인이 이사인 경우 의결 참여 제외', width: 'half' },
      { id: 'decisionNo', label: '이사회 의결번호', type: 'text', required: true, width: 'half' },
      { id: 'opinion', label: '검토의견', type: 'textarea', required: true, defaultValue: '승계 요건, 승계대가의 상당성, 법인 업무 영향 및 의결 절차를 종합 검토', width: 'full' },
    ],
    bodyTemplate: '1. 차량·계약명: {{subject}}\n2. 승계희망자: {{candidate}}\n3. 계약상대방 승계동의·요건\n{{contractConsent}}\n\n4. 잔여리스료·보증금·정산금\n{{remainingValue}}\n\n5. 승계대가·시가 산정근거\n{{priceBasis}}\n\n6. 법인 추가채무·위약금·손해 검토\n{{lossCheck}}\n\n7. 업무용 차량 운영·대체차량 영향\n{{operationImpact}}\n\n8. 이해관계인 의결회피 여부: {{recusal}}\n9. 이사회 의결번호: {{decisionNo}}\n10. 검토의견\n{{opinion}}',
  },
  {
    id: 'TPL-DONATION-USE-PLAN', name: '목적지정 기부금 사용계획서', description: '후원금·보시금 관리규정 별지 제10호를 반영한 지정기부금 집행 계획 서식',
    docType: '기안', category: '후원금·보시금·목적지정 기부금 관련 중요 문서', titlePrefix: '[기부금 사용계획] ',
    fields: [
      { id: 'subject', label: '사업명', type: 'text', required: true, width: 'full' },
      { id: 'draftDate', label: '작성일자', type: 'date', required: true, width: 'half' },
      { id: 'donationSource', label: '기부금 출처', type: 'text', required: true, placeholder: '기부자 또는 모금명', width: 'half' },
      { id: 'donationAmount', label: '기부금액(원)', type: 'money', required: true, defaultValue: '0', width: 'half' },
      { id: 'designatedPurpose', label: '지정목적', type: 'textarea', required: true, width: 'full' },
      { id: 'usePurpose', label: '사용목적', type: 'textarea', required: true, width: 'full' },
      { id: 'startDate', label: '사용 시작일', type: 'date', required: true, width: 'half' },
      { id: 'endDate', label: '사용 종료일', type: 'date', required: true, width: 'half' },
      { id: 'plannedAmount', label: '사용예정금액(원)', type: 'money', required: true, defaultValue: '0', width: 'half' },
      { id: 'details', label: '세부 사용계획', type: 'textarea', required: true, width: 'full' },
      { id: 'evidence', label: '증빙 예정자료', type: 'textarea', required: true, placeholder: '견적서, 계약서, 영수증, 세금계산서 등', width: 'full' },
      { id: 'reviewItems', label: '검토사항', type: 'textarea', required: true, placeholder: '지정목적 부합, 예산 범위, 이해관계, 의결 필요 여부 등', width: 'full' },
    ],
    bodyTemplate: '1. 사업명: {{subject}}\n2. 작성일자: {{draftDate}}\n3. 기부금 출처: {{donationSource}}\n4. 기부금액: {{donationAmount}}원\n5. 지정목적\n{{designatedPurpose}}\n\n6. 사용목적\n{{usePurpose}}\n\n7. 사용기간: {{startDate}} ~ {{endDate}}\n8. 사용예정금액: {{plannedAmount}}원\n9. 세부 사용계획\n{{details}}\n\n10. 증빙 예정자료\n{{evidence}}\n\n11. 검토사항\n{{reviewItems}}',
  },
  {
    id: 'TPL-DONATION-SETTLEMENT', name: '목적지정 기부금 정산보고서', description: '후원금·보시금 관리규정 별지 제11호를 반영한 지정기부금 집행 결과·잔액 보고 서식',
    docType: '기안', category: '후원금·보시금·목적지정 기부금 관련 중요 문서', titlePrefix: '[기부금 정산] ',
    fields: [
      { id: 'subject', label: '사업명', type: 'text', required: true, width: 'full' },
      { id: 'draftDate', label: '작성일자', type: 'date', required: true, width: 'half' },
      { id: 'designatedPurpose', label: '지정목적', type: 'textarea', required: true, width: 'full' },
      { id: 'totalDonation', label: '기부금 총액(원)', type: 'money', required: true, defaultValue: '0', width: 'half' },
      { id: 'usedAmount', label: '사용금액(원)', type: 'money', required: true, defaultValue: '0', width: 'half' },
      { id: 'balance', label: '잔액(원)', type: 'money', required: true, defaultValue: '0', width: 'half' },
      { id: 'startDate', label: '사용 시작일', type: 'date', required: true, width: 'half' },
      { id: 'endDate', label: '사용 종료일', type: 'date', required: true, width: 'half' },
      { id: 'executionDetails', label: '주요 집행내역', type: 'textarea', required: true, width: 'full' },
      { id: 'evidence', label: '첨부증빙', type: 'textarea', required: true, width: 'full' },
      { id: 'balancePlan', label: '잔액 처리', type: 'select', required: true, options: ['동일 목적 이월', '유사 목적 사용', '이사회 의결', '기부자 협의', '기타'], width: 'half' },
      { id: 'donorReport', label: '기부자 보고', type: 'select', required: true, options: ['완료', '예정', '생략', '요청 시 제공'], width: 'half' },
      { id: 'notes', label: '비고', type: 'textarea', required: false, width: 'full' },
    ],
    bodyTemplate: '1. 사업명: {{subject}}\n2. 작성일자: {{draftDate}}\n3. 지정목적\n{{designatedPurpose}}\n\n4. 기부금 총액: {{totalDonation}}원\n5. 사용금액: {{usedAmount}}원\n6. 잔액: {{balance}}원\n7. 사용기간: {{startDate}} ~ {{endDate}}\n8. 주요 집행내역\n{{executionDetails}}\n\n9. 첨부증빙\n{{evidence}}\n10. 잔액 처리: {{balancePlan}}\n11. 기부자 보고: {{donorReport}}\n12. 비고\n{{notes}}',
  },
  {
    id: 'TPL-DONATION-PUBLIC-FUNDRAISING', name: '공개모금 검토서', description: '후원금·보시금 관리규정 별지 제12호를 반영한 공개모금 시행 전 검토 서식',
    docType: '기안', category: '후원금·보시금·목적지정 기부금 관련 중요 문서', titlePrefix: '[공개모금 검토] ',
    fields: [
      { id: 'subject', label: '모금명', type: 'text', required: true, width: 'full' },
      { id: 'purpose', label: '모금목적', type: 'textarea', required: true, width: 'full' },
      { id: 'startDate', label: '모금 시작일', type: 'date', required: true, width: 'half' },
      { id: 'endDate', label: '모금 종료일', type: 'date', required: true, width: 'half' },
      { id: 'target', label: '모금대상', type: 'select', required: true, options: ['회원·신도', '불특정 다수', '온라인', '행사장', '기타'], width: 'half' },
      { id: 'expectedAmount', label: '예상금액(원)', type: 'money', required: true, defaultValue: '0', width: 'half' },
      { id: 'publicityMaterial', label: '안내문·홍보물', type: 'select', required: true, options: ['첨부', '미첨부'], width: 'half' },
      { id: 'legalReview', label: '관계 법령 검토', type: 'select', required: true, options: ['신고·등록 불필요', '신고·등록 필요', '추가검토 필요'], width: 'half' },
      { id: 'reviewOpinion', label: '검토의견', type: 'textarea', required: true, width: 'full' },
      { id: 'decision', label: '결정안', type: 'select', required: true, options: ['시행', '보완 후 시행', '보류', '중단'], width: 'half' },
      { id: 'resultReport', label: '결과보고 방법', type: 'select', required: true, options: ['홈페이지 게시', '개별 안내', '법회 보고', '이사회 보고', '생략', '기타'], width: 'half' },
      { id: 'notes', label: '비고', type: 'textarea', required: false, width: 'full' },
    ],
    bodyTemplate: '1. 모금명: {{subject}}\n2. 모금목적\n{{purpose}}\n\n3. 모금기간: {{startDate}} ~ {{endDate}}\n4. 모금대상: {{target}}\n5. 예상금액: {{expectedAmount}}원\n6. 안내문·홍보물: {{publicityMaterial}}\n7. 관계 법령 검토: {{legalReview}}\n8. 검토의견\n{{reviewOpinion}}\n\n9. 결정안: {{decision}}\n10. 결과보고 방법: {{resultReport}}\n11. 비고\n{{notes}}',
  },
  {
    id: 'TPL-DONATION-RETURN-REVIEW', name: '후원금품 환급·반환 검토서', description: '후원금·보시금 관리규정 별지 제13호를 반영한 환급·반환 적정성 검토 서식',
    docType: '기안', category: '후원금·보시금·목적지정 기부금 관련 중요 문서', titlePrefix: '[후원금품 반환검토] ',
    fields: [
      { id: 'subject', label: '반환 검토 건명', type: 'text', required: true, width: 'full' },
      { id: 'requester', label: '요청자', type: 'text', required: true, width: 'half' },
      { id: 'receivedDate', label: '접수일자', type: 'date', required: true, width: 'half' },
      { id: 'requestDate', label: '반환요청일', type: 'date', required: true, width: 'half' },
      { id: 'item', label: '금액 또는 물품', type: 'text', required: true, width: 'half' },
      { id: 'reason', label: '반환사유', type: 'select', required: true, options: ['착오입금', '조건 불수락', '법령상 필요', '미사용 반환요청', '기타'], width: 'half' },
      { id: 'usageStatus', label: '사용여부', type: 'select', required: true, options: ['미사용', '일부 사용', '전액 사용', '물품 사용·처분'], width: 'half' },
      { id: 'reviewOpinion', label: '검토의견', type: 'textarea', required: true, width: 'full' },
      { id: 'decision', label: '결정안', type: 'select', required: true, options: ['전액 반환', '일부 반환', '반환 불가', '이사회 부의'], width: 'half' },
      { id: 'returnAmount', label: '반환금액(원)', type: 'money', required: false, defaultValue: '0', width: 'half' },
      { id: 'returnAccount', label: '반환계좌', type: 'text', required: false, placeholder: '은행명 / 예금주 / 계좌번호', width: 'full' },
      { id: 'result', label: '반환 처리 결과', type: 'select', required: true, options: ['반환 완료', '반환 불가 통지', '일부 반환', '이사회 부의', '기타'], width: 'half' },
      { id: 'notes', label: '비고', type: 'textarea', required: false, width: 'full' },
    ],
    bodyTemplate: '1. 반환 검토 건명: {{subject}}\n2. 요청자: {{requester}}\n3. 접수일자 / 반환요청일: {{receivedDate}} / {{requestDate}}\n4. 금액 또는 물품: {{item}}\n5. 반환사유: {{reason}}\n6. 사용여부: {{usageStatus}}\n7. 검토의견\n{{reviewOpinion}}\n\n8. 결정안: {{decision}}\n9. 반환금액: {{returnAmount}}원\n10. 반환계좌: {{returnAccount}}\n11. 반환 처리 결과: {{result}}\n12. 비고\n{{notes}}',
  },
  {
    id: 'TPL-FACILITY-INVESTMENT-REVIEW', name: '무상사용 시설 투자 검토서', description: '사찰시설 보전기금 운영규정 별지 제3호를 반영한 시설 투자·권리관계 검토 서식',
    docType: '기안', category: '계약서·협약서·양해각서 및 재산 관련 문서', titlePrefix: '[시설투자 검토] ',
    fields: [
      { id: 'subject', label: '투자 건명', type: 'text', required: true, width: 'full' },
      { id: 'reviewDate', label: '작성일자', type: 'date', required: true, width: 'half' },
      { id: 'facilityAddress', label: '시설 소재지', type: 'text', required: true, width: 'full' },
      { id: 'owner', label: '소유자 성명·법인명', type: 'text', required: true, width: 'half' },
      { id: 'usageRelation', label: '법인 사용관계', type: 'select', required: true, options: ['무상사용', '임대차', '사용대차', '기타'], width: 'half' },
      { id: 'startDate', label: '사용 시작일', type: 'date', required: false, width: 'half' },
      { id: 'endDate', label: '사용 종료일', type: 'date', required: false, width: 'half' },
      { id: 'investmentType', label: '투자 내용', type: 'select', required: true, options: ['수리', '개보수', '증축', '설비 설치', '안전보강', '기타'], width: 'half' },
      { id: 'plannedAmount', label: '투자 예정금액(원)', type: 'money', required: true, defaultValue: '0', width: 'half' },
      { id: 'necessity', label: '투자 필요성', type: 'textarea', required: true, width: 'full' },
      { id: 'purposeRelation', label: '법인 목적사업 관련성', type: 'textarea', required: true, width: 'full' },
      { id: 'ownershipAfter', label: '공사 후 권리관계', type: 'select', required: true, options: ['법인 소유', '소유자 귀속', '협의 필요', '기타'], width: 'half' },
      { id: 'endTreatment', label: '사용관계 종료 시 처리', type: 'select', required: true, options: ['무상귀속', '원상회복', '이전·회수', '보상·상환 협의', '기타'], width: 'half' },
      { id: 'relatedParty', label: '이해관계 여부', type: 'select', required: true, options: ['해당 없음', '이사장·임원·종정·회원·소유자 관련', '추가검토 필요'], width: 'half' },
      { id: 'reviewOpinion', label: '검토의견', type: 'textarea', required: true, width: 'full' },
      { id: 'decision', label: '결정안', type: 'select', required: true, options: ['승인', '보완 후 승인', '이사회 부의', '보류', '불승인'], width: 'half' },
    ],
    bodyTemplate: '1. 투자 건명: {{subject}}\n2. 작성일자: {{reviewDate}}\n3. 시설 소재지: {{facilityAddress}}\n4. 소유자 / 사용관계: {{owner}} / {{usageRelation}}\n5. 사용기간: {{startDate}} ~ {{endDate}}\n6. 투자 내용 / 예정금액: {{investmentType}} / {{plannedAmount}}원\n7. 투자 필요성\n{{necessity}}\n\n8. 법인 목적사업 관련성\n{{purposeRelation}}\n\n9. 공사 후 권리관계: {{ownershipAfter}}\n10. 사용관계 종료 시 처리: {{endTreatment}}\n11. 이해관계 여부: {{relatedParty}}\n12. 검토의견\n{{reviewOpinion}}\n\n13. 결정안: {{decision}}',
  },
  {
    id: 'TPL-CONTRACT-REVIEW', name: '공사·구매·용역 계약 검토서', description: '사찰시설 보전기금 운영규정 별지 제5호를 반영한 계약 사전검토 서식',
    docType: '기안', category: '계약서·협약서·양해각서 및 재산 관련 문서', titlePrefix: '[계약검토] ',
    fields: [
      { id: 'subject', label: '계약명', type: 'text', required: true, width: 'full' },
      { id: 'reviewDate', label: '작성일자', type: 'date', required: true, width: 'half' },
      { id: 'contractType', label: '계약구분', type: 'select', required: true, options: ['공사', '구매', '용역', '설계·감리', '안전점검', '기타'], width: 'half' },
      { id: 'counterparty', label: '계약상대방', type: 'text', required: true, placeholder: '상호·성명 / 사업자등록번호 / 연락처', width: 'full' },
      { id: 'amount', label: '계약금액(원)', type: 'money', required: true, defaultValue: '0', width: 'half' },
      { id: 'startDate', label: '계약 시작일', type: 'date', required: true, width: 'half' },
      { id: 'endDate', label: '계약 종료일', type: 'date', required: true, width: 'half' },
      { id: 'necessity', label: '계약 필요성', type: 'textarea', required: true, width: 'full' },
      { id: 'mainTerms', label: '주요 계약내용', type: 'textarea', required: true, width: 'full' },
      { id: 'quoteCheck', label: '견적 확인', type: 'select', required: true, options: ['단일 견적', '복수 견적', '긴급수리', '기타'], width: 'half' },
      { id: 'documents', label: '첨부서류', type: 'textarea', required: true, placeholder: '견적서, 계약서, 사업자등록증, 자격·면허, 보험증명 등', width: 'full' },
      { id: 'relatedParty', label: '이해관계 여부', type: 'select', required: true, options: ['해당 없음', '해당 있음'], width: 'half' },
      { id: 'legalReview', label: '인허가·법령 검토', type: 'select', required: true, options: ['불필요', '필요', '추가검토 필요'], width: 'half' },
      { id: 'reviewOpinion', label: '검토의견', type: 'textarea', required: true, width: 'full' },
      { id: 'decision', label: '결정안', type: 'select', required: true, options: ['승인', '보완 후 승인', '이사회 부의', '보류', '불승인'], width: 'half' },
    ],
    bodyTemplate: '1. 계약명: {{subject}}\n2. 작성일자: {{reviewDate}}\n3. 계약구분: {{contractType}}\n4. 계약상대방: {{counterparty}}\n5. 계약금액: {{amount}}원\n6. 계약기간: {{startDate}} ~ {{endDate}}\n7. 계약 필요성\n{{necessity}}\n\n8. 주요 계약내용\n{{mainTerms}}\n\n9. 견적 확인: {{quoteCheck}}\n10. 첨부서류\n{{documents}}\n11. 이해관계 여부: {{relatedParty}}\n12. 인허가·법령 검토: {{legalReview}}\n13. 검토의견\n{{reviewOpinion}}\n\n14. 결정안: {{decision}}',
  },
  {
    id: 'TPL-SAFETY-PLAN', name: '안전관리계획서', description: '안전관리 및 보험가입 규정 별지 제1호를 반영한 행사·시설 안전관리 계획 서식',
    docType: '기안', category: '그 밖에 법인의 권리·의무에 중요한 영향을 미치는 문서', titlePrefix: '[안전관리계획] ',
    fields: [
      { id: 'subject', label: '행사명', type: 'text', required: true, width: 'full' },
      { id: 'eventDateTime', label: '행사일시', type: 'text', required: true, placeholder: 'YYYY-MM-DD HH:MM ~ HH:MM', width: 'half' },
      { id: 'place', label: '행사장소', type: 'text', required: true, width: 'half' },
      { id: 'organization', label: '주관기구', type: 'text', required: true, width: 'half' },
      { id: 'manager', label: '운영책임자', type: 'text', required: true, width: 'half' },
      { id: 'safetyManager', label: '안전관리담당자', type: 'text', required: true, width: 'half' },
      { id: 'target', label: '참가대상', type: 'text', required: true, width: 'half' },
      { id: 'expectedCount', label: '예상인원', type: 'number', required: true, defaultValue: '0', width: 'half' },
      { id: 'eventType', label: '행사유형', type: 'select', required: true, options: ['법회', '의례', '수행', '교육', '포교', '숙박형', '야외행사', '성지순례', '봉사활동', '기타'], width: 'half' },
      { id: 'schedule', label: '주요 일정', type: 'textarea', required: true, width: 'full' },
      { id: 'risks', label: '주요 위험요인', type: 'textarea', required: true, width: 'full' },
      { id: 'precheck', label: '사전 안전점검', type: 'select', required: true, options: ['완료', '예정', '해당 없음'], width: 'half' },
      { id: 'insurance', label: '보험가입 여부', type: 'select', required: true, options: ['가입', '미가입', '검토 중', '해당 없음'], width: 'half' },
      { id: 'emergencyPlan', label: '응급조치 계획', type: 'textarea', required: true, width: 'full' },
      { id: 'emergencyContacts', label: '비상연락망', type: 'textarea', required: true, width: 'full' },
      { id: 'guardianConsent', label: '보호자 동의 필요 여부', type: 'select', required: true, options: ['필요', '불필요'], width: 'half' },
      { id: 'personalData', label: '개인정보 수집 여부', type: 'select', required: true, options: ['있음', '없음'], width: 'half' },
      { id: 'notes', label: '기타 유의사항', type: 'textarea', required: false, width: 'full' },
    ],
    bodyTemplate: '1. 행사명: {{subject}}\n2. 행사일시 / 장소: {{eventDateTime}} / {{place}}\n3. 주관기구: {{organization}}\n4. 운영책임자 / 안전관리담당자: {{manager}} / {{safetyManager}}\n5. 참가대상 / 예상인원: {{target}} / {{expectedCount}}명\n6. 행사유형: {{eventType}}\n7. 주요 일정\n{{schedule}}\n\n8. 주요 위험요인\n{{risks}}\n\n9. 사전 안전점검: {{precheck}}\n10. 보험가입 여부: {{insurance}}\n11. 응급조치 계획\n{{emergencyPlan}}\n\n12. 비상연락망\n{{emergencyContacts}}\n\n13. 보호자 동의 필요 여부: {{guardianConsent}}\n14. 개인정보 수집 여부: {{personalData}}\n15. 기타 유의사항\n{{notes}}',
  },
  {
    id: 'TPL-INSURANCE-REVIEW', name: '보험가입 검토서', description: '안전관리 및 보험가입 규정 별지 제5호를 반영한 보험 필요성·보장내용 검토 서식',
    docType: '기안', category: '계약서·협약서·양해각서 및 재산 관련 문서', titlePrefix: '[보험가입 검토] ',
    fields: [
      { id: 'subject', label: '행사명 또는 시설명', type: 'text', required: true, width: 'full' },
      { id: 'reviewDate', label: '검토일자', type: 'date', required: true, width: 'half' },
      { id: 'targetType', label: '검토대상', type: 'select', required: true, options: ['시설', '행사', '숙박형 프로그램', '야외행사', '성지순례', '자원봉사', '기타'], width: 'half' },
      { id: 'expectedCount', label: '예상 참가자 수', type: 'number', required: false, defaultValue: '0', width: 'half' },
      { id: 'risks', label: '주요 위험요인', type: 'textarea', required: true, width: 'full' },
      { id: 'insuranceType', label: '검토 보험종류', type: 'select', required: true, options: ['화재보험', '시설배상책임보험', '행사보험', '여행자보험', '상해보험', '임원배상책임보험', '기타'], width: 'half' },
      { id: 'necessity', label: '보험가입 필요성', type: 'select', required: true, options: ['필요', '불필요', '추가검토'], width: 'half' },
      { id: 'company', label: '보험회사', type: 'text', required: false, width: 'half' },
      { id: 'period', label: '보험기간', type: 'text', required: false, width: 'half' },
      { id: 'coverage', label: '보장내용', type: 'textarea', required: false, width: 'full' },
      { id: 'premium', label: '보험료(원)', type: 'money', required: false, defaultValue: '0', width: 'half' },
      { id: 'deductible', label: '자기부담금(원)', type: 'money', required: false, defaultValue: '0', width: 'half' },
      { id: 'exclusions', label: '면책사항', type: 'textarea', required: false, width: 'full' },
      { id: 'reviewOpinion', label: '검토의견', type: 'textarea', required: true, width: 'full' },
    ],
    bodyTemplate: '1. 행사명 또는 시설명: {{subject}}\n2. 검토일자: {{reviewDate}}\n3. 검토대상: {{targetType}}\n4. 예상 참가자 수: {{expectedCount}}명\n5. 주요 위험요인\n{{risks}}\n\n6. 검토 보험종류: {{insuranceType}}\n7. 보험가입 필요성: {{necessity}}\n8. 보험회사 / 기간: {{company}} / {{period}}\n9. 보장내용\n{{coverage}}\n10. 보험료 / 자기부담금: {{premium}}원 / {{deductible}}원\n11. 면책사항\n{{exclusions}}\n12. 검토의견\n{{reviewOpinion}}',
  },
  {
    id: 'TPL-ACCIDENT-REPORT', name: '사고보고서', description: '안전관리 및 보험가입 규정 별지 제7호를 반영한 사고 발생·초동조치 보고 서식',
    docType: '기안', category: '그 밖에 법인의 권리·의무에 중요한 영향을 미치는 문서', titlePrefix: '[사고보고] ',
    fields: [
      { id: 'subject', label: '사고명', type: 'text', required: true, width: 'full' },
      { id: 'reportDate', label: '보고일자', type: 'date', required: true, width: 'half' },
      { id: 'reporter', label: '보고자', type: 'text', required: true, width: 'half' },
      { id: 'incidentDateTime', label: '사고일시', type: 'text', required: true, width: 'half' },
      { id: 'place', label: '사고장소', type: 'text', required: true, width: 'half' },
      { id: 'eventName', label: '관련 행사명', type: 'text', required: false, width: 'full' },
      { id: 'incidentType', label: '사고유형', type: 'select', required: true, options: ['부상', '질병', '화재', '교통사고', '식중독', '실종', '성희롱·성폭력', '개인정보 유출', '시설파손', '기타'], width: 'half' },
      { id: 'relatedPersons', label: '피해자 또는 관련자', type: 'textarea', required: true, width: 'full' },
      { id: 'circumstances', label: '사고경위', type: 'textarea', required: true, width: 'full' },
      { id: 'immediateAction', label: '현장조치', type: 'textarea', required: true, width: 'full' },
      { id: 'agencyReport', label: '119·112·의료기관 신고', type: 'select', required: true, options: ['완료', '미실시', '해당 없음'], width: 'half' },
      { id: 'guardianNotice', label: '보호자·비상연락처 통지', type: 'select', required: true, options: ['완료', '예정', '해당 없음'], width: 'half' },
      { id: 'hospitalTransfer', label: '병원 이송 여부', type: 'select', required: true, options: ['이송', '미이송', '해당 없음'], width: 'half' },
      { id: 'insurance', label: '보험가입 여부', type: 'select', required: true, options: ['가입', '미가입', '확인 중', '해당 없음'], width: 'half' },
      { id: 'claimNeed', label: '보험금 청구 필요 여부', type: 'select', required: true, options: ['필요', '불필요', '검토 중'], width: 'half' },
      { id: 'evidence', label: '증빙자료', type: 'textarea', required: false, width: 'full' },
      { id: 'prevention', label: '재발방지 대책', type: 'textarea', required: true, width: 'full' },
      { id: 'boardReport', label: '이사회 보고 필요 여부', type: 'select', required: true, options: ['필요', '불필요'], width: 'half' },
    ],
    bodyTemplate: '1. 사고명: {{subject}}\n2. 보고일자 / 보고자: {{reportDate}} / {{reporter}}\n3. 사고일시 / 장소: {{incidentDateTime}} / {{place}}\n4. 관련 행사명: {{eventName}}\n5. 사고유형: {{incidentType}}\n6. 피해자 또는 관련자\n{{relatedPersons}}\n\n7. 사고경위\n{{circumstances}}\n\n8. 현장조치\n{{immediateAction}}\n\n9. 관계기관 신고: {{agencyReport}}\n10. 보호자 통지: {{guardianNotice}}\n11. 병원 이송: {{hospitalTransfer}}\n12. 보험가입 / 청구 필요: {{insurance}} / {{claimNeed}}\n13. 증빙자료\n{{evidence}}\n14. 재발방지 대책\n{{prevention}}\n15. 이사회 보고 필요 여부: {{boardReport}}',
  },
  {
    id: 'TPL-RECURRENCE-PREVENTION', name: '재발방지 대책 보고서', description: '안전관리 및 보험가입 규정 별지 제8호를 반영한 사고 원인·개선조치 보고 서식',
    docType: '기안', category: '그 밖에 법인의 권리·의무에 중요한 영향을 미치는 문서', titlePrefix: '[재발방지대책] ',
    fields: [
      { id: 'subject', label: '관련 사고명', type: 'text', required: true, width: 'full' },
      { id: 'reportDate', label: '보고일자', type: 'date', required: true, width: 'half' },
      { id: 'incidentDateTime', label: '사고일시', type: 'text', required: true, width: 'half' },
      { id: 'place', label: '사고장소', type: 'text', required: true, width: 'half' },
      { id: 'cause', label: '사고원인', type: 'textarea', required: true, width: 'full' },
      { id: 'damage', label: '피해내용', type: 'textarea', required: true, width: 'full' },
      { id: 'existingActions', label: '기존 조치사항', type: 'textarea', required: true, width: 'full' },
      { id: 'prevention', label: '재발방지 대책', type: 'textarea', required: true, width: 'full' },
      { id: 'facilityImprovement', label: '시설보완 필요사항', type: 'textarea', required: false, width: 'full' },
      { id: 'education', label: '교육 또는 안내 필요사항', type: 'textarea', required: false, width: 'full' },
      { id: 'insuranceCompensation', label: '보험 또는 보상 처리사항', type: 'textarea', required: false, width: 'full' },
      { id: 'budgetNeed', label: '추가 예산 필요 여부', type: 'select', required: true, options: ['필요', '불필요', '검토 중'], width: 'half' },
      { id: 'boardReport', label: '이사회 보고 여부', type: 'select', required: true, options: ['보고 완료', '보고 예정', '불필요'], width: 'half' },
    ],
    bodyTemplate: '1. 관련 사고명: {{subject}}\n2. 보고일자: {{reportDate}}\n3. 사고일시 / 장소: {{incidentDateTime}} / {{place}}\n4. 사고원인\n{{cause}}\n\n5. 피해내용\n{{damage}}\n\n6. 기존 조치사항\n{{existingActions}}\n\n7. 재발방지 대책\n{{prevention}}\n\n8. 시설보완 필요사항\n{{facilityImprovement}}\n\n9. 교육 또는 안내 필요사항\n{{education}}\n\n10. 보험 또는 보상 처리사항\n{{insuranceCompensation}}\n11. 추가 예산 필요 여부: {{budgetNeed}}\n12. 이사회 보고 여부: {{boardReport}}',
  },
  {
    id: 'TPL-EDUCATION-PLAN', name: '교육계획서', description: '승려·법사·포교사 교육규정 별지 제2호를 반영한 교육과정 운영계획 서식',
    docType: '기안', category: ROUTINE_CATEGORY, titlePrefix: '[교육계획] ',
    fields: [
      { id: 'subject', label: '교육명', type: 'text', required: true, width: 'full' },
      { id: 'purpose', label: '교육목적', type: 'textarea', required: true, width: 'full' },
      { id: 'target', label: '교육대상', type: 'text', required: true, width: 'full' },
      { id: 'startDate', label: '교육 시작일', type: 'date', required: true, width: 'half' },
      { id: 'endDate', label: '교육 종료일', type: 'date', required: true, width: 'half' },
      { id: 'place', label: '교육장소', type: 'text', required: true, width: 'half' },
      { id: 'organization', label: '주관기구', type: 'text', required: true, width: 'half' },
      { id: 'manager', label: '교육책임자', type: 'text', required: true, width: 'half' },
      { id: 'instructors', label: '강사 또는 수행지도자', type: 'textarea', required: true, width: 'full' },
      { id: 'content', label: '교육내용', type: 'textarea', required: true, width: 'full' },
      { id: 'completionCriteria', label: '수료기준', type: 'textarea', required: true, width: 'full' },
      { id: 'evaluation', label: '평가방법', type: 'textarea', required: false, width: 'full' },
      { id: 'fee', label: '교육비(원)', type: 'money', required: false, defaultValue: '0', width: 'half' },
      { id: 'safety', label: '안전관리 사항', type: 'textarea', required: false, width: 'full' },
      { id: 'insurance', label: '보험가입 여부', type: 'select', required: true, options: ['가입', '미가입', '해당 없음'], width: 'half' },
      { id: 'privacy', label: '개인정보 처리사항', type: 'textarea', required: false, width: 'full' },
      { id: 'boardNeed', label: '이사회 보고·의결 여부', type: 'select', required: true, options: ['필요', '불필요'], width: 'half' },
    ],
    bodyTemplate: '1. 교육명: {{subject}}\n2. 교육목적\n{{purpose}}\n\n3. 교육대상: {{target}}\n4. 교육기간: {{startDate}} ~ {{endDate}}\n5. 교육장소 / 주관기구: {{place}} / {{organization}}\n6. 교육책임자: {{manager}}\n7. 강사 또는 수행지도자\n{{instructors}}\n\n8. 교육내용\n{{content}}\n\n9. 수료기준\n{{completionCriteria}}\n\n10. 평가방법\n{{evaluation}}\n11. 교육비: {{fee}}원\n12. 안전관리 사항\n{{safety}}\n13. 보험가입 여부: {{insurance}}\n14. 개인정보 처리사항\n{{privacy}}\n15. 이사회 보고·의결 여부: {{boardNeed}}',
  },
  {
    id: 'TPL-APPOINTMENT-REVIEW', name: '위촉심사서', description: '승려·법사·포교사 교육규정 별지 제6호를 반영한 위촉 자격·활동범위 심사 서식',
    docType: '기안', category: '인사·보수·위촉·해촉·징계 관련 문서', titlePrefix: '[위촉심사] ',
    fields: [
      { id: 'subject', label: '위촉대상자 성명', type: 'text', required: true, width: 'full' },
      { id: 'reviewDate', label: '심사일자', type: 'date', required: true, width: 'half' },
      { id: 'position', label: '위촉 예정 직분', type: 'select', required: true, options: ['승려', '법사', '포교사', '수행지도자', '강사', '의례집전자', '의례보조자', '운영담당자', '기타'], width: 'half' },
      { id: 'educationCompleted', label: '교육수료 여부', type: 'select', required: true, options: ['수료', '미수료', '확인 필요'], width: 'half' },
      { id: 'activityHistory', label: '활동이력', type: 'textarea', required: true, width: 'full' },
      { id: 'practiceHistory', label: '신행·수행 이력', type: 'textarea', required: true, width: 'full' },
      { id: 'ethicsHistory', label: '윤리·징계 또는 민원 여부', type: 'textarea', required: true, width: 'full' },
      { id: 'scope', label: '활동범위', type: 'textarea', required: true, width: 'full' },
      { id: 'startDate', label: '위촉 시작일', type: 'date', required: true, width: 'half' },
      { id: 'endDate', label: '위촉 종료일', type: 'date', required: true, width: 'half' },
      { id: 'payment', label: '보수·실비 지급 여부', type: 'select', required: true, options: ['없음', '있음'], width: 'half' },
      { id: 'reviewOpinion', label: '검토의견', type: 'textarea', required: true, width: 'full' },
      { id: 'result', label: '심사결과', type: 'select', required: true, options: ['위촉', '보류', '부결', '재교육 필요'], width: 'half' },
      { id: 'boardDate', label: '이사회 의결일', type: 'date', required: false, width: 'half' },
    ],
    bodyTemplate: '1. 위촉대상자: {{subject}}\n2. 심사일자: {{reviewDate}}\n3. 위촉 예정 직분: {{position}}\n4. 교육수료 여부: {{educationCompleted}}\n5. 활동이력\n{{activityHistory}}\n\n6. 신행·수행 이력\n{{practiceHistory}}\n\n7. 윤리·징계 또는 민원 여부\n{{ethicsHistory}}\n\n8. 활동범위\n{{scope}}\n\n9. 위촉기간: {{startDate}} ~ {{endDate}}\n10. 보수·실비 지급 여부: {{payment}}\n11. 검토의견\n{{reviewOpinion}}\n\n12. 심사결과: {{result}}\n13. 이사회 의결일: {{boardDate}}',
  },
  {
    id: 'TPL-DISMISSAL-REVIEW', name: '해촉심사서', description: '승려·법사·포교사 교육규정 별지 제10호를 반영한 해촉·활동제한 심사 서식',
    docType: '기안', category: '인사·보수·위촉·해촉·징계 관련 문서', titlePrefix: '[해촉심사] ',
    fields: [
      { id: 'subject', label: '심사대상자 성명', type: 'text', required: true, width: 'full' },
      { id: 'reviewDate', label: '심사일자', type: 'date', required: true, width: 'half' },
      { id: 'position', label: '위촉 직분', type: 'text', required: true, width: 'half' },
      { id: 'startDate', label: '위촉 시작일', type: 'date', required: true, width: 'half' },
      { id: 'endDate', label: '위촉 종료일', type: 'date', required: false, width: 'half' },
      { id: 'reason', label: '해촉 사유', type: 'textarea', required: true, width: 'full' },
      { id: 'facts', label: '관련 사실', type: 'textarea', required: true, width: 'full' },
      { id: 'hearing', label: '소명기회 부여 여부', type: 'select', required: true, options: ['부여', '미부여', '해당 없음'], width: 'half' },
      { id: 'returnNeed', label: '자료반환 필요 여부', type: 'select', required: true, options: ['필요', '불필요'], width: 'half' },
      { id: 'nameUseNotice', label: '직위명·법인명칭 사용 제한 안내', type: 'select', required: true, options: ['완료', '예정'], width: 'half' },
      { id: 'result', label: '심사결과', type: 'select', required: true, options: ['해촉', '활동제한', '경고', '재교육', '기타'], width: 'half' },
      { id: 'returnStatus', label: '자료반환 완료 여부', type: 'select', required: true, options: ['완료', '미완료', '해당 없음'], width: 'half' },
      { id: 'noticeDate', label: '직분명 사용중지 통지일', type: 'date', required: false, width: 'half' },
      { id: 'followUp', label: '후속조치', type: 'textarea', required: true, width: 'full' },
      { id: 'boardDate', label: '이사회 의결일', type: 'date', required: false, width: 'half' },
    ],
    bodyTemplate: '1. 심사대상자: {{subject}}\n2. 심사일자: {{reviewDate}}\n3. 위촉 직분 / 기간: {{position}} / {{startDate}} ~ {{endDate}}\n4. 해촉 사유\n{{reason}}\n\n5. 관련 사실\n{{facts}}\n\n6. 소명기회 부여 여부: {{hearing}}\n7. 자료반환 필요 여부: {{returnNeed}}\n8. 직위명·법인명칭 사용 제한 안내: {{nameUseNotice}}\n9. 심사결과: {{result}}\n10. 자료반환 완료 여부: {{returnStatus}}\n11. 직분명 사용중지 통지일: {{noticeDate}}\n12. 후속조치\n{{followUp}}\n\n13. 이사회 의결일: {{boardDate}}',
  },
  {
    id: 'TPL-EVENT-PLAN', name: '법회·의례·수행 운영계획서', description: '법회·의례·수행 운영규정 별지 제1호를 반영한 행사 운영계획 서식',
    docType: '기안', category: ROUTINE_CATEGORY, titlePrefix: '[행사운영계획] ',
    fields: [
      { id: 'subject', label: '행사명', type: 'text', required: true, width: 'full' },
      { id: 'eventType', label: '구분', type: 'select', required: true, options: ['법회', '의례', '수행', '교육', '성지순례', '기타'], width: 'half' },
      { id: 'dateTime', label: '일시', type: 'text', required: true, width: 'half' },
      { id: 'place', label: '장소', type: 'text', required: true, width: 'half' },
      { id: 'organization', label: '주관기구', type: 'select', required: true, options: ['총무원', '교육원', '포교원', '사무처', '기타'], width: 'half' },
      { id: 'manager', label: '운영책임자', type: 'text', required: true, width: 'half' },
      { id: 'leader', label: '진행자 또는 수행지도자', type: 'text', required: true, width: 'half' },
      { id: 'target', label: '대상자', type: 'text', required: true, width: 'half' },
      { id: 'expectedCount', label: '예상 참여인원', type: 'number', required: true, defaultValue: '0', width: 'half' },
      { id: 'content', label: '주요 내용', type: 'textarea', required: true, width: 'full' },
      { id: 'supplies', label: '준비물', type: 'textarea', required: false, width: 'full' },
      { id: 'feeStatus', label: '참가비·보시금·교육비 여부', type: 'select', required: true, options: ['없음', '있음'], width: 'half' },
      { id: 'feeDetails', label: '금액 또는 기준', type: 'text', required: false, width: 'half' },
      { id: 'budget', label: '필요예산(원)', type: 'money', required: false, defaultValue: '0', width: 'half' },
      { id: 'financeManager', label: '수입·지출 관리 담당', type: 'text', required: true, width: 'half' },
      { id: 'safety', label: '안전관리 필요사항', type: 'textarea', required: false, width: 'full' },
    ],
    bodyTemplate: '1. 행사명: {{subject}}\n2. 구분 / 일시 / 장소: {{eventType}} / {{dateTime}} / {{place}}\n3. 주관기구: {{organization}}\n4. 운영책임자 / 진행자·수행지도자: {{manager}} / {{leader}}\n5. 대상자 / 예상 참여인원: {{target}} / {{expectedCount}}명\n6. 주요 내용\n{{content}}\n\n7. 준비물\n{{supplies}}\n\n8. 참가비·보시금·교육비 여부: {{feeStatus}}\n  - 금액 또는 기준: {{feeDetails}}\n9. 필요예산: {{budget}}원\n10. 수입·지출 관리 담당: {{financeManager}}\n11. 안전관리 필요사항\n{{safety}}',
  },
  {
    id: 'TPL-EVENT-RESULT', name: '법회·의례·수행 결과보고서 및 정산서', description: '법회·의례·수행 운영규정 별지 제2호를 반영한 행사 결과·정산 보고 서식',
    docType: '기안', category: '예산·결산·사업계획·사업실적 관련 문서', titlePrefix: '[행사결과·정산] ',
    fields: [
      { id: 'subject', label: '행사명', type: 'text', required: true, width: 'full' },
      { id: 'eventType', label: '구분', type: 'select', required: true, options: ['법회', '의례', '수행', '교육', '성지순례', '기타'], width: 'half' },
      { id: 'dateTime', label: '일시', type: 'text', required: true, width: 'half' },
      { id: 'place', label: '장소', type: 'text', required: true, width: 'half' },
      { id: 'organization', label: '주관기구', type: 'text', required: true, width: 'half' },
      { id: 'manager', label: '운영책임자', type: 'text', required: true, width: 'half' },
      { id: 'leader', label: '진행자 또는 수행지도자', type: 'text', required: true, width: 'half' },
      { id: 'attendance', label: '참석인원', type: 'number', required: true, defaultValue: '0', width: 'half' },
      { id: 'content', label: '주요 진행내용', type: 'textarea', required: true, width: 'full' },
      { id: 'income', label: '수입내역', type: 'textarea', required: true, width: 'full' },
      { id: 'expense', label: '지출내역', type: 'textarea', required: true, width: 'full' },
      { id: 'balance', label: '잔액 또는 반환금', type: 'textarea', required: true, width: 'full' },
      { id: 'evidence', label: '증빙자료', type: 'textarea', required: true, placeholder: '영수증, 계좌이체내역, 참가자명부, 사진, 결과물 등', width: 'full' },
      { id: 'incident', label: '안전사고 또는 민원 발생 여부', type: 'select', required: true, options: ['없음', '있음'], width: 'half' },
      { id: 'incidentDetails', label: '사고·민원 내용', type: 'textarea', required: false, width: 'full' },
      { id: 'improvements', label: '개선사항', type: 'textarea', required: false, width: 'full' },
    ],
    bodyTemplate: '1. 행사명: {{subject}}\n2. 구분 / 일시 / 장소: {{eventType}} / {{dateTime}} / {{place}}\n3. 주관기구: {{organization}}\n4. 운영책임자 / 진행자·수행지도자: {{manager}} / {{leader}}\n5. 참석인원: {{attendance}}명\n6. 주요 진행내용\n{{content}}\n\n7. 수입내역\n{{income}}\n\n8. 지출내역\n{{expense}}\n\n9. 잔액 또는 반환금\n{{balance}}\n\n10. 증빙자료\n{{evidence}}\n11. 안전사고 또는 민원 발생 여부: {{incident}}\n{{incidentDetails}}\n12. 개선사항\n{{improvements}}',
  },
  {
    id: 'TPL-SEAL-USE', name: '인장사용신청서', description: '인장·통장 및 중요문서 관리규정 별지 2를 반영한 인장 사용 승인 서식',
    docType: '기안', category: '그 밖에 법인의 권리·의무에 중요한 영향을 미치는 문서', titlePrefix: '[인장사용] ',
    fields: [
      { id: 'subject', label: '사용문서명', type: 'text', required: true, width: 'full' },
      { id: 'requestDate', label: '신청일', type: 'date', required: true, width: 'half' },
      { id: 'requester', label: '신청자', type: 'text', required: true, width: 'half' },
      { id: 'role', label: '직위 또는 담당업무', type: 'text', required: true, width: 'half' },
      { id: 'contact', label: '연락처', type: 'text', required: true, width: 'half' },
      { id: 'sealType', label: '사용하려는 인장', type: 'select', required: true, options: ['법인인감', '사용인감', '직인', '계인', '고무인', '명판', '전자직인', '기타'], width: 'half' },
      { id: 'destination', label: '제출처 또는 사용처', type: 'text', required: true, width: 'half' },
      { id: 'purpose', label: '사용목적', type: 'textarea', required: true, width: 'full' },
      { id: 'copies', label: '사용부수', type: 'number', required: true, defaultValue: '1', width: 'half' },
      { id: 'originalStatus', label: '원본 제출 여부', type: 'select', required: true, options: ['원본 제출', '사본 제출', '내부보관', '기타'], width: 'half' },
      { id: 'relatedBusiness', label: '관련 안건 또는 사업명', type: 'text', required: false, width: 'full' },
      { id: 'useDate', label: '사용예정일', type: 'date', required: true, width: 'half' },
      { id: 'returnDate', label: '반환예정일', type: 'date', required: false, width: 'half' },
      { id: 'attachments', label: '첨부자료', type: 'textarea', required: true, placeholder: '사용문서 초안, 계약서, 공문, 신청서, 이사회 의결서 등', width: 'full' },
      { id: 'notes', label: '유의·보완사항', type: 'textarea', required: false, width: 'full' },
    ],
    bodyTemplate: '1. 사용문서명: {{subject}}\n2. 신청일 / 신청자: {{requestDate}} / {{requester}}\n3. 직위 또는 담당업무 / 연락처: {{role}} / {{contact}}\n4. 사용하려는 인장: {{sealType}}\n5. 제출처 또는 사용처: {{destination}}\n6. 사용목적\n{{purpose}}\n\n7. 사용부수 / 원본 제출 여부: {{copies}}부 / {{originalStatus}}\n8. 관련 안건 또는 사업명: {{relatedBusiness}}\n9. 사용예정일 / 반환예정일: {{useDate}} / {{returnDate}}\n10. 첨부자료\n{{attachments}}\n\n11. 유의·보완사항\n{{notes}}',
  },
  {
    id: 'TPL-DOCUMENT-DISPOSAL', name: '문서폐기 검토서', description: '문서관리 및 사무관리규정 별지 10을 반영한 보존기간·폐기제한 검토 서식',
    docType: '기안', category: '그 밖에 법인의 권리·의무에 중요한 영향을 미치는 문서', titlePrefix: '[문서폐기 검토] ',
    fields: [
      { id: 'subject', label: '폐기 예정 문서명', type: 'text', required: true, width: 'full' },
      { id: 'reviewDate', label: '검토일', type: 'date', required: true, width: 'half' },
      { id: 'reviewer', label: '검토자', type: 'text', required: true, width: 'half' },
      { id: 'documentType', label: '문서구분', type: 'select', required: true, options: ['공문', '회의자료', '회계자료', '회원자료', '후원자료', '계약서', '일반문서', '기타'], width: 'half' },
      { id: 'documentDate', label: '작성일 또는 접수일', type: 'date', required: true, width: 'half' },
      { id: 'retentionPeriod', label: '보존기간', type: 'text', required: true, width: 'half' },
      { id: 'expired', label: '보존기간 만료 여부', type: 'select', required: true, options: ['만료', '미만료', '확인 필요'], width: 'half' },
      { id: 'originalType', label: '원본 여부', type: 'select', required: true, options: ['원본', '사본', '전자파일'], width: 'half' },
      { id: 'personalData', label: '개인정보 포함 여부', type: 'select', required: true, options: ['없음', '있음', '확인 필요'], width: 'half' },
      { id: 'reason', label: '폐기 사유', type: 'select', required: true, options: ['보존기간 경과', '중복문서', '업무종료', '전자화 완료', '개인정보 보존 필요성 소멸', '기타'], width: 'half' },
      { id: 'method', label: '폐기 방법', type: 'select', required: true, options: ['파쇄', '소각', '전자파일 삭제', '저장매체 초기화', '외부 폐기업체 위탁', '기타'], width: 'half' },
      { id: 'restriction', label: '폐기 제한 여부', type: 'select', required: true, options: ['제한 없음', '영구보존 대상', '분쟁·감사 가능성', '주무관청 제출 필요', '기타'], width: 'half' },
      { id: 'opinion', label: '검토의견', type: 'textarea', required: true, width: 'full' },
      { id: 'plannedDate', label: '폐기 예정일', type: 'date', required: false, width: 'half' },
    ],
    bodyTemplate: '1. 폐기 예정 문서명: {{subject}}\n2. 검토일 / 검토자: {{reviewDate}} / {{reviewer}}\n3. 문서구분 / 작성·접수일: {{documentType}} / {{documentDate}}\n4. 보존기간 / 만료 여부: {{retentionPeriod}} / {{expired}}\n5. 원본 여부 / 개인정보 포함 여부: {{originalType}} / {{personalData}}\n6. 폐기 사유: {{reason}}\n7. 폐기 방법: {{method}}\n8. 폐기 제한 여부: {{restriction}}\n9. 검토의견\n{{opinion}}\n\n10. 폐기 예정일: {{plannedDate}}',
  },
  {
    id: 'TPL-HANDOVER', name: '업무 인수인계서', description: '문서관리 및 사무관리규정 별지 12를 반영한 담당업무·문서·계정 인수인계 서식',
    docType: '기안', category: ROUTINE_CATEGORY, titlePrefix: '[업무 인수인계] ',
    fields: [
      { id: 'subject', label: '인수인계 업무명', type: 'text', required: true, width: 'full' },
      { id: 'handoverDate', label: '인수인계일', type: 'date', required: true, width: 'half' },
      { id: 'reason', label: '인수인계 사유', type: 'select', required: true, options: ['담당자 변경', '보직 변경', '사임', '해촉', '휴직', '활동거점 폐쇄', '정기 인수인계', '기타'], width: 'half' },
      { id: 'fromPerson', label: '인계자 성명·직위', type: 'text', required: true, width: 'half' },
      { id: 'toPerson', label: '인수자 성명·직위', type: 'text', required: true, width: 'half' },
      { id: 'checker', label: '확인자', type: 'text', required: true, width: 'half' },
      { id: 'duties', label: '담당업무 및 정기일정', type: 'textarea', required: true, width: 'full' },
      { id: 'pendingWork', label: '진행 중·미결 업무', type: 'textarea', required: true, width: 'full' },
      { id: 'documents', label: '문서·자료 및 보관위치', type: 'textarea', required: true, width: 'full' },
      { id: 'accounts', label: '전자계정·접근권한', type: 'textarea', required: false, placeholder: '비밀번호는 직접 기재하지 말고 변경·인계 여부만 기록', width: 'full' },
      { id: 'assets', label: '인장·통장·비품·장비', type: 'textarea', required: false, width: 'full' },
      { id: 'contacts', label: '주요 연락처·협력기관', type: 'textarea', required: false, width: 'full' },
      { id: 'notes', label: '특이사항 및 후속조치', type: 'textarea', required: false, width: 'full' },
    ],
    bodyTemplate: '1. 인수인계 업무명: {{subject}}\n2. 인수인계일 / 사유: {{handoverDate}} / {{reason}}\n3. 인계자 / 인수자 / 확인자: {{fromPerson}} / {{toPerson}} / {{checker}}\n4. 담당업무 및 정기일정\n{{duties}}\n\n5. 진행 중·미결 업무\n{{pendingWork}}\n\n6. 문서·자료 및 보관위치\n{{documents}}\n\n7. 전자계정·접근권한\n{{accounts}}\n\n8. 인장·통장·비품·장비\n{{assets}}\n\n9. 주요 연락처·협력기관\n{{contacts}}\n\n10. 특이사항 및 후속조치\n{{notes}}',
  },
  {
    id: 'TPL-MEETING-MINUTES', name: '총회·이사회 의사록', description: '회의 운영 및 서면의결 관리규정 별지 9·10을 통합한 회의 의사록 작성 서식',
    docType: '기안', category: '총회·이사회 안건 및 의사록', titlePrefix: '[의사록] ',
    fields: [
      { id: 'subject', label: '회의명', type: 'text', required: true, width: 'full' },
      { id: 'meetingType', label: '회의 구분', type: 'select', required: true, options: ['정기총회', '임시총회', '정기이사회', '임시이사회', '기타'], width: 'half' },
      { id: 'dateTime', label: '일시', type: 'text', required: true, width: 'half' },
      { id: 'place', label: '장소', type: 'text', required: true, width: 'half' },
      { id: 'chair', label: '의장', type: 'text', required: true, width: 'half' },
      { id: 'recorder', label: '의사록 작성자', type: 'text', required: true, width: 'half' },
      { id: 'quorum', label: '재적·출석·정족수 현황', type: 'textarea', required: true, placeholder: '재적 수, 직접 출석, 위임·서면·전자 의결, 최종 출석 인정 인원', width: 'full' },
      { id: 'quorumMet', label: '의결정족수 충족 여부', type: 'select', required: true, options: ['충족', '미충족'], width: 'half' },
      { id: 'agenda', label: '안건 목록', type: 'textarea', required: true, placeholder: '제1호 안건명\n제2호 안건명', width: 'full' },
      { id: 'proceedings', label: '회의 진행 경과', type: 'textarea', required: true, placeholder: '개회 선언, 성원 보고, 안건 심의, 표결, 폐회 선언', width: 'full' },
      { id: 'discussion', label: '안건별 제안설명·주요의견', type: 'textarea', required: true, width: 'full' },
      { id: 'votes', label: '안건별 표결 및 의결결과', type: 'textarea', required: true, placeholder: '찬성·반대·기권·무효·가결/부결', width: 'full' },
      { id: 'recusal', label: '이해관계인 회피 여부', type: 'textarea', required: false, width: 'full' },
      { id: 'auditOpinion', label: '감사 의견', type: 'textarea', required: false, width: 'full' },
      { id: 'attachments', label: '첨부자료', type: 'textarea', required: true, placeholder: '소집통지서, 참석자명부, 위임장, 서면·전자 의결서, 회의자료 등', width: 'full' },
      { id: 'signers', label: '서명·기명날인 대상', type: 'textarea', required: true, placeholder: '의장, 출석 이사, 의사록 작성자', width: 'full' },
    ],
    bodyTemplate: '1. 회의명: {{subject}}\n2. 회의 구분 / 일시 / 장소: {{meetingType}} / {{dateTime}} / {{place}}\n3. 의장 / 의사록 작성자: {{chair}} / {{recorder}}\n4. 재적·출석·정족수 현황\n{{quorum}}\n5. 의결정족수 충족 여부: {{quorumMet}}\n6. 안건 목록\n{{agenda}}\n\n7. 회의 진행 경과\n{{proceedings}}\n\n8. 안건별 제안설명·주요의견\n{{discussion}}\n\n9. 안건별 표결 및 의결결과\n{{votes}}\n\n10. 이해관계인 회피 여부\n{{recusal}}\n\n11. 감사 의견\n{{auditOpinion}}\n\n12. 첨부자료\n{{attachments}}\n\n13. 서명·기명날인 대상\n{{signers}}',
  },
  {
    id: 'TPL-LEAVE-REQUEST', name: '휴가(경조휴가 포함) 신청서', description: '인사 및 근로관리규정 별지 제3호를 반영한 휴가 신청·업무 인계 서식',
    docType: '기안', category: '인사·보수·위촉·해촉·징계 관련 문서', titlePrefix: '[휴가신청] ',
    fields: [
      { id: 'subject', label: '신청자 성명', type: 'text', required: true, width: 'full' },
      { id: 'requestDate', label: '신청일', type: 'date', required: true, width: 'half' },
      { id: 'departmentRole', label: '부서 및 직위', type: 'text', required: true, width: 'half' },
      { id: 'contact', label: '연락처', type: 'text', required: true, width: 'half' },
      { id: 'leaveType', label: '휴가 구분', type: 'select', required: true, options: ['연차유급휴가', '경조휴가', '기타'], width: 'half' },
      { id: 'startDate', label: '휴가 시작일', type: 'date', required: true, width: 'half' },
      { id: 'endDate', label: '휴가 종료일', type: 'date', required: true, width: 'half' },
      { id: 'days', label: '총 일수', type: 'number', required: true, defaultValue: '1', width: 'half' },
      { id: 'reason', label: '휴가사유(선택)', type: 'textarea', required: false, width: 'full' },
      { id: 'emergencyContact', label: '비상연락처', type: 'text', required: true, width: 'half' },
      { id: 'handoverStatus', label: '업무 인수인계 사항', type: 'select', required: true, options: ['해당 없음', '해당 있음'], width: 'half' },
      { id: 'handoverPerson', label: '업무 인수자', type: 'text', required: false, width: 'half' },
      { id: 'handoverDetails', label: '인수인계 세부내용', type: 'textarea', required: false, width: 'full' },
    ],
    bodyTemplate: '1. 신청자: {{subject}}\n2. 신청일: {{requestDate}}\n3. 부서 및 직위 / 연락처: {{departmentRole}} / {{contact}}\n4. 휴가 구분: {{leaveType}}\n5. 휴가기간: {{startDate}} ~ {{endDate}} (총 {{days}}일)\n6. 휴가사유\n{{reason}}\n\n7. 비상연락처: {{emergencyContact}}\n8. 업무 인수인계 사항: {{handoverStatus}}\n  - 인수자: {{handoverPerson}}\n  - 세부내용\n{{handoverDetails}}',
  },
  {
    id: 'TPL-ETHICS-REVIEW', name: '윤리심의 요청서', description: '윤리강령 및 징계규정 별지 제4호를 반영한 윤리위반 조사결과 심의 요청 서식',
    docType: '기안', category: '인사·보수·위촉·해촉·징계 관련 문서', titlePrefix: '[윤리심의 요청] ',
    fields: [
      { id: 'subject', label: '사안명', type: 'text', required: true, width: 'full' },
      { id: 'requestDate', label: '요청일자', type: 'date', required: true, width: 'half' },
      { id: 'requester', label: '요청자', type: 'text', required: true, width: 'half' },
      { id: 'subjectPerson', label: '조사대상자', type: 'text', required: true, width: 'half' },
      { id: 'violation', label: '주요 위반내용', type: 'textarea', required: true, width: 'full' },
      { id: 'rules', label: '관련 규정', type: 'textarea', required: true, width: 'full' },
      { id: 'damage', label: '피해내용', type: 'textarea', required: false, width: 'full' },
      { id: 'investigationSummary', label: '조사결과 요약', type: 'textarea', required: true, width: 'full' },
      { id: 'hearing', label: '소명기회 부여 여부', type: 'select', required: true, options: ['부여', '미부여', '해당 없음'], width: 'half' },
      { id: 'temporaryAction', label: '임시조치 여부', type: 'select', required: true, options: ['있음', '없음'], width: 'half' },
      { id: 'disciplineOpinion', label: '징계의견', type: 'textarea', required: true, width: 'full' },
      { id: 'protectionOpinion', label: '보호조치 의견', type: 'textarea', required: false, width: 'full' },
      { id: 'preventionOpinion', label: '재발방지 의견', type: 'textarea', required: false, width: 'full' },
      { id: 'attachments', label: '첨부자료', type: 'textarea', required: true, width: 'full' },
    ],
    bodyTemplate: '1. 사안명: {{subject}}\n2. 요청일자 / 요청자: {{requestDate}} / {{requester}}\n3. 조사대상자: {{subjectPerson}}\n4. 주요 위반내용\n{{violation}}\n\n5. 관련 규정\n{{rules}}\n\n6. 피해내용\n{{damage}}\n\n7. 조사결과 요약\n{{investigationSummary}}\n\n8. 소명기회 부여 여부: {{hearing}}\n9. 임시조치 여부: {{temporaryAction}}\n10. 징계의견\n{{disciplineOpinion}}\n\n11. 보호조치 의견\n{{protectionOpinion}}\n\n12. 재발방지 의견\n{{preventionOpinion}}\n\n13. 첨부자료\n{{attachments}}',
  },
  {
    id: 'TPL-DISCIPLINE-REVIEW', name: '징계심의서', description: '윤리강령 및 징계규정 별지 제5호를 반영한 징계양정·가중·감경 심의 서식',
    docType: '기안', category: '인사·보수·위촉·해촉·징계 관련 문서', titlePrefix: '[징계심의] ',
    fields: [
      { id: 'subject', label: '조사대상자', type: 'text', required: true, width: 'full' },
      { id: 'reviewDate', label: '심의일자', type: 'date', required: true, width: 'half' },
      { id: 'affiliation', label: '소속 또는 직분', type: 'text', required: true, width: 'half' },
      { id: 'violation', label: '위반행위', type: 'textarea', required: true, width: 'full' },
      { id: 'rules', label: '관련 규정', type: 'textarea', required: true, width: 'full' },
      { id: 'damage', label: '피해내용', type: 'textarea', required: false, width: 'full' },
      { id: 'intent', label: '고의성', type: 'select', required: true, options: ['있음', '없음', '확인 곤란'], width: 'half' },
      { id: 'severity', label: '중대성', type: 'select', required: true, options: ['중대', '보통', '경미'], width: 'half' },
      { id: 'repetition', label: '반복성', type: 'select', required: true, options: ['있음', '없음'], width: 'half' },
      { id: 'recovery', label: '피해회복 여부', type: 'select', required: true, options: ['완료', '일부', '미완료', '해당 없음'], width: 'half' },
      { id: 'statement', label: '소명내용', type: 'textarea', required: true, width: 'full' },
      { id: 'aggravating', label: '가중사유', type: 'textarea', required: false, width: 'full' },
      { id: 'mitigating', label: '감경사유', type: 'textarea', required: false, width: 'full' },
      { id: 'opinion', label: '심의의견', type: 'textarea', required: true, width: 'full' },
      { id: 'discipline', label: '징계안', type: 'select', required: true, options: ['주의', '경고', '시정명령', '교육명령', '활동제한', '직무정지', '해촉', '자격정지', '제명', '손해배상', '관계기관 신고', '수료취소', '인증취소', '위촉취소', '자료반환', '기타'], width: 'half' },
    ],
    bodyTemplate: '1. 조사대상자: {{subject}}\n2. 심의일자 / 소속·직분: {{reviewDate}} / {{affiliation}}\n3. 위반행위\n{{violation}}\n\n4. 관련 규정\n{{rules}}\n\n5. 피해내용\n{{damage}}\n\n6. 고의성 / 중대성 / 반복성: {{intent}} / {{severity}} / {{repetition}}\n7. 피해회복 여부: {{recovery}}\n8. 소명내용\n{{statement}}\n\n9. 가중사유\n{{aggravating}}\n\n10. 감경사유\n{{mitigating}}\n\n11. 심의의견\n{{opinion}}\n\n12. 징계안: {{discipline}}',
  },
] as const;

let tablesEnsured = false;
let tablesEnsurePromise: Promise<void> | null = null;
let lastRateLimitCleanupAt = 0;
const MAINTENANCE_COOLDOWN_MS = 10 * 60 * 1000;
const SCHEMA_VERSION = '2026-08-15.17';

type TableColumnInfo = { name: string; type: string; notnull: number; dflt_value?: unknown; pk: number };

const getTableColumns = async (db: D1Database, table: string) => {
  const rows = await db.prepare(`PRAGMA table_info(${table})`).all<TableColumnInfo>();
  return rows.results ?? [];
};

const ensureColumn = async (db: D1Database, table: string, columnDef: string) => {
  try {
    await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`).run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // 기존 컬럼이 이미 있는 경우만 정상으로 간주합니다. 다른 마이그레이션 오류는 숨기지 않습니다.
    if (!/duplicate column name|already exists/i.test(message)) throw error;
  }
};

export const isSchemaError = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  return /no such table|no such column|has no column named|table .* has .* columns|datatype mismatch|schema/i.test(message);
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
      can_approve INTEGER NOT NULL DEFAULT 0, can_accounting INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
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
    db.prepare(`CREATE TABLE IF NOT EXISTS document_dispatch_links (
      document_id TEXT PRIMARY KEY, registry_id TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
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
    db.prepare(`CREATE TABLE IF NOT EXISTS management_registers (
      id TEXT PRIMARY KEY, request_no TEXT NOT NULL UNIQUE, record_type TEXT NOT NULL, title TEXT NOT NULL,
      content_json TEXT NOT NULL DEFAULT '{}', applicant_user_id TEXT NOT NULL, applicant_name TEXT NOT NULL,
      applicant_department TEXT, status TEXT NOT NULL DEFAULT '신청', request_date TEXT NOT NULL,
      processed_by TEXT, processed_by_user_id TEXT, processed_at TEXT, processing_memo TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS management_register_attachments (
      id TEXT PRIMARY KEY, register_id TEXT NOT NULL, file_name TEXT NOT NULL,
      mime_type TEXT NOT NULL DEFAULT 'application/octet-stream', size_bytes INTEGER NOT NULL DEFAULT 0,
      data_base64 TEXT NOT NULL DEFAULT '', storage_type TEXT NOT NULL DEFAULT 'd1', r2_key TEXT, created_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS employee_profiles (
      user_id TEXT PRIMARY KEY, name_hanja TEXT, birth_or_registration TEXT, address TEXT,
      employment_start_date TEXT, contact TEXT, updated_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS employment_certificates (
      id TEXT PRIMARY KEY, certificate_no TEXT NOT NULL UNIQUE, employee_user_id TEXT NOT NULL,
      employee_name_ko TEXT NOT NULL, employee_name_hanja TEXT, birth_or_registration TEXT NOT NULL,
      address TEXT NOT NULL, department TEXT NOT NULL, position_grade TEXT NOT NULL,
      employment_start_date TEXT NOT NULL, employment_end_date TEXT, purpose TEXT NOT NULL,
      issue_date TEXT NOT NULL, issuer_user_id TEXT NOT NULL, issuer_name TEXT NOT NULL,
      signatory_title TEXT NOT NULL DEFAULT '이사장', signatory_user_id TEXT,
      signatory_name TEXT NOT NULL DEFAULT '김양휘',
      include_logo_sq_seal INTEGER NOT NULL DEFAULT 0,
      manager_name TEXT, contact TEXT, status TEXT NOT NULL DEFAULT '발급', canceled_at TEXT,
      canceled_by_user_id TEXT, canceled_by_name TEXT, cancel_reason TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS ordination_certificates (
      id TEXT PRIMARY KEY, certificate_no TEXT NOT NULL UNIQUE, request_id TEXT,
      issue_year INTEGER NOT NULL, sequence_no INTEGER NOT NULL,
      recipient_name TEXT NOT NULL, birth_calendar TEXT NOT NULL, birth_date TEXT NOT NULL,
      dharma_name_hanja TEXT NOT NULL, dharma_name_korean TEXT NOT NULL,
      ordination_date TEXT NOT NULL, buddhist_year INTEGER NOT NULL,
      teacher_name TEXT NOT NULL, preceptor_name TEXT NOT NULL, witness_name TEXT NOT NULL,
      organization_name TEXT NOT NULL, temple_name TEXT NOT NULL, issuer_name TEXT NOT NULL,
      closing_text TEXT NOT NULL DEFAULT '合掌', include_top_seal INTEGER NOT NULL DEFAULT 1,
      top_seal_key TEXT NOT NULL DEFAULT 'hyangcheonsa', note TEXT NOT NULL DEFAULT '',
      template_version TEXT NOT NULL DEFAULT 'ordination-v2', certificate_snapshot TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT '발급', issued_by_user_id TEXT NOT NULL, issued_by_name TEXT NOT NULL,
      issued_at TEXT NOT NULL, canceled_at TEXT, canceled_by_user_id TEXT, canceled_by_name TEXT,
      cancel_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(issue_year, sequence_no)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS management_audit_logs (
      id TEXT PRIMARY KEY, category TEXT NOT NULL, action TEXT NOT NULL, target_id TEXT NOT NULL,
      actor_user_id TEXT NOT NULL, actor_name TEXT NOT NULL, details_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
    )`),
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
    ['system_users', 'position TEXT'], ['system_users', 'grade TEXT'], ['system_users', 'department TEXT'],
    ['system_users', `role TEXT NOT NULL DEFAULT 'user'`],
    ['system_users', 'can_approve INTEGER NOT NULL DEFAULT 0'],
    ['system_users', 'can_accounting INTEGER NOT NULL DEFAULT 0'],
    ['system_users', 'active INTEGER NOT NULL DEFAULT 1'],
    ['system_users', 'created_at TEXT'],
    ['received_documents', 'department TEXT'], ['received_documents', 'related_document_id TEXT'],
    ['received_documents', 'handled_by_user_id TEXT'], ['received_documents', 'updated_at TEXT'],
    ['document_attachments', `storage_type TEXT NOT NULL DEFAULT 'd1'`], ['document_attachments', 'r2_key TEXT'],
    ['received_attachments', `storage_type TEXT NOT NULL DEFAULT 'd1'`], ['received_attachments', 'r2_key TEXT'],
    ['employment_certificates', `signatory_title TEXT NOT NULL DEFAULT '이사장'`],
    ['employment_certificates', 'signatory_user_id TEXT'],
    ['employment_certificates', `signatory_name TEXT NOT NULL DEFAULT '김양휘'`],
    ['employment_certificates', 'include_logo_sq_seal INTEGER NOT NULL DEFAULT 0'],
    ['ordination_certificates', 'request_id TEXT'],
    ['ordination_certificates', 'include_top_seal INTEGER NOT NULL DEFAULT 1'],
    ['ordination_certificates', `top_seal_key TEXT NOT NULL DEFAULT 'hyangcheonsa'`],
  ];
  // 이미 존재하는 컬럼마다 ALTER TABLE 오류를 발생시키면 D1 요청 수와 실행시간이 크게 늘어납니다.
  // 테이블별 컬럼 목록을 한 번만 조회하고, 실제로 누락된 컬럼만 순차 추가합니다.
  const knownColumnsByTable = new Map<string, Set<string>>();
  for (const [table, columnDef] of columns) {
    let knownColumns = knownColumnsByTable.get(table);
    if (!knownColumns) {
      knownColumns = new Set((await getTableColumns(db, table)).map((column) => column.name));
      knownColumnsByTable.set(table, knownColumns);
    }
    const columnName = columnDef.trim().split(/\s+/, 1)[0];
    if (knownColumns.has(columnName)) continue;
    await ensureColumn(db, table, columnDef);
    knownColumns.add(columnName);
  }

  const now = new Date().toISOString();
  await db.prepare(`
    UPDATE system_users
    SET role = COALESCE(NULLIF(role, ''), 'user'),
        can_approve = COALESCE(can_approve, 0),
        can_accounting = CASE WHEN role = 'admin' THEN 1 ELSE COALESCE(can_accounting, 0) END,
        active = COALESCE(active, 1),
        created_at = COALESCE(created_at, ?)
    WHERE role IS NULL OR role = '' OR can_approve IS NULL OR can_accounting IS NULL OR active IS NULL OR created_at IS NULL
       OR (role = 'admin' AND can_accounting <> 1)
  `).bind(now).run();
  await db.prepare(`UPDATE received_documents SET updated_at = COALESCE(updated_at, created_at, ?) WHERE updated_at IS NULL`)
    .bind(now).run();


  // v70 직제 개편: 과거 담당부서 명칭을 현행 `사무처(국)` 체계의 저장값으로 정규화합니다.
  // 사무국 산하의 과거 통합부서인 대외협력·사회공헌은 기존 계정의 직책이 사회공헌 계열이면 사회공헌국,
  // 그 외에는 국제교류국으로 이관합니다. 문서·대장 등 직책 정보가 없는 과거 자료는 국제교류국으로 보정합니다.
  const normalizeDepartmentSql = (column: string, positionColumn = '') => `
    UPDATE __TABLE__
    SET ${column} = CASE
      WHEN ${column} IS NULL OR TRIM(${column}) = '' THEN ${column}
      WHEN TRIM(${column}) IN ('사무국','사무처') THEN '사무처'
      WHEN TRIM(${column}) IN ('재정국','준법윤리국','국제교류국','문화홍보국','사회공헌국') THEN '사무처 - ' || TRIM(${column})
      WHEN TRIM(${column}) IN ('재정·회계','사무국 - 재정·회계','사무처 - 재정·회계','사무국(재정·회계)','사무처(재정·회계)') THEN '사무처 - 재정국'
      WHEN TRIM(${column}) IN ('준법·윤리','사무국 - 준법·윤리','사무처 - 준법·윤리','사무국(준법·윤리)','사무처(준법·윤리)') THEN '사무처 - 준법윤리국'
      WHEN TRIM(${column}) IN ('문화·홍보','사무국 - 문화·홍보','사무처 - 문화·홍보','사무국(문화·홍보)','사무처(문화·홍보)') THEN '사무처 - 문화홍보국'
      WHEN TRIM(${column}) IN ('대외협력·사회공헌','사무국 - 대외협력·사회공헌','사무처 - 대외협력·사회공헌','사무국(대외협력·사회공헌)','사무처(대외협력·사회공헌)') THEN ${positionColumn ? `CASE WHEN COALESCE(${positionColumn}, '') LIKE '%사회공헌%' THEN '사무처 - 사회공헌국' ELSE '사무처 - 국제교류국' END` : "'사무처 - 국제교류국'"}
      ELSE REPLACE(${column}, '사무국', '사무처')
    END
    WHERE ${column} LIKE '%사무국%' OR ${column} IN ('재정·회계','준법·윤리','대외협력·사회공헌','문화·홍보','재정국','준법윤리국','국제교류국','문화홍보국','사회공헌국')
  `;
  const departmentUpdates = [
    normalizeDepartmentSql('department', 'position').replace('__TABLE__', 'system_users'),
    normalizeDepartmentSql('department').replace('__TABLE__', 'documents'),
    normalizeDepartmentSql('department').replace('__TABLE__', 'received_documents'),
    normalizeDepartmentSql('applicant_department').replace('__TABLE__', 'management_registers'),
    normalizeDepartmentSql('department').replace('__TABLE__', 'employment_certificates'),
  ];
  for (const statement of departmentUpdates) await db.prepare(statement).run();
  await db.prepare(`
    INSERT OR IGNORE INTO document_dispatch_links (document_id, registry_id, created_at)
    SELECT related_document_id, id, COALESCE(created_at, ?)
    FROM received_documents
    WHERE direction = '외부발송' AND related_document_id IS NOT NULL AND related_document_id <> ''
    ORDER BY created_at ASC
  `).bind(now).run();

  // 과거 중복 클릭 등으로 client_request_id가 중복 저장된 경우에는 최초 문서만 유지합니다.
  // 이 정리 없이 고유 인덱스를 만들면 전체 스키마 보완이 실패해 계정 생성 등 무관한 기능까지 막힐 수 있습니다.
  await db.prepare(`
    UPDATE documents
    SET client_request_id = NULL
    WHERE client_request_id IS NOT NULL
      AND rowid NOT IN (
        SELECT MIN(rowid) FROM documents
        WHERE client_request_id IS NOT NULL
        GROUP BY client_request_id
      )
  `).run();

  // 3단계: 새 컬럼이 준비된 후에만 해당 컬럼을 사용하는 인덱스를 만듭니다.
  await db.batch([
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_documents_status ON documents (status)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_documents_created ON documents (created_at)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_documents_updated ON documents (updated_at DESC)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_documents_title ON documents (title)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_documents_status_created ON documents (status, created_at DESC)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_documents_type_status_created ON documents (doc_type, status, created_at DESC)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_document_approvals_doc ON document_approvals (document_id, created_at)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_document_approval_lines_doc ON document_approval_lines (document_id, line_order)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_document_approval_lines_pending ON document_approval_lines (user_id, status, document_id)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_document_approval_lines_doc_status_order ON document_approval_lines (document_id, status, line_order)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_received_documents_created ON received_documents (created_at)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_received_documents_date ON received_documents (received_at DESC, created_at DESC)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_received_documents_direction_date ON received_documents (direction, received_at DESC, created_at DESC)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_received_documents_handler ON received_documents (handled_by_user_id, created_at)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_received_documents_related ON received_documents (related_document_id, direction)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_dispatch_links_registry ON document_dispatch_links (registry_id)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_document_attachments_doc ON document_attachments (document_id, created_at)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_received_attachments_doc ON received_attachments (received_document_id, created_at)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_system_sessions_user ON system_sessions (user_id)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_admin_rate_limits_key_created ON admin_rate_limits (rate_key, created_at)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_documents_approver ON documents (approver_user_id, status)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_documents_reviewer ON documents (reviewer_user_id, status)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_documents_drafter ON documents (drafter_user_id, status)`),
    db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_request_id ON documents (client_request_id) WHERE client_request_id IS NOT NULL`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_management_registers_type_date ON management_registers(record_type, request_date DESC, created_at DESC)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_management_registers_applicant ON management_registers(applicant_user_id, created_at DESC)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_management_registers_status ON management_registers(status, created_at DESC)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_management_register_attachments_record ON management_register_attachments(register_id, created_at)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_employment_certificates_employee ON employment_certificates(employee_user_id, issue_date DESC)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_employment_certificates_status ON employment_certificates(status, issue_date DESC)`),
    db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_ordination_certificates_request ON ordination_certificates(request_id) WHERE request_id IS NOT NULL`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_ordination_certificates_date ON ordination_certificates(ordination_date DESC, created_at DESC)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_ordination_certificates_recipient ON ordination_certificates(recipient_name, ordination_date DESC)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_ordination_certificates_dharma ON ordination_certificates(dharma_name_korean, dharma_name_hanja, ordination_date DESC)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_ordination_certificates_status ON ordination_certificates(status, ordination_date DESC)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_management_audit_target ON management_audit_logs(category, target_id, created_at)`),
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
    // 스키마 버전은 전체 마이그레이션이 성공한 마지막 단계에서만 기록됩니다.
    // 매 Worker 기동마다 여러 PRAGMA를 재실행하면 모든 화면의 첫 조회가 지연되므로
    // 정상 운영 요청은 버전 표식 한 건만 확인하고, 불일치 시에만 전체 복구를 수행합니다.
    return row?.meta_value === SCHEMA_VERSION;
  } catch {
    return false;
  }
};

export const repairTables = async (db: D1Database) => {
  tablesEnsured = false;
  tablesEnsurePromise = null;
  await runSchemaMigration(db);
  tablesEnsured = true;
};

export const ensureTables = async (db: D1Database) => {
  if (tablesEnsured) return;
  if (!tablesEnsurePromise) {
    tablesEnsurePromise = (async () => {
      // 대부분의 요청에서는 버전 및 핵심 컬럼만 1회 확인합니다.
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

export type NewSystemUser = {
  name: string;
  username: string;
  passwordHash: string;
  position?: string | null;
  grade?: string | null;
  department?: string | null;
  role: 'admin' | 'audit' | 'user';
  canApprove: boolean;
  canAccounting: boolean;
  active?: boolean;
  createdAt?: string;
};

// 운영 DB가 TEXT 또는 INTEGER 식별자를 사용하더라도 실제 스키마에 맞춰 계정을 삽입합니다.
// D1의 INSERT ... RETURNING 지원 여부에 의존하지 않고, 삽입 후 아이디를 다시 조회합니다.
export const insertSystemUser = async (db: D1Database, input: NewSystemUser) => {
  const columns = await getTableColumns(db, 'system_users');
  const idColumn = columns.find((column) => column.name === 'id');
  if (!idColumn) throw new Error('system_users.id column is missing');

  const knownColumns = new Set(columns.map((column) => column.name));
  for (const required of ['name', 'username', 'password_hash']) {
    if (!knownColumns.has(required)) throw new Error(`system_users.${required} column is missing`);
  }

  const sample = await db.prepare(`SELECT typeof(id) AS storage_type FROM system_users WHERE id IS NOT NULL LIMIT 1`)
    .first<{ storage_type: string }>();
  const usesIntegerId = /INT/i.test(idColumn.type || '') || sample?.storage_type === 'integer';
  // SQLite에서 행번호 자동 부여가 보장되는 형식은 정확히 INTEGER PRIMARY KEY인 경우뿐입니다.
  // BIGINT/INT PRIMARY KEY 등을 자동증가로 오인하면 NULL 식별자가 삽입될 수 있으므로 직접 번호를 생성합니다.
  const autoIntegerId = /^INTEGER$/i.test((idColumn.type || '').trim()) && Number(idColumn.pk) > 0;

  const now = input.createdAt || new Date().toISOString();
  const valueMap: Record<string, unknown> = {
    name: input.name,
    username: input.username,
    password_hash: input.passwordHash,
    position: input.position || null,
    grade: input.grade || null,
    department: input.department || null,
    role: input.role,
    can_approve: input.canApprove ? 1 : 0,
    can_accounting: input.canAccounting ? 1 : 0,
    active: input.active === false ? 0 : 1,
    created_at: now,
    updated_at: now,
    is_admin: input.role === 'admin' ? 1 : 0,
    is_active: input.active === false ? 0 : 1,
    approval_enabled: input.canApprove ? 1 : 0,
  };

  let generatedId: string | number | null = null;
  if (!autoIntegerId) {
    if (usesIntegerId) {
      const row = await db.prepare(`SELECT COALESCE(MAX(CAST(id AS INTEGER)), 0) + 1 AS next_id FROM system_users`)
        .first<{ next_id: number }>();
      generatedId = Number(row?.next_id || 1);
    } else {
      generatedId = `USR-${randomHex(20)}`;
    }
    valueMap.id = generatedId;
  }

  const preferredColumns = [
    'id', 'name', 'username', 'password_hash', 'position', 'grade', 'department', 'role',
    'can_approve', 'can_accounting', 'active', 'created_at', 'updated_at', 'is_admin', 'is_active', 'approval_enabled',
  ];
  const insertColumns = preferredColumns
    .filter((column) => knownColumns.has(column) && !(column === 'id' && autoIntegerId));

  // 운영 DB에 과거 버전에서 추가된 NOT NULL 보조 컬럼이 있어도 계정 생성을 중단하지 않습니다.
  // 기본값이 없는 필수 컬럼은 이름과 자료형에 맞는 안전한 초기값을 함께 삽입합니다.
  const requiredLegacyColumns = columns.filter((column) =>
    !insertColumns.includes(column.name)
    && column.name !== 'id'
    && Number(column.pk) === 0
    && Number(column.notnull) === 1
    && (column.dflt_value === null || column.dflt_value === undefined),
  );
  for (const column of requiredLegacyColumns) {
    const name = column.name.toLowerCase();
    const type = (column.type || '').toUpperCase();
    let value: unknown;
    if (name.includes('created_at') || name.includes('updated_at') || name.includes('date') || name.includes('time')) value = now;
    else if (name.includes('created_by') || name.includes('updated_by') || name.includes('login_id')) value = input.username;
    else if (name.includes('email')) value = '';
    else if (/INT|REAL|NUM|DEC|DOUBLE|FLOAT|BOOL/.test(type)) value = 0;
    else if (/BLOB/.test(type)) value = new Uint8Array(0);
    else value = '';
    valueMap[column.name] = value;
    insertColumns.push(column.name);
  }
  const placeholders = insertColumns.map(() => '?').join(', ');
  const values = insertColumns.map((column) => valueMap[column]);
  await db.prepare(`INSERT INTO system_users (${insertColumns.join(', ')}) VALUES (${placeholders})`)
    .bind(...values).run();

  if (generatedId !== null) return String(generatedId);
  const inserted = await db.prepare(`SELECT CAST(id AS TEXT) AS id FROM system_users WHERE username = ? COLLATE NOCASE LIMIT 1`)
    .bind(input.username).first<{ id: string | number }>();
  if (!inserted?.id) throw new Error('계정 식별번호를 생성하지 못했습니다.');
  return String(inserted.id);
};

export type SessionUser = {
  id: string; name: string; username: string; position: string | null; grade: string | null;
  department: string | null; role: string; can_approve: number; can_accounting: number;
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
    SELECT CAST(u.id AS TEXT) AS id, u.name, u.username, u.position, u.grade, u.department, u.role, u.can_approve, u.can_accounting, u.active, s.expires_at
    FROM system_sessions s JOIN system_users u ON u.id = s.user_id WHERE s.token = ?
  `).bind(token).first<SessionUser & { active: number; expires_at: string }>();
  if (!row) return { ok: false, message: '로그인이 만료되었습니다. 다시 로그인해 주세요.', status: 401 };
  if (!row.active) return { ok: false, message: '비활성화된 계정입니다. 관리자에게 문의해 주세요.', status: 403 };
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await destroySession(db, token);
    return { ok: false, message: '로그인이 만료되었습니다. 다시 로그인해 주세요.', status: 401 };
  }
  const { id, name, username, position, grade, department, role, can_approve, can_accounting } = row;
  return { ok: true, user: { id, name, username, position, grade, department, role, can_approve, can_accounting } };
};

export const canReadDocument = (user: SessionUser, document: Record<string, unknown>) => {
  if (user.role === 'admin' || user.role === 'audit') return true;
  // 임시저장 문서는 열람범위와 관계없이 작성자만 볼 수 있어야 합니다.
  if (document.status === '임시저장') return String(document.drafter_user_id || '') === user.id;
  if (document.access_scope !== '관련자') return true;
  return [document.drafter_user_id, document.reviewer_user_id, document.approver_user_id].some((id) => String(id || '') === user.id);
};

const nextSequence = async (db: D1Database, seqKey: string, existingMax = 0) => {
  // 실제 자료와 순번 테이블 중 큰 값을 기준으로 원자적으로 증가시킵니다.
  // 전체 테스트자료 초기화는 document_sequences도 함께 비우므로 여기서 기존 순번을 되돌리지 않습니다.
  // 동시에 여러 문서를 등록해도 이미 증가한 순번을 0으로 되돌리지 않아 중복 번호가 생기지 않습니다.
  await db.prepare(`
    INSERT INTO document_sequences (seq_key, last_seq) VALUES (?, ?)
    ON CONFLICT(seq_key) DO UPDATE SET last_seq = MAX(document_sequences.last_seq, excluded.last_seq)
  `).bind(seqKey, existingMax).run();
  const row = await db.prepare(`UPDATE document_sequences SET last_seq = last_seq + 1 WHERE seq_key = ? RETURNING last_seq`)
    .bind(seqKey).first<{ last_seq: number }>();
  return Number(row?.last_seq || existingMax + 1);
};

const documentNumberState = async (db: D1Database, now: Date) => {
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const year = kst.getUTCFullYear();
  const prefix = `밀교종-${year}-`;
  const existing = await db.prepare(`
    SELECT MAX(sequence_no) AS max_seq FROM (
      SELECT CAST(substr(id, ?) AS INTEGER) AS sequence_no
      FROM documents WHERE id LIKE ?
      UNION ALL
      SELECT CAST(substr(related_document_id, ?) AS INTEGER) AS sequence_no
      FROM received_documents
      WHERE direction = '접수' AND related_document_id LIKE ?
    )
  `).bind(prefix.length + 1, `${prefix}%`, prefix.length + 1, `${prefix}%`).first<{ max_seq: number | null }>();
  const existingMax = Number(existing?.max_seq || 0);
  return { year, prefix, existingMax };
};
export const previewNextDocumentNumber = async (db: D1Database, now: Date) => {
  const { year, prefix, existingMax } = await documentNumberState(db, now);
  const sequenceRow = await db.prepare(`SELECT last_seq FROM document_sequences WHERE seq_key = ?`)
    .bind(`DOC:${year}`).first<{ last_seq: number | null }>();
  const sequenceMax = Math.max(existingMax, Number(sequenceRow?.last_seq || 0));
  return `${prefix}${String(sequenceMax + 1).padStart(3, '0')}`;
};
export const makeDocumentNumber = async (db: D1Database, now: Date) => {
  const { year, prefix, existingMax } = await documentNumberState(db, now);
  const seq = await nextSequence(db, `DOC:${year}`, existingMax);
  return `${prefix}${String(seq).padStart(3, '0')}`;
};
export const makeReceivedNumber = async (db: D1Database, now: Date, direction: string) => {
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const year = kst.getUTCFullYear();
  const prefix = direction === '접수' ? `접수-${year}-` : `외부발송-${year}-`;
  const existing = await db.prepare(`SELECT MAX(CAST(substr(id, ?) AS INTEGER)) AS max_seq FROM received_documents WHERE id LIKE ?`)
    .bind(prefix.length + 1, `${prefix}%`).first<{ max_seq: number | null }>();
  const existingMax = Number(existing?.max_seq || 0);
  const seq = await nextSequence(db, `${direction}:${year}`, existingMax);
  return `${prefix}${String(seq).padStart(3, '0')}`;
};
