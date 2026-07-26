# 종단관리시스템 v26 배포 안내

## 1. 적용 목적

v26은 전자문서·계정·조직 데이터와 회계 데이터를 서로 다른 Cloudflare D1에 저장합니다.

- `DB` → `milgyo-system-db`: 로그인, 계정, 조직, 전자문서, 결재, 접수·발송, 회계 연계대기 상태
- `ACCOUNTING_DB` → `milgyo-accounting-db`: 예산, 결의, 전표, 분개, 장부, 결산, 기부·후원, 자산, 법인카드, 사찰·교구 취합
- `FILES` → `milgyo-system-files`: 첨부파일

사용자가 확인한 현재 환경은 `ACCOUNTING_DB`의 기본 23개 테이블과 기준정보가 이미 생성된 상태입니다. 등록된 실제 회계자료가 없으므로 별도 자료 이전은 하지 않습니다.

## 2. 배포 전 확인

아래 바인딩이 운영환경에 모두 있어야 합니다.

```text
DB             → milgyo-system-db
ACCOUNTING_DB  → milgyo-accounting-db
FILES          → milgyo-system-files
```

기존 D1 전체 백업파일을 별도로 보관합니다.

```text
backup/milgyo-system-db-before-accounting-split.sql
```

백업 SQL, `node_modules`, Wrangler 인증파일은 GitHub에 올리지 않습니다.

## 3. 데이터베이스 마이그레이션

**코드 배포 전에** 프로젝트 폴더에서 아래 두 명령을 순서대로 실행합니다.

### 3.1 기존 문서 DB에 회계 연계대기 테이블 생성

```powershell
npx.cmd wrangler d1 execute milgyo-system-db --remote --file=".\migrations\main\0001_v26_accounting_outbox.sql"
```

### 3.2 회계 DB에 월별 집계표와 조회용 인덱스 추가

```powershell
npx.cmd wrangler d1 execute milgyo-accounting-db --remote --file=".\migrations\accounting\0002_v26_performance.sql"
```

두 SQL은 `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, 고유키 기반 갱신을 사용하므로 동일 파일을 다시 실행해도 구조가 중복 생성되지 않습니다. 다만 운영 중에는 변경 이력을 남기기 위해 한 번만 실행하는 것을 권장합니다.

## 4. 마이그레이션 확인

### 4.1 기존 문서 DB 확인

```powershell
npx.cmd wrangler d1 execute milgyo-system-db --remote --file=".\migrations\main\verify_v26.sql"
```

정상 결과:

```text
outbox_table = 1
```

### 4.2 회계 DB 확인

```powershell
npx.cmd wrangler d1 execute milgyo-accounting-db --remote --file=".\migrations\accounting\verify_v26.sql"
```

정상 기준:

```text
accounting_tables = 24
accounts          = 34
fiscal_years      = 5
book_types        = 3
funds             = 4
schema_version    = 2026-07-26.4
```

`monthly_rows`는 아직 회계자료가 없으면 `0`이 정상입니다.

## 5. 소스 교체 및 빌드

전체 소스 ZIP을 사용하는 경우 기존 GitHub 폴더를 별도 백업한 뒤 파일을 덮어씁니다. 교체파일 ZIP을 사용하는 경우 ZIP 안의 경로를 유지하여 덮어씁니다.

PowerShell에서 실행합니다.

```powershell
cd "C:\Users\User\Documents\GitHub\milgyo-system"
npm.cmd install
npm.cmd run build
```

정상 완료 기준:

```text
[build] Complete!
```

## 6. GitHub 반영과 Cloudflare 배포

```powershell
git add .
git commit -m "회계 전용 DB 분리 및 성능개선 v26"
git push
```

Cloudflare에서 다음을 확인합니다.

```text
Workers & Pages
→ milgyo-system
→ Deployments
→ 최신 배포 Success
```

## 7. 배포 직후 점검

### 7.1 상태 점검 API

로그인 여부와 관계없이 브라우저에서 다음 주소를 엽니다.

```text
https://system.milgyo.org/api/health
```

정상 상태에서는 다음 항목이 확인됩니다.

- `ok: true`
- `database: true`
- `accountingDatabase: true`
- `accountingSchemaVersion: "2026-07-26.4"`

### 7.2 화면 점검

1. 전자문서 홈 로그인
2. `회계관리` 진입
3. 회계연도·계정과목·장부 조회
4. 관리자 계정에서 `전자결재·회계 연계 상태` 확인
5. 실패 건이 없다면 `failed = 0`

### 7.3 기능 시험

실제 운영자료 입력 전 아래 시험자료 한 건으로 확인합니다.

```text
지출결의 작성
→ 결재자 지정
→ 전자결재 상신
→ 최종 승인
→ 회계전표 한 건 생성
→ 계정별 원장 반영
→ 합계잔액시산표 차변·대변 일치
→ 월별 집계 반영
```

추가 확인:

- 같은 승인 요청을 반복해도 전표가 중복 생성되지 않아야 합니다.
- 반려 결의서는 전표가 생성되지 않아야 합니다.
- 회계 DB 일시 오류 시 문서 결재는 보존되고 연계상태가 `failed` 또는 `pending`으로 남아야 합니다.
- 관리자 재처리 후 `succeeded`로 변경되어야 합니다.

## 8. 안정화 기간 주의사항

기존 `milgyo-system-db`에 남아 있는 과거 회계 테이블은 바로 삭제하지 않습니다. 최소 1~2주 동안 보존하여 긴급 롤백에 사용합니다.

다음 작업은 안정화가 끝날 때까지 하지 않습니다.

- 기존 DB의 `accounting_*` 테이블 삭제
- 새 회계 DB 직접 수정
- D1 Console에서 임의로 문서번호·전표번호 변경
- 연계 실패 자료를 SQL로 직접 삭제

연계 실패는 회계관리 화면의 관리자 재처리 기능으로 처리합니다.

## 9. 운영 구조의 핵심

전자결재 승인과 회계전표 생성은 서로 다른 D1에서 처리되므로 하나의 트랜잭션으로 묶을 수 없습니다. v26은 아래와 같이 안전하게 처리합니다.

```text
문서 DB에서 승인과 회계연계 이벤트를 함께 저장
→ 회계 DB에 전표 생성 시도
→ 성공: succeeded
→ 실패: 원인·재시도 횟수 기록
→ 관리자 재처리
```

각 이벤트와 회계전표에는 고유키가 있어 재시도해도 동일 전표가 중복 생성되지 않습니다.
