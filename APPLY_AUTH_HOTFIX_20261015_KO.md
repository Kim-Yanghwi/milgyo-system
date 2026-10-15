# 종단관리시스템 로그인·인증 DB 수정 적용 안내

대상 소스: 사용자가 첨부한 `milgyo-system-main.zip`  
대상 서비스: `system.milgyo.org` / GitHub 저장소 `milgyo-system`  
패치 식별자: `V99 AUTH HOTFIX 20261015`

> 이 자료는 공식 홈페이지 `milgyo.org`의 수정본이 아닙니다.
> **노란 알림 수정 파일 배포와 메인 D1의 인증 구조 보완은 서로 다른 작업입니다.**
> 수정 ZIP을 업로드하는 것만으로 운영 D1에 SQL이 자동 실행되지는 않습니다.
> 운영 DB 조회·수정·배포는 이번 작업에서 실행하지 않았습니다.

## 1. 확인한 원인

### 1-1. 로그인 전 노란색 세션 만료 알림

원본 `public/system-session.js`는 `/api/auth/session`의 `401 SESSION_REQUIRED` 응답을 받으면, 이전 로그인 상태가 전혀 없어도 `clear()`를 호출하고 `milgyo:session-ended` 이벤트를 발생시킵니다. 알림 처리기 역시 이전 세션 유무와 로그인 화면 표시 여부를 구분하지 않았습니다.

따라서 정상적인 첫 방문에서도 “세션이 종료되었습니다”라는 알림이 나타났습니다. 원본과 수정본을 동일한 VM 테스트에 넣어, 원본에서 알림이 발생하고 수정본에서는 발생하지 않는 것을 재현했습니다.

수정본은 이전 세션 유무를 `hadSession`으로 전달하고 로그인 양식이 이미 보이는 화면에서는 중복 알림을 표시하지 않습니다. 반면 실제 작업 화면에서 세션이 만료되면 기존 안내를 유지합니다. 만료 후 후속 요청이 다시 401을 반환해도 이미 표시한 안내가 사라지지 않도록 했습니다. 로그인 화면으로 전환할 때 남은 알림을 정리하며 공통 스크립트 URL의 버전도 변경했습니다.

### 1-2. “인증 DB 준비가 필요합니다”

원본 `functions/_shared/security/sessions.ts`의 `ensureAuthSchema()`는 메인 `DB`의 `sqlite_master`에서 다음 세 객체가 모두 존재하는지 확인합니다.

| 구분 | 객체 이름 | 역할 |
|---|---|---|
| 테이블 | `auth_rate_buckets` | 로그인 등 인증 요청 횟수 제한 |
| 트리거 | `trg_security_revoke_user_sessions` | 비밀번호·활성 상태·권한 변경 시 기존 세션 폐기 |
| 트리거 | `trg_security_delete_user_sessions` | 계정 삭제 시 기존 세션 폐기 |

세 객체가 모두 확인되지 않으면 `AUTH_SCHEMA_NOT_READY` 오류가 발생하고, 미들웨어가 사진의 문구와 HTTP 503을 반환합니다. 이 검사는 보안상 필요한 것이므로 삭제하거나 우회하지 않았습니다.

이 세 객체를 만드는 SQL은 원본에도 `migrations/main/0012_v97_security_sessions.sql`로 들어 있었습니다. 하지만 D1 바인딩 등록과 SQL 적용은 별개이며, 원본의 `ensureTables()` 경로도 이 V97 인증 마이그레이션을 대신 적용하지 않습니다.

사진의 DB 바인딩 이름은 첨부 소스와 일치합니다. 다만 사진만으로 운영 DB의 실제 테이블·트리거 존재 여부나 현재 배포가 사용하는 DB ID까지 확인할 수는 없습니다. 따라서 아래 읽기 전용 진단으로 실제 누락 항목을 확인해야 합니다.

## 2. 파일 구성과 변경 범위

실제 애플리케이션 수정 파일은 다음 5개입니다.

