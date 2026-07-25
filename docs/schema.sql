-- 종단관리시스템(system.milgyo.org) D1 스키마
-- 공식 홈페이지(milgyo-official-site)와 완전히 분리된 전용 데이터베이스에 실행합니다.
-- 근거: 문서관리및사무관리규정 제12조(문서등록) · 제13조(결재) · 제15조(접수) · 제16조(발송)
-- 참고: 이 파일은 "처음 설치할 때" 기준 스키마입니다. 이미 운영 중인 DB는
--      functions/_shared/helpers.ts의 ensureTables()가 앱 실행 시 자동으로
--      새 테이블·새 컬럼을 추가하므로 별도로 이 SQL을 다시 실행하실 필요는 없습니다.

-- 계정(직원) — 로그인, 직책/직급, 결재권자 지정에 사용
CREATE TABLE IF NOT EXISTS system_users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,                     -- 성명
  username TEXT NOT NULL UNIQUE,          -- 로그인 아이디
  password_hash TEXT NOT NULL,            -- "salt:sha256(salt:password)"
  position TEXT,                          -- 직책(예: 사무국장, 재정국장)
  grade TEXT,                             -- 직급(예: 3급)
  department TEXT,                        -- 담당부서(조직도 표시용, 문서작성 담당부서 목록과 동일한 값)
  role TEXT NOT NULL DEFAULT 'user',      -- 'admin' | 'user'
  can_approve INTEGER NOT NULL DEFAULT 0, -- 결재자로 지정 가능 여부(1/0)
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS system_sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,                    -- 문서번호: 밀교종-2026-001
  doc_type TEXT NOT NULL,                 -- '기안' | '발송'  (접수문서는 received_documents로 분리)
  category TEXT NOT NULL,                 -- 제13조③ 중요문서 10개 항목 또는 '일반(전결대상)' — 온나라의 "과제카드명" 역할 겸용
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',       -- 문서요지(보고내용 요약)
  body TEXT NOT NULL DEFAULT '',
  attachments_note TEXT NOT NULL DEFAULT '',
  drafter TEXT NOT NULL,                  -- 기안자 성명(계정 스냅샷)
  drafter_user_id TEXT,
  drafter_position TEXT,
  reviewer_user_id TEXT,                  -- 검토자(지정)
  reviewer_name TEXT,
  reviewer_position TEXT,
  approver_user_id TEXT,                  -- 결재자(지정) — 이 사람만 승인/반려 처리 가능
  approver_name TEXT,
  approver_position TEXT,
  department TEXT,                        -- 담당부서
  recipient TEXT,                         -- 수신(발송문서의 수신처)
  via TEXT,                               -- 경유
  approval_track TEXT NOT NULL,           -- '이사장결재' | '이사회의결' | '전결'
  status TEXT NOT NULL DEFAULT '결재대기', -- 결재대기 | 승인 | 반려 | 발송완료
  sent_method TEXT,                       -- 발송방법(발송완료 처리 시 입력)
  sent_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS document_approvals (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  action TEXT NOT NULL,                   -- '승인' | '반려' | '전결처리' | '발송완료' | '검토'
  approver_name TEXT NOT NULL,
  approver_role TEXT,
  memo TEXT,
  created_at TEXT NOT NULL
);

-- 문서24 등 외부 시스템으로 주고받은 문서를 수기로 등록하는 접수/발송 대장
-- (제15조: 접수문서는 접수일자·발신자·문서명·접수방법·담당부서를 기록)
CREATE TABLE IF NOT EXISTS received_documents (
  id TEXT PRIMARY KEY,                    -- 접수번호: 접수-2026-001
  direction TEXT NOT NULL,                -- '접수' | '외부발송'(문서24로 내보낸 것도 기록하고 싶을 때)
  title TEXT NOT NULL,
  counterparty TEXT NOT NULL,             -- 접수: 발신자 / 외부발송: 수신자
  source_system TEXT,                     -- '문서24' | '우편' | '이메일' | '방문' 등
  external_doc_number TEXT,               -- 상대기관 문서번호(있으면)
  memo TEXT,
  handled_by TEXT NOT NULL,               -- 등록 담당자
  received_at TEXT NOT NULL,              -- 접수/발송 일자
  created_at TEXT NOT NULL
);

-- 문서 첨부파일(소규모 종단 사용량에 맞춰 R2 없이 D1에 base64로 직접 저장합니다. 파일당 4MB 이하 권장)
CREATE TABLE IF NOT EXISTS document_attachments (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  data_base64 TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_documents_status ON documents (status);
CREATE INDEX IF NOT EXISTS idx_documents_created ON documents (created_at);
CREATE INDEX IF NOT EXISTS idx_documents_approver ON documents (approver_user_id, status);
CREATE INDEX IF NOT EXISTS idx_document_approvals_doc ON document_approvals (document_id, created_at);
CREATE INDEX IF NOT EXISTS idx_received_documents_created ON received_documents (created_at);
CREATE INDEX IF NOT EXISTS idx_document_attachments_doc ON document_attachments (document_id, created_at);
CREATE INDEX IF NOT EXISTS idx_system_sessions_user ON system_sessions (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_system_users_username ON system_users (username);

CREATE TABLE IF NOT EXISTS admin_rate_limits (
  id TEXT PRIMARY KEY,
  rate_key TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_rate_limits_key_created
ON admin_rate_limits (rate_key, created_at);

-- 관인(직인)·로고 이미지(공문서 서식에 고정으로 재사용) — 단일 행(id='org')만 사용
CREATE TABLE IF NOT EXISTS org_settings (
  id TEXT PRIMARY KEY,
  seal_image TEXT,
  logo_image TEXT,
  updated_at TEXT NOT NULL
);
