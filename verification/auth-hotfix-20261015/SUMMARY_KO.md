# 검증 요약 — V99 AUTH HOTFIX

## 통과한 확인

| 검사 | 결과 | 범위 |
|---|---|---|
| 회귀 테스트 | 173 통과 / 0 실패 | 19개 테스트 파일 중 세무·회계 fflate 의존 테스트 1개 제외, 나머지 18개 |
| 인증 관련 테스트 | 88 통과 / 0 실패 | 위 173개에 포함된 부분집합 |
| 보안·인증 TypeScript 검사 | 통과 | tsc 5.8.3 / tsconfig.security.json |
| 공통 세션 스크립트 | 문법 검사 통과 | node --check |
| 수정 Astro 내부 스크립트 | 총 3개 문법 검사 통과 | Astro 전체 빌드가 아닌 JS 파싱 |
| 바인딩 구성 정적 검사 | 통과 | 원본 설정의 구조·환경 분리 확인, 운영 연결 검증 아님 |
| 노란 알림 재현 | 원본 있음 → 수정본 없음 | 동일한 정상 비로그인 401, VM 환경 |
| SQL 복구·데이터 보존 | 통과 | SQLiteD1 테스트 데이터, 원격 운영 DB 아님 |

## 실행 방식

npm 외부 패키지 다운로드가 막혀 설치된 Node 22.16.0과 TypeScript 5.8.3의 로컬 transpileModule 기반 ESM 로더를 사용했습니다. 애플리케이션 로직이나 SQL은 대체하지 않았습니다. 클라이언트 테스트의 DOM·네트워크는 기존 VM harness를 사용하며, DB 테스트는 실제 SQLite를 사용합니다.

실행한 세션 테스트:
```sh
node --import ../test-runtime/register.mjs --test tests/v97-security-runtime.test.ts tests/v97-session-client.test.ts tests/v99-auth-readiness-hotfix.test.ts
```

회귀 테스트는 `tests/*.test.ts` 중 `tax-accounting-regression.test.ts`를 제외한 18개 파일을 같은 로더로 실행했습니다. 프로젝트 의존성이 설치된 환경에서는 원래 프로젝트의 `npm test` 및 `npm run verify`로 전체 검사를 다시 수행해야 합니다.

## 미완료·미실행

전체 Astro 빌드는 npm DNS 실패에 따른 의존성 미설치로 실행되지 못했습니다. 브라우저 통합 시험은 Chromium의 로컬 탐색 차단으로 시작 전 중단됐습니다. 운영 Cloudflare의 DB 조회·SQL 실행·배포·실제 로그인 시험은 수행하지 않았습니다.

`npm-install-limitation.txt`, `build-attempt.txt`, `browser-checks.json`에 제한을 기록했습니다. 이를 통과 기록으로 취급하면 안 됩니다.
