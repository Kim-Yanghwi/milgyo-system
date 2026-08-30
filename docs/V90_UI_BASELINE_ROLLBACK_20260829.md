# V90 UI baseline rollback and sidebar stabilization — 2026-08-29

## 목적
Preview에서 확인된 세 가지 문제를 수정하되, 최초 소스의 기능 배치·버튼 크기·폰트·간격·화면 구조는 더 이상 재설계하지 않는다.

## 변경 원칙
1. `src/styles/system-ui.css`는 최초 업로드 소스와 바이트 단위로 동일하게 복원.
2. `ManagementLayout.astro`의 시각 CSS는 최초 업로드 소스와 동일하게 복원.
3. 전자문서 메인 `index.astro`의 시각 CSS는 날짜 기간 묶음 규칙을 제외하고 최초 업로드 소스와 동일하게 복원.
4. 대장관리/수계증서 화면은 기존 타이포그래피·정렬·버튼 배치를 복원하고, 명시적으로 요청된 `시작일 ~ 종료일` compact 묶음만 유지.
5. 성능·보안·DB 정합성·상태 즉시 갱신·세션 최신화 같은 비시각 기능 수정은 유지.

## 1. 직인 위치
- 화면 미리보기: 최초 위치/크기 복원
  - `right: -0.45rem`
  - `bottom: -0.55rem`
  - `40 x 40px`
  - `z-index: 1`
- 인쇄 미리보기: 최초 위치/크기 복원
  - `right: -8px`
  - `bottom: -9px`
  - `46 x 46px`
- 기본 직인 이미지는 `organization-seal-official.png`를 계속 사용하여 직인 미표출 문제는 재발하지 않도록 함.

## 2. UI/UX 원상복구
다음 V89 시각 재설계를 제거함.
- 전자문서 필터 전체 강제 `nowrap`
- 필터 영역 `width:100%` 강제
- 가로 스크롤 강제
- 각 select의 인위적인 최대폭 제한
- 검색칸 280px → 220px 축소
- 수계증서 필터 영역을 기본 상태부터 2열/세로 방향으로 변경한 규칙
- 대장관리 화면의 1180px 이하 강제 2행 전환 규칙
- 전역 `filter-date-range` 재설계 CSS

유지한 명시 요청:
- 기간검색의 시작일/종료일은 하나의 묶음
- 날짜 칸은 약 145px로 축소
- 별도 요일 배지 없이 native 날짜 입력 사용
- 날짜 묶음은 검색칸 앞에서 같은 toolbar에 위치

## 3. 햄버거 메뉴
원래의 sidebar 축소 CSS는 그대로 유지하고, 토글 JS만 상태를 명시적으로 관리함.
- `aria-expanded` 갱신
- 메뉴 접기/펼치기 label 갱신
- Main/Management 페이지 모두 같은 방식으로 sidebar class만 토글
- 다른 버튼/필터/폰트/상단 메뉴 CSS는 변경하지 않음

## 4. 유지되는 비시각 수정
- 문서 처리 후 stale dashboard/list 응답 방지
- 문서 처리 후 즉시 최신 목록/수량 조회
- D1 세션 기반 최신 사용자/부서 정보 반영
- PBKDF2 Cloudflare runtime 호환
- D1 migration/bootstrap 안정화
- 회계 대량처리/자동대사 set-based 최적화
- R2 첨부 binary streaming
- CSV formula injection 방어
- KST 날짜 조회 및 입력 검증

## DB
V90에는 DB migration이 없다.

## 검증
- `system-ui.css`: 최초 소스와 exact match
- `public/milgyo-date-input.js`: 최초 소스와 exact match
- `ManagementLayout.astro` style block: 최초 소스와 exact match
- `index.astro` style block: 날짜 기간 묶음 규칙 외 최초 소스와 exact match
- 직인 screen/print geometry 원본값 확인
- Main/Management hamburger reversible state 확인
- 변경된 inline JS 4개 syntax check 통과
- V90 UI 회귀 assertions 16/16 통과(로컬에서 TS 타입 표기만 제거한 동등 Node 테스트)

최종 `npm.cmd run verify`는 사용자의 설치 완료된 로컬 환경에서 실행할 것.
