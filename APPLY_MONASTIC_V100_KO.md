# 대한불교밀교종 종단관리시스템 — 승적증명서·승적원부 V100 추가 기능 적용 안내

**대상:** `system.milgyo.org` — 사용자 제공 `milgyo-system-main.zip` 소스 기준 2026-10-18  
**종류:** 관리자용 신규 기능 2개. 기존 홈페이지(`milgyo.org`) 또는 기존 종단관리시스템 계정·기존 문서대장을 교체하지 않습니다.

## 1. 화면과 메뉴

| 구분 | 메뉴 위치 | 주소 | 핵심 기능 |
|---|---|---|---|
| 승적증명서 발급·대장 | 재직증명서 발급·대장 **아래**, 수계증서 발급·대장 **위** | `/monastic-certificates` | 승적원부 재적 승려 선택, 발급번호, 발급 당시 데이터 고정, 발급대장, 취소·재인쇄, A4 출력 |
| 승적원부 대장 | 공고·관인·인영 대장 **아래**, 업무용 차량 관리대장 **위** | `/monastic-register` | 승적 취적·정정, 변경 이력, 수계 및 경력, 증빙 PDF/HWPX 등, R2/D1 저장 및 다운로드, A4 2면 내부 문서 출력 |

기존 종단관리시스템과 같은 사이드바·표·입력 구성·날짜 선택 방식을 사용합니다. 승적증명서는 기존 재직증명서와 **동일한 파일** `/certificates/logo-sq.png`, `/organization-seal.png`을 사용하며, 직인은 `right:-62px;top:2px;width:98px;height:98px` 위치에서 발급권자 표기와 겹칩니다. 발급 전 *미리보기*에는 '미리보기·미발급' 표시와 직인 숨김을 적용합니다. 발급된 출력물에만 직인이 표시됩니다.

**보안·정확성:** 승적원부와 발급 API는 서버에서 **현재 유효한 관리자(`admin`) 세션**을 확인합니다. 화면을 열 수 있는 것과 데이터 조회 권한은 별개이며, API가 인증·권한을 검사합니다. 계정의 실제 `position`이 `이사장` 또는 `이사장 직무대리`일 때만 해당 직함으로 발급 가능합니다. 원부 상태가 `재적`이 아니거나 성명·증명일 등이 부족하면 발급되지 않습니다.

## 2. 변경 파일

### 기존 파일 수정 (2개)

- `src/layouts/ManagementLayout.astro` — 두 메뉴를 정확한 위치에 추가
- `src/pages/index.astro` — 메인 시스템 화면의 사이드 메뉴에도 동일하게 추가

### 신규 파일

- `src/pages/monastic-register.astro`
- `src/pages/monastic-certificates.astro`
- `functions/_shared/monastic.ts`
- `functions/api/monastic-registry/action.ts`
- `functions/api/monastic-registry/query.ts`
- `functions/api/monastic-registry/upload-attachment.ts`
- `functions/api/monastic-registry/attachment-data.ts`
- `functions/api/monastic-registry/delete-attachment.ts`
- `functions/api/monastic-certificates/action.ts`
- `functions/api/monastic-certificates/query.ts`
- `migrations/main/0013_v100_monastic_registry.sql`
- `tests/v100-monastic-management.test.ts`

기존 `wrangler.toml`, 인증 기능, 원래 D1 테이블, 회사 인감 이미지, 기타 대장, 기존 페이지, 기존 사용자 데이터는 수정하지 않습니다.

## 3. 배포 순서 — 순서를 바꾸지 마세요

