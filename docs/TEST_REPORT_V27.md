# v27 검토본 사전검증 보고

검증일: 2026-07-29

## 완료한 검사

- TypeScript strict 검사: 성공
  - `functions/**/*.ts`
  - `workers/**/*.ts`
- 브라우저 JavaScript 문법검사: 성공
  - `public/accounting-generic-attachments.js`
  - 회계 Astro 페이지의 인라인 스크립트
- Astro 컴파일러 구문분석: 성공
  - `accounting.astro`
  - `accounting-special.astro`
  - `accounting-files.astro`
- SQLite 임시 DB 적용시험: 성공
  - v26 기본 스키마
  - v26 첨부파일 마이그레이션
  - v27 운영 마이그레이션
- 법인카드 계산·날짜 단위검사: 성공
  - 20,000원 → 세액 2,000원
  - 2026-07-31 → `(금)`
- 구문·정책 통합검사
  - 이전 `총액 ÷ 11` 계산식 잔존 여부 검사: 없음
  - 카드·수입지출결의 첨부 UI의 운영정책·권한 연계 확인
  - 관리자 화면 권한 선로딩 확인
- 확인 결과
  - 스키마 버전 `2026-07-29.1`
  - `accounting_attachments` 총 21개 컬럼
  - 운영정책·무결성·재처리 테이블 3개 생성

## 사용자 PC에서 필요한 최종검사

개발 컨테이너의 기존 `node_modules`가 Windows용으로 구성되어 Rollup Linux 선택 의존성을 불러오지 못했으므로, 전체 Astro 번들은 사용자 PC에서 다음 명령으로 최종 확인한다.

```powershell
npm.cmd run build
```

`[build] Complete!`가 출력된 경우에만 Git 커밋·푸시를 진행한다.
