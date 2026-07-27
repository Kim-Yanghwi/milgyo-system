# 회계 전용 R2 첨부파일 기능 적용 안내

## 1. 이번 교체파일의 역할

이번 파일은 회계자료의 첨부파일을 다음 원칙으로 저장합니다.

- 회계자료 및 파일 메타데이터: `ACCOUNTING_DB` D1
- 실제 첨부파일 원본: `ACCOUNTING_FILES` R2
- 전자문서용 `FILES` R2와 회계용 `ACCOUNTING_FILES` R2를 완전히 분리
- 회계 R2가 연결되지 않으면 D1에 파일을 대신 저장하지 않고 업로드 차단
- 로그인, 회계 접근권한, 자료별 열람·등록 권한을 확인한 후 처리
- 파일 등록 및 삭제 이력을 `accounting_audit_logs`에 기록

## 2. 교체·추가되는 파일

### 교체

- `functions/types.d.ts`
- `functions/_shared/accounting.ts`

### 추가

- `functions/_shared/accounting-attachments.ts`
- `functions/api/accounting/upload-attachment.ts`
- `functions/api/accounting/list-attachments.ts`
- `functions/api/accounting/attachment-data.ts`
- `functions/api/accounting/delete-attachment.ts`

## 3. 적용 순서

1. 압축파일의 폴더 구조를 유지한 채 GitHub 저장소 루트에 업로드합니다.
2. 기존 파일 교체 여부가 나타나면 교체를 승인합니다.
3. 커밋 메시지는 다음과 같이 입력합니다.

   `회계 전용 R2 첨부파일 API 추가`

4. Cloudflare Pages의 자동 배포가 완료될 때까지 기다립니다.
5. Cloudflare Pages 프로젝트에서 다음 바인딩을 확인합니다.

   - 종류: R2 bucket
   - 변수명: `ACCOUNTING_FILES`
   - 버킷: `milgyo-accounting-files`

6. 바인딩을 코드 배포 후 추가했다면 최신 배포를 한 번 다시 실행합니다.
7. 브라우저에서 캐시를 피하기 위해 다음처럼 임의 쿼리를 붙여 점검합니다.

   `/api/health?v=회계R2적용일시`

8. 다음 값이 모두 `true`이면 바인딩이 정상입니다.

   - `ok`
   - `database`
   - `accountingDatabase`
   - `storage`
   - `accountingStorage`

## 4. D1 테이블 확인

Cloudflare D1의 `milgyo-accounting-db` 콘솔에서 다음을 실행합니다.

```sql
PRAGMA table_info(accounting_attachments);
```

아래 열이 존재해야 합니다.

- `id`
- `reference_type`
- `reference_id`
- `file_category`
- `original_filename`
- `stored_filename`
- `object_key`
- `content_type`
- `size_bytes`
- `checksum_sha256`
- `uploaded_by`
- `uploaded_at`
- `deleted_at`
- `deleted_by`

## 5. API 주소

| 기능 | 주소 | 방식 |
|---|---|---|
| 업로드 | `/api/accounting/upload-attachment` | POST JSON |
| 목록 | `/api/accounting/list-attachments` | POST JSON |
| 다운로드 | `/api/accounting/attachment-data` | POST JSON |
| 삭제 | `/api/accounting/delete-attachment` | POST JSON |

## 6. 회계자료 구분값

화면에서 API를 호출할 때 `referenceType`은 다음 값만 사용합니다.

| 화면·자료 | referenceType | referenceId |
|---|---|---|
| 예산 | `budget` | `accounting_budget_plans.id` |
| 수입·지출결의 | `resolution` | `accounting_resolutions.id` |
| 전표 | `journal` | `accounting_journals.id` |
| 기부금 | `donation` | `accounting_donations.id` |
| 기부금영수증 | `receipt` | 해당 `accounting_donations.id` |
| 자산·비품 | `asset` | `accounting_assets.id` |
| 법인카드 | `card` | `accounting_cards.id` |
| 카드 사용내역 | `card_transaction` | `accounting_card_transactions.id` |
| 사찰·교구 취합자료 | `branch_report` | `accounting_branch_reports.id` |
| 결산·마감 | `closing` | `accounting_closings.id` |

## 7. 현재 구현 범위

이번 교체파일은 서버 기능을 완성합니다.

- R2 업로드
- D1 메타데이터 등록
- 첨부파일 목록 조회
- 권한 확인 후 다운로드
- 논리삭제와 R2 실제 삭제
- SHA-256 체크섬 기록
- 감사로그 기록

회계 화면의 첨부 버튼, 첨부목록, 다운로드·삭제 버튼은 다음 UI 연결 단계에서 추가합니다. 서버 API를 먼저 배포하고 바인딩·건강상태 점검이 끝난 뒤 화면을 연결하면 장애 범위를 줄일 수 있습니다.

## 8. UI 연결 권장 순서

1. 수입·지출결의 상세화면에 첨부기능 연결
2. 전표 상세화면은 열람 위주로 연결
3. 기부금·기부금영수증 연결
4. 자산·비품 연결
5. 법인카드 및 카드 사용내역 연결
6. 사찰·교구 취합자료 연결
7. 예산과 결산·마감자료 연결

각 화면에서 신규 자료를 저장하기 전에는 `referenceId`가 없으므로 첨부할 수 없습니다. 자료를 먼저 저장한 후 반환된 `id`를 사용해 첨부파일을 등록하도록 구현해야 합니다.

## 9. 운영 전 점검사항

- 파일 크기 제한: 파일당 4MB
- 자료별 파일 수 제한: 10개
- 실행 가능한 스크립트·프로그램 확장자 업로드 차단
- 회계 R2가 없으면 업로드·다운로드·삭제 API가 503 반환
- 감사 계정은 다운로드만 가능하고 등록·삭제 불가
- 일반 회계 사용자는 자신이 생성한 결의·기부·카드사용·취합자료의 첨부만 등록 가능
- 회계관리자와 관리자는 관리 대상 자료의 첨부를 등록·삭제 가능

## 10. 롤백

문제가 생기면 이번에 추가한 API 파일 5개와 공통 헬퍼 1개를 제거하고, 아래 두 파일을 직전 커밋으로 되돌립니다.

- `functions/types.d.ts`
- `functions/_shared/accounting.ts`

이번 기능은 기존 회계 데이터의 행을 변경하지 않으며, 첨부파일 API를 호출하지 않는 기존 회계기능에는 직접적인 데이터 변경을 하지 않습니다.