1. **운영 보호:** Cloudflare Pages에서 현재 성공한 배포 ID를 기록합니다. D1 메인 DB와 R2 버킷 데이터는 Cloudflare 대시보드에서 백업·내보내기 등으로 백업한 다음 시작합니다. 이 기능은 **기존 데이터를 삭제하는 마이그레이션을 사용하지 않습니다.** 다만 운영 이전에 백업은 필요합니다.
2. **Git 브랜치:** GitHub `milgyo-system` 저장소에서 현재 사용하는 정상 브랜치로부터 작업 브랜치 `feature/monastic-v100`을 만듭니다. **`milgyo-official-site`가 아닌** `system.milgyo.org`용 저장소에 적용하세요.
3. **파일 반영:** `CHANGED_ONLY.zip`의 디렉터리 구조를 유지하여 작업 브랜치에 병합합니다. 기존 파일 2개에 다른 변경이 있다면 비교 후 충돌을 해결합니다. **ZIP 전체를 운영 저장소에 통째로 덮어쓰지 마세요.**
4. **Preview D1 마이그레이션:** 아래 명령을 실행하기 전 적용 목록을 확인합니다. Preview DB는 `milgyo-system-db-preview-v2`이고, 바인딩 변수명은 `DB`입니다. 기존의 다른 마이그레이션이 대기 중이면 이를 확인하고 진행하세요.
5. **Preview 빌드:** GitHub 작업 브랜치와 연동된 Cloudflare Pages Preview 빌드/배포를 확인하고, 테스트 데이터(실제 개인정보 금지)로 승적원부 → 증명서 발급 → 취소·R2 증빙을 시험합니다. 서체·로고·직인 겹침·A4 출력은 실제 브라우저 인쇄 미리보기에서 육안 점검하세요.
6. **Production 적용 직전:** 운영 DB 백업을 재확인합니다. **Production D1에 동일 신규 마이그레이션을 먼저 적용**하고, 성공을 확인한 뒤 검증된 코드 브랜치만 운영 브랜치에 병합합니다.
7. **운영 확인:** 새 메뉴 2개, 관리자 계정 발급 및 일반 사용자 API 거부, D1 기록, R2 저장·다운로드, 취소 상태 표시를 다시 점검합니다. 이상 시 Cloudflare Pages 코드를 이전 성공 배포로 롤백하며, 새 D1 테이블은 임의 삭제하지 마세요(데이터가 남을 수 있습니다).

### D1 적용 명령 (저장소 최상위 폴더에서)

다음 명령은 Cloudflare Wrangler를 사용할 수 있고 계정 인증이 완료된 환경에서 실행합니다. Windows PowerShell/명령 프롬프트에서는 `npx` 대신 `npx.cmd`로 실행할 수 있습니다.

**Preview 목록 및 적용:**

```bash
npx wrangler d1 migrations list milgyo-system-db-preview-v2 --env preview --remote
npx wrangler d1 migrations apply milgyo-system-db-preview-v2 --env preview --remote
```

**Production 목록 및 적용:**

```bash
npx wrangler d1 migrations list milgyo-system-db --remote
npx wrangler d1 migrations apply milgyo-system-db --remote
```

`wrangler.toml`의 `DB` 바인딩 및 `migrations/main` 설정을 사용합니다. **회계 DB `ACCOUNTING_DB`를 대상으로 실행하지 마세요.** 적용 목록에 `0013_v100_monastic_registry.sql`이 나타나는지 확인하고, 적용 완료 메시지를 보관하세요.

> DB 마이그레이션을 실행하지 않은 상태에서 화면만 배포하면 새 테이블이 없어 API 500 오류가 날 수 있습니다. 정식 순서대로 적용하는 것이 필수입니다.

## 4. 기존 R2/D1 저장장치

- 운영: `DB` → **기존** `milgyo-system-db`; `FILES` → **기존** `milgyo-system-files`.
- Preview: `DB` → `milgyo-system-db-preview-v2`; `FILES` → `milgyo-system-files-preview`.
- 메인 D1에 신규 테이블 4개(원부, 변경이력, 첨부 메타데이터, 발급대장)와 인덱스만 추가합니다.
- 증빙은 기존 비공개 `FILES` R2에 저장하며, 바인딩이 없는 경우에만 **1.2MB 이하**의 증빙에 대해 기존 방식의 D1 소형 파일 저장을 지원합니다. 4MB까지 업로드할 수 있지만 **4MB 초과 및 확장자·파일 시그니처 불일치는 거부**합니다. 원부별 증빙 최대 10개입니다.
- 별도의 R2 공개 도메인, Cloudflare Access **Bypass**, 외부에서 접근 가능한 파일 URL, 관리자 보안 완화는 **추가하지 마세요.** 증빙은 관리자 인증 후 API 다운로드 방식만 제공합니다.

## 5. 서식 대응과 중요한 한계

**승적증명서(대외용, 서식 02):** 발급번호, 법명, 성명(속명), 승적번호·상태, 소속 종단, 소속 사찰, 취득일, 확인 기준일, 제출 용도, 발급일, 발급권자, 발급기관 연락처 및 문서 진위확인 고지와 단서를 포함합니다. 개인 생년월일·개인 연락처·내부 수계·법계 이력은 **증명서에 포함하지 않습니다**. 과거 발급본은 발급 당시 스냅샷을 저장합니다. 이는 타 종단 승적 또는 국가자격 증명이 아닙니다.

**승적원부(비공개, 서식 01):** 기본 신원·재적, 수계·법계, 경력, 변경·정정 이력, 근거 증빙, 접근권한·보존관리, 작성·검토·승인을 전산 기록합니다. 원부 출력도 2개 면으로 나눕니다. 원부번호와 승적번호를 구분해 관리하고 기존 증명서와 연결합니다.

