-- V106: Monk identity-card ledger. Additive migration; existing records are not rewritten.
-- Card issue numbers are distinct from monastic registry numbers.
-- Preserve sequence/reservation tables: issued or reserved numbers must not be recycled.
CREATE TABLE IF NOT EXISTS monk_card_sequences (
  issue_year INTEGER PRIMARY KEY CHECK(issue_year BETWEEN 1900 AND 9999),
  last_seq INTEGER NOT NULL DEFAULT 0 CHECK(last_seq>=0)
);
CREATE TABLE IF NOT EXISTS monk_card_numbers (
  card_no TEXT PRIMARY KEY,
  issue_year INTEGER NOT NULL,
  serial_no INTEGER NOT NULL CHECK(serial_no>0),
  reserved_at TEXT NOT NULL,
  UNIQUE(issue_year,serial_no)
);
CREATE TABLE IF NOT EXISTS monk_cards (
  id TEXT PRIMARY KEY,
  card_no TEXT NOT NULL UNIQUE REFERENCES monk_card_numbers(card_no) ON DELETE RESTRICT,
  monastic_no TEXT NOT NULL,
  registry_id TEXT NOT NULL REFERENCES monastic_registry(id) ON DELETE RESTRICT,
  issue_kind TEXT NOT NULL CHECK(issue_kind IN ('신규','재발급','갱신')),
  ordination_round TEXT NOT NULL CHECK(length(ordination_round)=2),
  issue_date TEXT NOT NULL,
  valid_until TEXT NOT NULL,
  application_date TEXT NOT NULL,
  receipt_date TEXT NOT NULL,
  supplement_days INTEGER NOT NULL DEFAULT 0 CHECK(supplement_days>=0),
  dharma_name_ko TEXT NOT NULL,
  dharma_name_hanja TEXT NOT NULL DEFAULT '',
  dharma_rank TEXT NOT NULL,
  temple TEXT NOT NULL,
  birth_date TEXT NOT NULL,
  ordination_date TEXT NOT NULL,
  previous_id TEXT REFERENCES monk_cards(id) ON DELETE RESTRICT,
  issue_reason TEXT NOT NULL DEFAULT '',
  previous_handling TEXT NOT NULL DEFAULT '',
  general_consent TEXT NOT NULL CHECK(general_consent='동의'),
  sensitive_consent TEXT NOT NULL CHECK(sensitive_consent='동의'),
  abbot_confirmation TEXT NOT NULL,
  documents_confirmed INTEGER NOT NULL CHECK(documents_confirmed=1),
  eligibility_confirmed INTEGER NOT NULL CHECK(eligibility_confirmed=1),
  linked_document_id TEXT NOT NULL DEFAULT '',
  internal_document_no TEXT NOT NULL DEFAULT '',
  received_date TEXT NOT NULL DEFAULT '',
  receipt_confirmation TEXT NOT NULL DEFAULT '',
  registered_mail_no TEXT NOT NULL DEFAULT '',
  invalid_date TEXT NOT NULL DEFAULT '',
  invalid_reason TEXT NOT NULL DEFAULT '',
  return_date TEXT NOT NULL DEFAULT '',
  return_reason TEXT NOT NULL DEFAULT '',
  destroyed_date TEXT NOT NULL DEFAULT '',
  destruction_method TEXT NOT NULL DEFAULT '',
  remarks TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  last_operation TEXT NOT NULL DEFAULT '',
  request_id TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL,
  created_by_name TEXT NOT NULL,
  updated_by_user_id TEXT NOT NULL,
  updated_by_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(request_id,created_by_user_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_monk_card_first ON monk_cards(registry_id) WHERE issue_kind='신규';
CREATE UNIQUE INDEX IF NOT EXISTS idx_monk_card_replacement ON monk_cards(previous_id) WHERE previous_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_monk_cards_registry ON monk_cards(registry_id,issue_date DESC);
CREATE INDEX IF NOT EXISTS idx_monk_cards_validity ON monk_cards(invalid_date,valid_until);
CREATE INDEX IF NOT EXISTS idx_monk_cards_document ON monk_cards(linked_document_id);
CREATE TABLE IF NOT EXISTS monk_card_changes (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES monk_cards(id) ON DELETE RESTRICT,
  action TEXT NOT NULL,
  reason TEXT NOT NULL,
  before_json TEXT NOT NULL DEFAULT '{}',
  after_json TEXT NOT NULL DEFAULT '{}',
  actor_user_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_monk_card_changes_card ON monk_card_changes(card_id,created_at);
CREATE TABLE IF NOT EXISTS monk_card_attachments (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES monk_cards(id) ON DELETE RESTRICT,
  file_name TEXT NOT NULL,
  file_kind TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK(size_bytes>0 AND size_bytes<=4194304),
  r2_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','deleting')),
  created_by_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_monk_card_attachments_card ON monk_card_attachments(card_id,created_at);
-- Keep number, holder and original validity period immutable; corrections never recycle a card.
CREATE TRIGGER IF NOT EXISTS trg_monk_card_identity_immutable
BEFORE UPDATE OF card_no,monastic_no,registry_id,issue_date,valid_until,ordination_round,previous_id ON monk_cards
WHEN NEW.monastic_no<>OLD.monastic_no OR NEW.card_no<>OLD.card_no OR NEW.registry_id<>OLD.registry_id OR NEW.issue_date<>OLD.issue_date
 OR NEW.valid_until<>OLD.valid_until OR NEW.ordination_round<>OLD.ordination_round
 OR COALESCE(NEW.previous_id,'')<>COALESCE(OLD.previous_id,'')
BEGIN SELECT RAISE(ABORT,'MONK_CARD_IDENTITY_IMMUTABLE'); END;
-- A registry status loss is irreversible for an already issued card, even if membership is restored later.
CREATE TRIGGER IF NOT EXISTS trg_monk_cards_registry_status
AFTER UPDATE OF status ON monastic_registry
WHEN OLD.status='재적' AND NEW.status<>'재적'
BEGIN
 INSERT INTO monk_card_changes(id,card_id,action,reason,before_json,after_json,actor_user_id,actor_name,created_at)
 SELECT lower(hex(randomblob(16))),id,'무효','승적 상태 변경',
 json_object('invalid_date',invalid_date),json_object('invalid_date',date('now','+9 hours'),'invalid_reason','승적 상태 변경'),
 NEW.updated_by_user_id,'시스템',strftime('%Y-%m-%dT%H:%M:%fZ','now')
 FROM monk_cards WHERE registry_id=NEW.id AND invalid_date='';
 UPDATE monk_cards SET invalid_date=date('now','+9 hours'),invalid_reason='승적 상태 변경',
 version=version+1,updated_by_user_id=NEW.updated_by_user_id,updated_by_name='시스템',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE registry_id=NEW.id AND invalid_date='';
END;

INSERT OR IGNORE INTO document_templates(id,name,description,doc_type,category,title_prefix,fields_json,body_template,is_system,active,created_by,created_at,updated_at) VALUES('TPL-MONK-CARD-APPLICATION','승려증 발급 신청서','규정 별지 제1호: 신규·갱신·재발급 신청 및 내부결재. 문서는 관련자로 공개 범위를 제한합니다.','기안','일반(경미한 내부보고·단순사무 — 전결대상)','[승려증 발급 신청서] ','[{"id":"receiptNo","label":"접수번호","type":"text","required":false,"width":"half"},{"id":"receiptDate","label":"접수일","type":"date","required":true,"width":"half"},{"id":"applicationType","label":"신청 구분","type":"select","required":true,"width":"half","options":["신규","갱신","재발급"]},{"id":"reissueReason","label":"재발급 사유","type":"select","required":true,"width":"half","options":["해당 없음","분실","훼손","기재사항 변경"]},{"id":"dharmaNameKo","label":"법명(한글)","type":"text","required":true,"width":"half"},{"id":"dharmaNameHanja","label":"법명(한자)","type":"text","required":false,"width":"half"},{"id":"monasticNo","label":"승적번호","type":"text","required":true,"width":"half"},{"id":"dharmaRank","label":"법계","type":"text","required":true,"width":"half"},{"id":"temple","label":"소속사찰","type":"text","required":true,"width":"half"},{"id":"birthDate","label":"생년월일","type":"date","required":true,"width":"half"},{"id":"ordinationDate","label":"수계일","type":"date","required":true,"width":"half"},{"id":"mobile","label":"휴대전화","type":"text","required":false,"width":"half"},{"id":"changes","label":"기재사항 변경 내용 (변경 전 / 후)","type":"textarea","required":false,"width":"full"},{"id":"previousCardNo","label":"종전 승려증 발급번호","type":"text","required":false,"width":"half"},{"id":"previousHandling","label":"종전 승려증 처리","type":"select","required":true,"width":"half","options":["해당 없음","함께 반납","분실 신고함"]},{"id":"photoTakenDate","label":"사진 촬영일","type":"date","required":true,"width":"half"},{"id":"photoCheck","label":"사진 요건 확인 (6개월 이내 / 승복 / 정면 / 3:4 / JPG 600x800 이상)","type":"select","required":true,"width":"full","options":["확인","미확인"]},{"id":"cardPrivacyConsent","label":"일반 개인정보 수집·이용 동의","type":"select","required":true,"width":"half","options":["동의","비동의"]},{"id":"cardSensitiveConsent","label":"민감정보 처리 별도 동의","type":"select","required":true,"width":"half","options":["동의","비동의"]},{"id":"consentReference","label":"별지 제2호 동의서 참조번호·첨부파일명","type":"text","required":true,"width":"full"},{"id":"abbotConfirmation","label":"소속사찰 주지 확인","type":"select","required":true,"width":"half","options":["주지 확인","신청인이 주지","변동 없는 갱신"]},{"id":"abbotName","label":"확인 주지 법명","type":"text","required":false,"width":"half"},{"id":"applicationDate","label":"신청일","type":"date","required":true,"width":"half"},{"id":"applicantName","label":"신청인 법명","type":"text","required":true,"width":"half"},{"id":"attachments","label":"붙임 목록 (사진 / 동의서 / 종전 승려증)","type":"textarea","required":true,"width":"full"},{"id":"officeNote","label":"총무원 처리란 (승적부 대조 / 발급번호 / 교부일 / 담당자)","type":"textarea","required":false,"width":"full"}]','승려증 발급 및 관리 규정 별지 제1호서식에 따른 전자결재 신청입니다.
처리기간: 30일 (서류 보완 기간 제외)

접수번호: {{receiptNo}}
접수일: {{receiptDate}}
신청 구분: {{applicationType}}
재발급 사유: {{reissueReason}}
법명(한글): {{dharmaNameKo}}
법명(한자): {{dharmaNameHanja}}
승적번호: {{monasticNo}}
법계: {{dharmaRank}}
소속사찰: {{temple}}
생년월일: {{birthDate}}
수계일: {{ordinationDate}}
휴대전화: {{mobile}}
기재사항 변경 내용 (변경 전 / 후): {{changes}}
종전 승려증 발급번호: {{previousCardNo}}
종전 승려증 처리: {{previousHandling}}
사진 촬영일: {{photoTakenDate}}
사진 요건 확인 (6개월 이내 / 승복 / 정면 / 3:4 / JPG 600x800 이상): {{photoCheck}}
일반 개인정보 수집·이용 동의: {{cardPrivacyConsent}}
민감정보 처리 별도 동의: {{cardSensitiveConsent}}
별지 제2호 동의서 참조번호·첨부파일명: {{consentReference}}
소속사찰 주지 확인: {{abbotConfirmation}}
확인 주지 법명: {{abbotName}}
신청일: {{applicationDate}}
신청인 법명: {{applicantName}}
붙임 목록 (사진 / 동의서 / 종전 승려증): {{attachments}}
총무원 처리란 (승적부 대조 / 발급번호 / 교부일 / 담당자): {{officeNote}}

위와 같이 승려증 발급을 신청합니다.
대한불교밀교종 총무원장 귀하
※ 신청서 결재는 신청인·주지의 서명 및 개인별 동의서 확인을 대체하지 않습니다.',1,1,'system',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'));

INSERT OR IGNORE INTO document_templates(id,name,description,doc_type,category,title_prefix,fields_json,body_template,is_system,active,created_by,created_at,updated_at) VALUES('TPL-MONK-CARD-CONSENT','개인정보 수집·이용 동의서 (승려증)','별지 제2호: 일반·민감정보 별도 동의 확인 기록.','기안','일반(경미한 내부보고·단순사무 — 전결대상)','[개인정보 수집·이용 동의서 (승려증)] ','[{"id":"dharmaNameKo","label":"법명","type":"text","required":true,"width":"half"},{"id":"consentDate","label":"동의 확인일","type":"date","required":true,"width":"half"},{"id":"cardPrivacyConsent","label":"일반 개인정보 수집·이용","type":"select","required":true,"width":"half","options":["동의","비동의"]},{"id":"cardSensitiveConsent","label":"민감정보 처리","type":"select","required":true,"width":"half","options":["동의","비동의"]},{"id":"contractor","label":"제작 수탁자","type":"text","required":false,"width":"half"},{"id":"entrustmentCheck","label":"처리 위탁 사실 확인","type":"select","required":true,"width":"half","options":["확인함","해당 없음","미확인"]},{"id":"signatureEvidence","label":"서명된 동의서·확인 증빙","type":"text","required":true,"width":"full"}]','승려증 발급 개인정보 수집·이용 동의서 (별지 제2호)
목적: 발급·재발급·갱신, 진위 확인, 발급 이력 관리
일반정보: 법명(한글·한자), 생년월일, 휴대전화번호, 사진
민감정보: 승적번호, 법계, 소속사찰, 수계일
수집하지 않는 정보: 주민등록번호, 주소, 속명
보유기간: 발급관리대장은 승적부와 같은 기간 / 신청서·사진은 효력 종료 후 1년
처리 위탁: 승려증 인쇄·제작, 인쇄 항목과 사진만 제공. 제작 종료 후 파기.
동의를 거부할 수 있으며, 동의하지 않으면 승려증을 발급받을 수 없습니다.
법명: {{dharmaNameKo}}
동의 확인일: {{consentDate}}
일반 개인정보 수집·이용: {{cardPrivacyConsent}}
민감정보 처리: {{cardSensitiveConsent}}
제작 수탁자: {{contractor}}
처리 위탁 사실 확인: {{entrustmentCheck}}
서명된 동의서·확인 증빙: {{signatureEvidence}}

대한불교밀교종 총무원장 귀하',1,1,'system',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
