# V60 증명서 메뉴·수계증서 개선 배포 절차

## 1. 배포 전 확인
1. 현재 운영 소스의 커밋 번호를 기록합니다.
2. 메인 D1 데이터베이스 `milgyo-system-db`를 백업합니다.
3. 수계증서 발급 중인 사용자가 없는 시간에 배포합니다.

## 2. 코드 적용
패치 ZIP의 폴더 구조를 유지한 채 프로젝트 최상위 폴더에 적용합니다.

주요 수정 파일:
- `src/layouts/ManagementLayout.astro`
- `src/pages/index.astro`
- `src/pages/ordination-certificates.astro`
- `src/pages/accounting-files.astro`
- `functions/api/ordination/action.ts`
- `functions/api/ordination/query.ts`
- `functions/_shared/helpers.ts`
- `functions/_shared/test-data-reset.ts`
- `docs/schema.sql`

신규 파일:
- `migrations/main/0004_v60_ordination_seal_options.sql`

## 3. D1 마이그레이션
프로젝트 최상위 폴더에서 다음 명령을 실행합니다.

```powershell
npx.cmd --yes wrangler d1 migrations apply milgyo-system-db --remote --config wrangler.toml
```

적용 결과에서 `0004_v60_ordination_seal_options.sql`이 완료되었는지 확인합니다.

```powershell
npx.cmd --yes wrangler d1 migrations list milgyo-system-db --remote --config wrangler.toml
```

API의 `ensureTables()`도 누락 컬럼을 순차적으로 보완하지만, 운영 배포에서는 명시적 마이그레이션을 먼저 적용합니다.

## 4. 빌드

```powershell
npm.cmd ci
npm.cmd run build
```

기존 운영 환경에서 다른 패키지 관리자를 사용한다면 해당 잠금파일과 기존 배포 절차를 유지합니다.

## 5. 배포 후 필수 확인
1. 어느 화면에서든 좌측 메뉴에 `증명서 발급·대장`이 표시되는지 확인합니다.
2. 그 아래에 재직증명서와 수계증서 메뉴가 동시에 표시되는지 확인합니다.
3. 생년월일에 `19570119`를 입력했을 때 `1957-01-19`로 바뀌는지 확인합니다.
4. 달력 버튼을 눌렀을 때 같은 날짜가 선택되어 있는지 확인합니다.
5. `향천사 도장 표시`를 체크한 미리보기와 해제한 미리보기를 각각 확인합니다.
6. 수계증서를 한 건 발급한 뒤 상세조회·재출력에서도 도장 선택이 유지되는지 확인합니다.
7. 오계 본문의 첫 단어가 모두 같은 세로선에서 시작하는지 확인합니다.
8. 불기 숫자가 겹치지 않는지 인쇄 미리보기와 실제 인쇄물에서 확인합니다.
9. 테스트자료 초기화 미리보기에 수계증서 건수가 표시되는지 확인합니다.

## 6. 운영 데이터 주의
`테스트자료 일괄 초기화`는 수계증서 발급대장도 삭제합니다. 운영 데이터가 포함된 환경에서는 실행하지 말고, 반드시 백업 완료 체크와 확인문구를 검토한 뒤 사용합니다.

## 7. 롤백
- 코드 문제는 직전 정상 커밋으로 되돌립니다.
- 신규 컬럼은 기존 기능에 영향을 주지 않으므로 긴급 롤백 때 삭제하지 않습니다.
- 컬럼 제거는 데이터 보존 여부를 검토한 뒤 별도 승인과 백업을 거쳐 수행합니다.