| 파일 | 변경 내용 |
|---|---|
| `public/system-session.js` | 비로그인/실제 만료 구분, 로그인 화면 중복 알림 방지 |
| `src/layouts/GovLayout.astro` | 공통 세션 스크립트 버전 변경 |
| `src/pages/index.astro` | 로그인 화면으로 전환할 때 기존 알림 정리 |
| `functions/_middleware.ts` | 인증 구조 오류 안내 구체화, 서버 로그에 대상 바인딩·마이그레이션 경로 추가 |
| `functions/api/auth/bootstrap.ts` | 인증 구조 오류를 일반 계정 생성 오류로 숨기지 않고 전달 |

다음 SQL·검증 자료를 추가했습니다.

- `database/AUTH_DIAGNOSE_MAIN_20261015.sql`: 읽기 전용 구조 진단.
- `database/AUTH_REPAIR_MAIN_20261015.sql`: 기존 메인 테이블 확인 후 V97 객체만 보완.
- `tests/v97-session-client.test.ts`: 기존 테스트 유지 및 알림 회귀 테스트 추가.
- `tests/v99-auth-readiness-hotfix.test.ts`: 인증 오류 재현, 복구, 데이터 보존 테스트.
- `verification/auth-hotfix-20261015/`: 실제 테스트 결과와 미완료 검증 범위.

`wrangler.toml`, D1/R2 연결 정보, `package.json`, `package-lock.json`, `.node-version`, 기존 마이그레이션 SQL, 비밀번호 검증·세션 쿠키·권한 검사 구현은 변경하지 않았습니다. 회계·문서·직인 기능의 애플리케이션 코드도 변경하지 않았습니다.

## 3. 먼저 대상 DB와 백업을 확인하세요

대상은 **메인 D1 `milgyo-system-db`**입니다. **`ACCOUNTING_DB` / `milgyo-accounting-db`에 실행하지 마세요.**

| 항목 | 이 작업의 대상 여부 |
|---|---|
| `DB` → `milgyo-system-db` | 인증 SQL 적용 대상 |
| `ACCOUNTING_DB` → `milgyo-accounting-db` | 변경하지 않음 |
| `FILES` → `milgyo-system-files` | 변경하지 않음 |
| `ACCOUNTING_FILES` → `milgyo-accounting-files` | 변경하지 않음 |

먼저 현재 GitHub 커밋과 배포를 보관하고, 메인 D1을 백업 또는 내보내기 하세요. Wrangler를 사용하는 경우 저장소 루트에서 아래 명령을 사용할 수 있습니다. Cloudflare에 로그인한 운영자 계정과 올바른 계정·DB를 확인한 뒤 실행하세요.

```sh
npx wrangler d1 export milgyo-system-db --remote --output=../milgyo-system-db-before-auth-fix.sql
```

백업 파일은 저장소 바깥에 보관합니다. 계정 비밀번호 해시나 세션 데이터가 포함될 수 있으므로 GitHub에 커밋하거나 채팅에 첨부하지 마세요. 백업이 실패했다면 원인을 확인한 뒤 쓰기 작업을 진행하세요.

별도 Preview가 운영 중이면 해당 Preview DB와 Preview 배포에서 먼저 확인한 후 Production에 적용하는 것이 좋습니다. 첨부 소스의 Preview 메인 DB 이름은 `milgyo-system-db-preview-v2`이며 Production과 다릅니다.

## 4. 읽기 전용 SQL로 실제 누락 항목을 확인하세요

Cloudflare 대시보드의 **Storage & databases → D1 데이터베이스 목록 → `milgyo-system-db` → Console**로 이동합니다. 아래 파일을 텍스트 편집기로 열어 첫 번째 `WITH … SELECT …;` 조회를 실행하세요.

```text
database/AUTH_DIAGNOSE_MAIN_20261015.sql
```

첫 번째 조회는 메인 기본 테이블 2개, V97 인증 객체 3개, 인증 인덱스 1개를 점검해 총 6행을 반환합니다. `OK`는 해당 이름·종류의 객체가 존재함을, `MISSING`은 없음을 뜻합니다. 뒤의 `PRAGMA table_info(...)`는 필요할 때 문장별로 실행하면 되며, 데이터 값이 아니라 컬럼 정의만 반환합니다.

**결과별 판단**

