# Milgyo OS V93 FINAL 적용 및 마이그레이션 가이드

## 0. 가장 중요한 원칙
이 최종 패치는 **코드 보정 패치**입니다. 운영 D1에는 V93 신규 migration을 적용하지 않습니다.

운영 DB를 직접 조회한 결과 이미 `조화연=이사장`, `김양휘=사무총장` 상태였고, 김양휘 이사장 참조도 확인 대상에서 0건이었습니다. 따라서 `0012_v93_chairman_handover.sql`, `0019_v93_chairman_handover.sql`은 최종안에서 제거합니다.

## 1. 새 브랜치 생성
삭제한 Preview 브랜치를 재사용하지 말고 최신 main에서 새 브랜치를 만듭니다.

권장 이름:

`v93-final-chairman-20260913`

GitHub Desktop에서:

1. Current Branch → main
2. Fetch origin / Pull origin
3. Branch → New branch
4. `v93-final-chairman-20260913`

## 2. 패치 적용
이 ZIP의 내용물을 저장소 루트에 같은 경로로 덮어씁니다.

패치 대상:

- `functions/_shared/helpers.ts`
- `functions/api/accounting-special/query.ts`
- `functions/api/employment/query.ts`
- `functions/api/users/list.ts`
- `src/pages/employee-certificates.astro`
- `tests/v93-chairman-handover.test.ts`
- `tests/v91-1-immigration-ui-paper.test.ts`
- `scripts/check-v93-final.mjs`
- `docs/V93_FINAL_20260913.md`

이 ZIP은 `wrangler.toml`을 포함하지 않습니다. 현재 정상 동작 중인 D1/R2 ID를 덮어쓰지 마십시오.

## 3. 이전 V93 migration 잔존 여부 제거
새 브랜치의 저장소 루트 PowerShell에서 다음을 실행합니다.

```powershell
Remove-Item .\migrations\main\0012_v93_chairman_handover.sql -ErrorAction SilentlyContinue
Remove-Item .\migrations\accounting\0019_v93_chairman_handover.sql -ErrorAction SilentlyContinue
```

과거 migration인 아래 파일은 수정/삭제하지 않습니다.

`migrations/main/0005_v61_employment_certificate_signatory.sql`

## 4. 로컬 검증
PowerShell 실행 정책 문제를 피하기 위해 npm.cmd를 사용합니다.

```powershell
npm.cmd ci
node .\scripts\check-v93-final.mjs
npm.cmd test
npm.cmd run build
```

판정 기준:

- `check-v93-final.mjs` → `[v93-final] OK`
- `npm.cmd test` → 전체 테스트 통과
- `npm.cmd run build` → `[build] Complete!`

500kB chunk 경고는 이번 V93 기능 실패가 아니라 성능 경고입니다.

## 5. Preview 배포
Commit/Push 후 Cloudflare Preview가 초록색인지 확인합니다.

Preview 화면에서 반드시 확인:

1. 계정관리/사용자 목록에서 `조화연`이 `김양휘`보다 먼저 보임
2. 조화연 = 이사장
3. 김양휘 = 사무총장
4. 재직증명서 발급명의 기본 후보 = 조화연(이사장)
5. 회계 소속증명원 발급 이사장 후보 = 조화연 우선
6. 기존 기능(전자결재/회계/증명서) 오류 없음

## 6. D1 마이그레이션 방법
### A. 기존 Preview DB를 계속 쓰는 경우
브랜치를 삭제했어도 D1 데이터베이스를 삭제하지 않았다면 다시 초기화하지 않습니다.

확인만 합니다.

```powershell
npx.cmd --yes wrangler@3.114.17 d1 migrations list DB --env preview --remote
npx.cmd --yes wrangler@3.114.17 d1 migrations list ACCOUNTING_DB --env preview --remote
```

기존 migration이 모두 적용되어 있다면 추가 적용하지 않습니다.

### B. Preview D1을 새로 만든 빈 DB인 경우에만
최종 패치에는 V93 신규 migration이 없으므로 기존 baseline만 적용합니다.

MAIN:

```powershell
npx.cmd --yes wrangler@3.114.17 d1 migrations list DB --env preview --remote
npx.cmd --yes wrangler@3.114.17 d1 migrations apply DB --env preview --remote
```

MAIN의 최종 기존 migration은 `0011_v92_appointment_award_certificates.sql`입니다.

ACCOUNTING:

```powershell
npx.cmd --yes wrangler@3.114.17 d1 migrations list ACCOUNTING_DB --env preview --remote
npx.cmd --yes wrangler@3.114.17 d1 migrations apply ACCOUNTING_DB --env preview --remote
```

ACCOUNTING의 최종 기존 migration은 `0018_v85_reconciliation_integrity.sql`입니다.

### C. Production
**V93를 위해 Production D1 migration을 실행하지 않습니다.**

다음 명령은 V93 최종 반영을 위해 실행하지 마십시오.

```text
d1 migrations apply DB --remote
d1 migrations apply ACCOUNTING_DB --remote
```

향후 다른 버전의 정상 migration이 추가됐을 때는 별도 변경내역을 확인한 뒤 적용합니다.

## 7. main 병합
로컬 테스트 + Preview 화면 검증이 모두 통과한 뒤에만 PR을 만듭니다.

`v93-final-chairman-20260913 → main`

Production 배포가 초록색이 되면 같은 5개 화면 항목을 한 번 더 확인합니다.

## 8. 최종 운영 확인 SQL (읽기 전용, 선택사항)
MAIN:

```powershell
npx.cmd --yes wrangler@3.114.17 d1 execute DB --remote --command "SELECT name,position,department,role,can_approve,can_accounting,active FROM system_users WHERE name IN ('김양휘','조화연') ORDER BY name;"
```

목표:

- 조화연 → 이사장 / 이사장
- 김양휘 → 사무총장 / 사무처

이 명령은 SELECT만 실행합니다.

## 9. 롤백
이번 최종 패치는 Production D1을 변경하지 않으므로 문제가 생기면 코드 배포만 이전 main 배포로 롤백하면 됩니다. D1 Time Travel 복원은 이번 V93 코드 패치 때문에 수행할 필요가 없습니다.

---

## FINAL R1 보정 (2026-09-13)
`tests/v91-1-immigration-ui-paper.test.ts`의 날짜 필터 테스트가 HTML 속성 순서에 의존하던 문제를 제거했습니다.
실제 기능 코드는 변경하지 않습니다. 최종 판정은 `npm.cmd test`에서 `fail 0`과 `npm.cmd run build` 성공입니다.
