# V59 수계증서 발급·대장 배포 절차

## 1. 배포 전 백업
1. 현재 운영 소스의 커밋 번호를 기록합니다.
2. 메인 D1 `milgyo-system-db`를 백업합니다.
3. 운영 중인 다른 기능에서 미커밋 변경사항이 없는지 확인합니다.

## 2. 코드 적용
패치 ZIP의 폴더 구조를 유지한 채 프로젝트 최상위 폴더에 덮어씁니다.

주요 신규 파일:
- `src/pages/ordination-certificates.astro`
- `functions/api/ordination/action.ts`
- `functions/api/ordination/query.ts`
- `migrations/main/0003_v59_ordination_certificates.sql`
- `public/certificates/ordination/*`

기존 파일 수정:
- `src/layouts/ManagementLayout.astro`
- `functions/_shared/helpers.ts`
- `functions/_shared/management.ts`
- `docs/schema.sql`
- `public/_headers`
- `package.json`, `package-lock.json`

## 3. D1 마이그레이션
프로젝트 최상위 폴더에서 실행합니다.

```powershell
npx.cmd --yes wrangler d1 migrations apply milgyo-system-db --remote --config wrangler.toml
```

정상적으로 `0003_v59_ordination_certificates.sql`이 적용됐는지 확인합니다.

```powershell
npx.cmd --yes wrangler d1 migrations list milgyo-system-db --remote --config wrangler.toml
```

API의 `ensureTables()`도 누락 테이블과 `request_id` 컬럼을 자동 보완하지만, 운영 배포 전 명시적 마이그레이션을 먼저 적용하는 방식을 권장합니다.

## 4. 로컬 검사 및 빌드
PowerShell 실행 정책으로 `npm.ps1`이 차단되는 PC에서는 `.cmd` 명령을 사용합니다.

```powershell
npm.cmd install
npm.cmd run build
```

또는 기존에 pnpm을 사용하고 있다면 다음처럼 실행합니다.

```powershell
pnpm.cmd install --no-frozen-lockfile
pnpm.cmd run build
```

## 5. 커밋·배포

```powershell
git status --short
git add -A
git commit -m "수계증서 발급 및 발급대장 기능 추가 V59"
git push
```

Cloudflare Pages 배포가 성공한 뒤 브라우저에서 `Ctrl + F5`로 새로고침합니다.

## 6. 운영 확인
1. 관리자 계정으로 로그인합니다.
2. 좌측 `수계증서 > 수계증서 발급·대장` 메뉴를 엽니다.
3. 테스트 수계자 정보를 입력하고 미리보기를 확인합니다.
4. 발급 버튼을 눌러 D1 저장과 자동 인쇄창 실행을 확인합니다.
5. 발급대장에서 상세·출력·취소를 확인합니다.
6. 감사 계정은 목록·상세만 가능하고 발급·취소가 차단되는지 확인합니다.
7. 일반 계정의 직접 URL 접근이 차단되는지 확인합니다.

## 7. 글꼴 확인
원본 서식은 `한양해서`, `궁서체`, `궁서`, `신명 궁서`를 사용합니다. 해당 글꼴은 프로젝트에 포함하지 않으며, 원본과 같은 출력을 위해 한컴오피스 글꼴이 설치된 Windows PC에서 인쇄합니다.

## 8. 롤백
문제가 발생하면 직전 정상 커밋으로 코드를 되돌립니다. 신규 D1 테이블은 기존 기능과 분리돼 있으므로 즉시 삭제하지 않아도 기존 기능에 영향을 주지 않습니다. 데이터 보존이 필요 없다는 판단이 확정된 뒤에만 별도 승인 절차로 테이블을 제거합니다.