- `system_users`와 `system_sessions`는 `OK`, V97 객체가 `MISSING`: 다음 절의 보완 SQL 적용 대상입니다.
- `system_users` 또는 `system_sessions`가 `MISSING`: 일단 중단하세요. 잘못 선택한 DB인지, 현재 서비스가 다른 DB에 연결됐는지, 기본 스키마가 없는 신규 환경인지부터 확인해야 합니다. 계정을 새로 만들거나 DB를 삭제해서 해결하려 하지 마세요.
- 모두 `OK`인데 동일한 오류가 지속됨: 무조건 재생성하지 말고 8절의 배포·DB ID 확인 절차를 진행하세요.

`OK` 판정은 객체의 이름과 종류에 대한 존재 검사입니다. 같은 이름으로 잘못 만들어진 테이블이나 트리거의 내용까지 정상이라고 보증하는 검사는 아닙니다. 조회에 표시된 트리거의 `target_table`도 `system_users`인지 확인하세요.

Wrangler를 사용하는 경우 동일한 진단은 다음과 같습니다.

```sh
npx wrangler d1 execute milgyo-system-db --remote --file=database/AUTH_DIAGNOSE_MAIN_20261015.sql
```

## 5. 누락된 V97 인증 구조를 보완하세요

메인 기본 테이블이 정상이고 V97 인증 객체가 누락된 경우, 백업 후 다음 파일을 **같은 메인 DB**에 실행하세요.

```text
database/AUTH_REPAIR_MAIN_20261015.sql
```

가장 명확하게 파일 전체를 실행하는 방법은 저장소 루트에서 다음 명령을 사용하는 것입니다.

```sh
npx wrangler d1 execute milgyo-system-db --remote --file=database/AUTH_REPAIR_MAIN_20261015.sql
```

Cloudflare Console을 사용하는 경우에도 SQL 파일의 문장 순서대로 적용합니다. `CREATE TRIGGER … BEGIN … END;`는 하나의 완전한 문장으로 실행해야 합니다. 내부 `DELETE` 문장만 떼어 실행하면 안 됩니다. Console에서 여러 문장 처리가 제한되면 위의 `--file` 명령을 사용하세요.

파일 맨 앞의 두 `SELECT … LIMIT 0`은 필요한 메인 테이블·컬럼을 확인하는 용도입니다. 결과 데이터가 0행인 것은 정상입니다. 이 단계에서 `no such table`이나 `no such column`이 발생하면 중단하고 DB 선택과 기본 구조를 확인하세요.

이 보완 SQL의 본문은 원본 `0012_v97_security_sessions.sql`과 같습니다. `CREATE … IF NOT EXISTS`로 누락 객체만 추가하므로 적용 순간 기존 계정, 비밀번호, 문서, 기존 세션 행을 다시 쓰지 않습니다. 트리거 내부의 세션 삭제는 이후 계정의 비밀번호·권한·활성 상태 변경 또는 계정 삭제가 발생했을 때 동작하는 보안 기능입니다.

동일한 SQL을 다시 실행하는 경우 기존 인증 요청 제한 카운터도 초기화하지 않습니다. 다만 같은 이름의 객체가 잘못된 정의로 이미 존재한다면 이 파일이 그 정의를 교체하지는 않습니다.

실행 후 4절의 진단을 다시 실행해 6개 객체를 확인합니다.

**중요:** `--remote` 없이 로컬 DB에만 실행하면 운영 사이트는 복구되지 않습니다. 이 SQL은 `d1_migrations` 이력에 임의로 완료 기록을 넣지 않습니다. 따라서 향후 정식 마이그레이션 적용 과정에서 0012가 다시 실행될 수 있으나, 이 파일 자체는 중복 실행이 가능합니다. 이번 오류만 해결하려고 과거 미적용 마이그레이션 전체를 무조건 실행하지 마세요. 이전 SQL에는 별도 업무 데이터 변경이 포함될 수 있어 이력 검토가 필요합니다.

## 6. 수정 코드를 배포하세요

권장 파일은 `milgyo_system_auth_hotfix_20261015_CHANGED_ONLY.zip`입니다. 압축을 풀면 저장소 루트 기준의 `public/`, `src/`, `functions/`, `database/` 등이 나옵니다.

