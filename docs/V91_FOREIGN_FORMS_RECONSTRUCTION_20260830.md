# V91 외국인 신청서 기능 복구 기록 (2026-08-30)

## 복구 기준
- 기준 전체본: `milgyo-system-main-full-replacement-v90-1-20260830(1).zip`
- 사용자 제공 원본 서식:
  1. `거주숙소제공확인서(한글-영문).hwpx`
  2. `[별지 제34호서식] 통합신청서 (신고서) APPLICATION FORM (REPORT FORM)(출입국관리법 시행규칙).hwpx`
  3. `[별지 제21호서식] 사증발급인정신청서 APPLICATION FOR CERTIFICATE OF VISA ELIGIBILITY(출입국관리법 시행규칙).hwpx`

## 복구된 기능
- `증명서 발급·대장`을 `증명서·신청서 발급·대장`으로 변경
- `/foreign-applications`에 외국인 신청서·신고서 작성 및 작성대장 추가
- 원본 HWPX 3종을 `public/forms/`에 포함하고 화면에서 다운로드 제공
- 웹 입력, 미리보기, HTML 작성본 다운로드, 인쇄/PDF 저장
- 작성 이력 저장, 재열람, 출력/다운로드 횟수, 취소 상태 보존
- 일반 사용자는 본인 작성 기록, `admin`/`audit`은 전체 기록 조회
- D1 `foreign_application_forms` 테이블 및 인덱스 추가
- 테스트자료 전체삭제 대상에 외국인 신청서 이력 포함
- CSV 내보내기에서 수식 삽입 방어

## 스키마
- `SCHEMA_VERSION`: `2026-08-30.1`
- migration: `migrations/main/0010_v91_foreign_application_forms.sql`

## 주의
이 복구는 V90.1 전체본과 사용자 제공 원본 HWPX 3종, 그리고 대화에서 확인된 V91 구조 단서를 결합한 재구성본이다.
삭제된 과거 V91 patch 파일 자체가 없으므로 바이트 단위 동일성은 보장하지 않는다.
다만 원본 HWPX는 사용자 제공 파일을 그대로 번들했으며, V91 구조 단서(경로, migration 이름, schema version,
ensureTables 통합, 테스트자료 초기화, 회귀테스트)를 반영했다.
