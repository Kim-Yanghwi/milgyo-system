# v27 검토본 회계 첨부파일 확대·운영 안정화 배포절차

## 0. 적용파일 선택

사용자의 현재 소스에는 법인카드 삭제 기능이 이미 반영되어 있으므로, 이전 v27 패치를 섞어 적용하지 말고 **새로 전달된 검토본 패치 ZIP 한 개만** 프로젝트 루트에 덮어쓴다. 전체 소스 ZIP은 덮어쓰기 과정에서 문제가 생겼을 때 비교·복구용으로 사용한다.

## 1. 적용 범위

- 기부·후원: 증빙자료 및 기부금영수증
- 자산·비품: 취득증빙, 계약서, 사진 등
- 법인카드: 카드 삭제·빈 카드코드 재사용, 결제금액 10% 세액 자동계산, 사용일자 요일 표시, 카드 자체 서류 및 카드 사용내역 영수증
- 사찰·교구 취합: 제출보고서
- 특화 결산자료 및 기본회계 월 마감자료
- 허용 확장자, 파일당 용량, 건당 개수·총용량, 보존기간, 삭제사유 정책
- 확장자와 파일 시그니처 기본검사
- D1 단독·R2 단독 파일 점검목록
- R2 삭제 실패 재처리 목록
- 감사계정 읽기 전용 및 자료별 권한 재검증

## 2. 매우 중요한 적용 순서

**D1 마이그레이션을 먼저 적용하고, 소스를 나중에 배포한다.**

새 소스는 v27 테이블과 컬럼을 요구하므로 순서를 바꾸면 회계 API가 일시적으로 실패할 수 있다.

## 3. 배포 전 안전조치

프로젝트 폴더에서 다음을 실행한다.

```powershell
cd "C:\Users\User\Documents\GitHub\milgyo-system"
git status
```

작업 중인 변경이 있다면 먼저 별도 ZIP 또는 커밋으로 보관한다.

배포 직전 D1 전체 백업은 다음처럼 생성한다.

```powershell
npx.cmd wrangler d1 export milgyo-system-db --remote --output=.\backup-main-before-v27.sql --skip-confirmation
npx.cmd wrangler d1 export milgyo-accounting-db --remote --output=.\backup-accounting-before-v27.sql --skip-confirmation
```

Cloudflare D1의 Time Travel 탭에서도 배포 직전 시각을 기록한다.

## 4. 패치파일 덮어쓰기

패치 ZIP의 폴더 구조를 유지한 채 프로젝트 루트에 덮어쓴다. `.env`, `.dev.vars`, 비밀번호, 토큰은 패치에 포함되지 않는다.

```powershell
git status
```

다음과 같은 파일이 추가·수정되어야 한다.

- `migrations/accounting/0004_v27_attachment_operations.sql`
- `functions/_shared/accounting-attachment-ops.ts`
- 첨부파일 API 및 회계 조회 API
- `public/accounting-generic-attachments.js`
- `src/pages/accounting.astro`
- `src/pages/accounting-special.astro`
- `src/pages/accounting-files.astro`
- `workers/accounting-maintenance.ts`
- `wrangler.accounting-maintenance.toml`

## 5. D1 마이그레이션 적용

### 권장: Wrangler 사용

```powershell
npx.cmd wrangler d1 migrations apply milgyo-accounting-db --remote --config .\wrangler.toml
```

실행 전 적용될 마이그레이션으로 `0004_v27_attachment_operations.sql`이 표시되는지 확인한다.

### 대안: Cloudflare D1 Console

Wrangler 인증이 계속 실패하는 경우 `milgyo-accounting-db → Console`에서 `migrations/accounting/0004_v27_attachment_operations.sql` 내용을 위에서부터 실행한다. `ALTER TABLE ... ADD COLUMN` 문장은 한 번만 실행한다.

### 적용 확인

`docs/V27_ATTACHMENT_VERIFY.sql`의 조회문을 실행한다. 정상 기준은 다음과 같다.

- `schema_version = 2026-07-29.1`
- 정책·무결성·재처리 테이블 3개 존재
- `accounting_attachments`에 7개 운영컬럼 추가
- 기본 정책 1건 존재

## 6. 빌드 및 Pages 배포

```powershell
npm.cmd run build
```

빌드 성공 후:

```powershell
git add .
git commit -m "회계 첨부파일 전 메뉴 확대 및 법인카드 계산 보완"
git push
```

Cloudflare Pages 배포가 `Success`인지 확인한다.

## 7. 수동 기능시험

1. `/accounting-special/`에서 기부·후원, 자산·비품, 법인카드, 사찰·교구 취합, 특화 결산자료의 `첨부관리` 버튼을 확인한다.
2. `/accounting/`에서 결의서와 월 마감자료 첨부를 확인한다.
3. 법인카드 결제금액에 `20,000`을 입력하여 세액 `2,000`, 세액 제외금액 `18,000`이 표시되는지 확인한다.
4. 사용일자를 `2026-07-31`로 선택하여 `(금)`이 표시되는지 확인한다.
5. PDF 또는 JPG 1개를 등록하고 다운로드한다.
6. 삭제사유를 입력하여 삭제한다.
7. 감사계정으로 등록·삭제가 차단되는지 확인한다.
8. `/accounting-files/`에서 정책과 점검목록을 확인한다.
9. 처음에는 `D1 기준 점검`만 실행하고, 결과가 정상일 때 `D1·R2 전체 점검`을 실행한다.

## 8. 정기점검 Worker 배포

수동 전체점검까지 정상인 경우에만 배포한다.

```powershell
npx.cmd wrangler deploy --config .\wrangler.accounting-maintenance.toml
```

정기 실행시각은 UTC 기준이며 설정상 다음과 같다.

- 매일 18:20 UTC: 다음 날 03:20 KST, D1 기준 점검, 첨부 실패작업 및 전자결재·회계 연계 재처리
- 매주 토요일 18:40 UTC: 일요일 03:40 KST, D1·R2 전체 양방향 점검

Cloudflare의 `Workers & Pages → milgyo-accounting-maintenance → Logs`에서 첫 실행결과를 확인한다.

## 9. 배포 직후 관찰

최소 1영업일 동안 다음을 확인한다.

- 업로드·다운로드·삭제 오류
- `accounting_attachment_operations`의 실패항목
- `accounting_attachment_integrity_issues`의 신규항목
- 기존 수입·지출결의, 법인카드 전표처리, 월 마감 기능 회귀 여부