현재 GitHub의 `milgyo-system` 저장소와 비교해 동일한 경로에 병합하세요. 첨부 이후 별도 수정이 있었다면 해당 내용을 보존해야 합니다. ZIP 파일 자체를 GitHub에 올리는 것만으로 내부 소스가 반영되지는 않습니다. **압축을 푼 실제 파일을 각 경로에 반영하고 커밋해야 합니다.**

전체 소스가 필요한 경우 `milgyo_system_auth_hotfix_20261015_FULL.zip`을 사용할 수 있으나, 현재 저장소보다 오래된 첨부본을 바탕으로 한 부분이 없는지 비교 후 적용하세요.

가능한 빌드 환경에서 기존 프로젝트가 지정한 Node 버전을 사용해 아래를 실행합니다.

```sh
npm ci
npm run config:check
npm run verify
```

그다음 Cloudflare Pages의 `milgyo-system` 프로젝트에 새 배포를 생성하고, Production 도메인이 새 배포를 가리키는지 확인하세요. 바인딩이나 환경변수를 변경했다면 새 배포에 반영됐는지도 확인해야 합니다.

새 배포가 성공한 후 기존 작업 중인 내용은 따로 보관하고 로그인 페이지를 새로 여세요. 공통 스크립트 요청 주소는 다음 버전으로 바뀌어 있어야 합니다.

```text
/system-session.js?v=99-auth-20261015
```

사이트 전체 쿠키를 지우거나 데이터베이스를 초기화하는 작업은 이 수정의 필수 절차가 아닙니다.

## 7. 배포 후 확인 기준

첫 방문·로그아웃 상태의 로그인 페이지에서 노란 만료 알림이 없어야 합니다. 로그인 전 `/api/auth/session`의 `401 SESSION_REQUIRED`는 정상적인 비로그인 응답이며, 그 자체가 DB 장애를 뜻하지 않습니다.

기존 계정으로 로그인했을 때 `/api/auth/login`이 HTTP 200, `ok: true`를 반환하는지 확인하세요. 로그인 후의 `/api/auth/session`도 200이어야 합니다. 잘못된 비밀번호는 여전히 `401 INVALID_CREDENTIALS`가 되어야 하며, 보안 검사를 없애서 통과시키는 방식이 아닙니다.

기존 문서·대장·회계 화면이 열리는지, 미리보기 환경에서 실제 세션 만료 시 작성 중 입력값을 잃지 않고 재로그인 안내가 나오는지 확인하세요. 재로그인 후 기존 안내가 사라져야 합니다. 운영 자료로 강제 만료·수정 시험을 하지 말고 테스트 계정과 테스트 데이터로 확인하세요.

**최초 관리자 계정이 정말 없는 경우에만:** `system_users`의 계정 수가 0인지 확인한 뒤 별도로 초기 계정을 생성해야 합니다. 원본 코드는 `ADMIN_TOKEN`만 등록돼 있다고 초기 계정 생성을 허용하지 않습니다. `ENABLE_ADMIN_BOOTSTRAP=true`를 해당 환경에 임시 등록하고 재배포해야 하며, `ADMIN_TOKEN`은 32~256자이고 앞뒤 공백이 없어야 합니다. 초기 계정 생성 후에는 이 플래그를 제거하거나 `false`로 바꾸고 다시 배포하세요. 기존 계정이 있다면 이 절차는 필요하지 않습니다.

`ADMIN_TOKEN` 실제 값, 로그인 비밀번호, 쿠키는 공유하지 마세요.

## 8. SQL 적용 후에도 같은 문구가 보일 때

첨부 `wrangler.toml`에는 Production과 Preview의 D1 ID가 각각 지정돼 있습니다. 이 파일을 기준으로 배포하는 경우 대시보드의 표시 이름만이 아니라 **해당 `[[d1_databases]]`의 `binding = "DB"` 바로 아래 `database_id`**와 실제 메인 D1 상세의 ID를 대조하세요. 이름만 같고 ID가 다르거나, Preview에만 SQL을 실행한 경우를 구분해야 합니다. 이번 수정본은 그 ID를 임의로 변경하지 않았습니다.