서식 DOCX/PDF를 기반으로 HTML/A4 출력 화면을 구현한 것입니다. **DOCX 파일을 원형 그대로 편집하는 기능이나 픽셀 단위 동일성을 보장하는 기능은 아닙니다.** 최종 색상·줄바꿈·인감 중첩은 Preview 브라우저의 A4 인쇄 미리보기로 실물 대조해 주세요. 시스템의 발급 스냅샷과 인쇄본은 서버가 발급한 경우에만 정식 기록으로 취급합니다.

**보호 대상 정보:** 승적원부에는 생년월일, 종교 소속 및 수계 이력 등 민감한 정보가 포함됩니다. 실제 기록 입력 전 내부 관리권한, 동의·법적 처리근거, 처리 목적, 보존기한, 접근·삭제 절차를 기관의 책임 하에 확인해야 합니다. 서버는 처리근거 입력을 요구하지만 그 근거의 실질적 적법성을 자동 검증하지는 않습니다. 종교 관련 정보나 개인정보를 일반 사용자에게 공개하는 API는 추가하지 않았습니다.

## 6. 사전 검증 결과 (로컬 환경)

- **새 기능 SQLite 실제 DB 통합 테스트: 10개 모두 통과.** 관리자 권한 및 세션, 잘못된 입력·중복, 발급번호·발급 시점 기록, 타 직함 오발급 차단, 제적 발급 거부, 4MB 파일 검증, R2/D1 첨부파일, 부적법 접근 차단, 변경이력, 메뉴 위치 검증.
- **신규 TypeScript 함수 타입 검사: 통과.** `tsc`를 통해 공유 타입과 API를 묶어 검사.
- **두 화면의 브라우저 JS 문법 검사: 통과.**
- **전체 기존 마이그레이션 체인을 SQLite에 적용:** DB `PRAGMA integrity_check`가 `ok`, `foreign_key_check` 0건.
- **기존+신규 회귀 시험(일부 도구 부족으로 부분 실행):** 179개 중 178개 통과, 1개 원본 업로드에 없는 **기존 V91 외국어 HWPX 양식 파일 경로** 문제로 실패. 이번 두 기능과 무관한 기존 파일 누락 문제입니다. 기타 의존성이 필요한 기존 테스트 2개는 이 실행환경에서 수행하지 못했습니다.
- **아직 검증되지 않은 사항:** 전체 `npm run build`/Astro 생성물, Cloudflare 실제 Preview/Production, 실제 D1/R2 바인딩, 브라우저 A4 인쇄 렌더링, 기존 운영 데이터와의 호환성. 로컬 `npm ci`가 시간 초과되어 의존성이 설치되지 않았으므로 이 부분을 100% 완료로 표현할 수 없습니다.

실제 GitHub Actions 또는 Cloudflare Preview에서 다음을 실행하고 **모두 성공할 때만 운영 병합**하세요.

```bash
npm ci
npm run typecheck
npm test
npm run build
```

## 7. Preview 필수 수동 체크 (실제 개인정보 사용 금지)

1. 대장 메뉴 2개가 요구한 정확한 위치에 표시되는가?
2. 일반 사용자로 새 두 API에 POST하면 **403**이며 개인기록이 반환되지 않는가?
3. 관리자 테스트 계정으로 승적원부 등록 → 같은 승적번호 중복 409 → 정정이력 누적·승적번호 불변인가?
4. 수계 기록, 경력 기록, 증빙 PDF/HWPX 첨부 → R2 저장 → 다운로드 바이트 동일 → 삭제 이력이 남는가?
5. `재적`인 테스트 원부만 증명서 발급 가능한가? 성명(속명) 없거나 제적·기타 상태면 차단되는가?
6. 실제 계정 직위가 이사장/이사장 직무대리와 일치할 때만 발급 가능한가?
7. 증명서 발급 직전 미리보기에 워터마크가 있고 직인이 나타나지 않는가? 발급 후 A4에는 로고 옵션, 직인 겹침, 날짜와 표가 정상인가?
8. 발급한 후 원부의 법명·사찰을 바꾸어도 과거 출력 및 발급대장이 발급 당시 값을 표시하는가?
9. 취소한 발급본 재인쇄 시 **발급취소** 표시가 나타나는가?
10. 기존의 재직증명서·공고대장·수계증서·차량대장과 기존 D1/R2 자료가 동일하게 작동하는가?

**실제 운영 사용 전, 내부 책임자가 개인정보·종교 정보 보안 점검과 서식 최종 승인을 마치는 것을 권장합니다.**
