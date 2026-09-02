# V92 임명장·표창장 발급·대장

## 구현 기준
- 사용자 제공 `임명장 또는 표창장 양식`의 변수 메모를 기준으로 발급종류, 직위명, 종단/香天寺 선택, 임명 직위명, 발행주체를 입력·선택 가능하게 구성했습니다.
- 사용자 제공 `상장용지.png`를 그대로 A4 발급 배경으로 사용합니다.
- 임명장은 원문 본문을 유지하고 `본문 발행단위`와 `임명 직위명`만 입력값으로 치환합니다.
- 표창장은 본문을 직접 입력하며 줄바꿈을 그대로 미리보기·인쇄에 반영합니다.

## 지정 글꼴·크기
- 연번: 궁서체 14pt
- 제목: 궁서체 53pt
- 상단 직위, 성명, 불명, 본문: 궁서체 29pt
- 불기 및 년·월·일: 신명궁서 25pt
- 발행주체: 궁서체 25pt

웹 브라우저에서는 Windows에 설치된 `Gungsuh/궁서`, `ShinMyeongGungseo/신명궁서`를 우선 사용하고, 해당 글꼴이 없으면 명조 계열로 대체됩니다. 글꼴 파일 자체는 프로젝트에 포함하지 않습니다.

## 기능
- 임명장 / 표창장 종류 전환
- 연번 직접 입력
- 상단 직위명, 성명, 불명 입력
- 임명장: 종단/香天寺 선택 + 임명 직위명 입력
- 표창장: 자유 본문 입력
- 불기 연도·월·일 입력 (오늘 기준 불기 연도 자동 초기값, 직접 수정 가능)
- 발행주체: 이사장 / 香天寺 선택
- 원본 상장용지 기반 미리보기
- A4 인쇄 / PDF 저장
- 발급대장 저장, 조회, 상세 미리보기, 값 재사용, 취소, CSV
- 연번 중복 방지
- 관리자 발급·취소, 관리자/감사 발급대장 조회

## 배포 파일
- `src/pages/appointment-awards.astro`
- `src/layouts/ManagementLayout.astro`
- `functions/api/appointment-awards/action.ts`
- `functions/api/appointment-awards/query.ts`
- `migrations/main/0011_v92_appointment_award_certificates.sql`
- `public/certificates/appointment-award-paper.png`
- `tests/v92-appointment-award-ledger.test.ts`

## D1 migration
### Preview
```powershell
npx.cmd wrangler d1 migrations apply milgyo-system-db-preview-v2 --env preview --remote
```

### Production
```powershell
npx.cmd wrangler d1 migrations apply milgyo-system-db --remote
```

API에도 `CREATE TABLE IF NOT EXISTS` 방어 로직을 넣어 두었지만, 운영 이력 관리를 위해 정식 migration 적용을 권장합니다.