브라우저 개발자 도구의 Network에서 실패한 `/api/auth/login` 응답의 `status`, `code`, `requestId`를 확인하세요. 요청 본문의 비밀번호나 Cookie 헤더는 캡처하지 마세요. 수정 후 서버 로그에는 인증 구조 문제일 때 `binding: DB`와 `migrations/main/0012_v97_security_sessions.sql` 경로가 함께 기록됩니다.

다른 코드가 나오면 같은 문제라고 단정하지 마세요. `INVALID_CREDENTIALS`는 계정 인증 실패, `BOOTSTRAP_DISABLED`는 초기 계정 생성 비활성, `SERVICE_UNAVAILABLE`는 추가 서버 진단이 필요한 상황입니다. `AUTH_SCHEMA_NOT_READY`와 구분해야 합니다.

## 9. 검증 결과와 남은 확인 범위

실제 실행한 로컬 회귀 테스트는 **173개 통과, 실패 0개**입니다. 그 안에 로그인·세션·인증 구조 관련 **88개**가 포함됩니다. 173개와 88개를 합산하는 것이 아닙니다.

원본 노란 알림의 재현, 수정 후 비로그인 알림 방지, 실제 만료 안내 유지, 로그인 복구, 쿠키 보안 속성, 잘못된 비밀번호 거부, 권한 변경에 따른 세션 폐기, SQL 중복 적용 시 기존 테이블 행 보존을 확인했습니다. DB 테스트에는 실제 SQLite 기반 D1 어댑터와 실제 인증 핸들러를 사용했습니다.

보안·인증 범위 TypeScript 검사(`tsconfig.security.json`)와 변경한 Astro 파일 내부 JavaScript 문법 검사도 통과했습니다. TypeScript 검사는 실행환경에 설치된 **5.8.3**을 사용했습니다. 프로젝트가 고정한 **5.9.3**으로 전체 빌드까지 검증한 결과는 아닙니다.

다음 항목은 완료하지 못했습니다.

- npm 레지스트리 DNS 접근 실패로 프로젝트 의존성 설치와 전체 Astro 빌드를 완료하지 못했습니다. 버전을 임의 변경하거나 낮추지 않았습니다.
- 외부 의존성 `fflate`가 필요한 `tax-accounting-regression.test.ts`는 이번 173개 실행 범위에서 제외했습니다.
- 로컬 Chromium 탐색이 실행환경 정책(`ERR_BLOCKED_BY_ADMINISTRATOR`)으로 차단돼 브라우저 통합 검증을 완료하지 못했습니다.
- 운영 Cloudflare의 D1·R2·배포 및 실제 사용자 계정에 접근하거나 변경하지 않았습니다.

따라서 “운영 배포 완료”나 “사이트 전체 무오류 보장”으로 해석하면 안 됩니다. Production 적용 완료 판단은 7절의 확인까지 마친 뒤 해야 합니다.

검증 원문은 `verification/auth-hotfix-20261015/`에 있습니다. 실패 상황을 의도적으로 재현하는 테스트의 서버 오류 로그가 일부 포함되며, 테스트 최종 합계의 실패 수와 구분해서 읽어야 합니다.

## 10. 되돌리기와 운영 주의사항

화면 코드에 문제가 생기면 이 패치의 애플리케이션 파일만 이전 커밋으로 되돌릴 수 있습니다. 추가한 인증 테이블·트리거를 제거하는 것을 기본 롤백 절차로 삼지 마세요. 이전 V97 인증 코드도 그 구조를 요구합니다.

이 SQL은 계정 초기화, 비밀번호 재설정, 회계 DB 수정 또는 업무자료 삭제를 수행하는 해결책이 아닙니다. 문제 해결을 위해 `system_users`나 DB 전체를 삭제하지 마세요.

## 공식 문서 확인 경로

Cloudflare 공식 문서의 Pages Functions Bindings, Wrangler Configuration, D1 Migrations, D1 Import/Export 및 Wrangler D1 Commands를 확인했습니다. 관련 주소는 다음과 같습니다.

```text
https://developers.cloudflare.com/pages/functions/bindings/
https://developers.cloudflare.com/pages/functions/wrangler-configuration/
https://developers.cloudflare.com/d1/reference/migrations/
https://developers.cloudflare.com/d1/best-practices/import-export-data/
https://developers.cloudflare.com/workers/wrangler/commands/d1/
```
