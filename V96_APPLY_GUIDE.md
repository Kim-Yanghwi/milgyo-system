# Milgyo OS V96 사무총장 직인 위치 2차 조정 가이드

이번 패치는 V95보다도 더 오른쪽으로 이동시키는 **2차 미세조정**입니다.
기존 조건부 표시 로직, 직인 코드, 파일명, 자산, 데이터 구조는 그대로 유지합니다.

## 조정 내용
- 미리보기 CSS: `.secretary-general-seal` 의 `right` 값을 `-1.02rem` → `-1.38rem` 으로 재조정
- 인쇄 CSS: `.secretary-general-seal` 의 `right` 값을 `-20px` → `-28px` 으로 재조정
- 목적: `총장`을 덜 가리고, `장`의 `ㅏ`,`ㅇ` 부분에만 더 가깝게 걸치도록 보정

## 포함 파일
- `src/pages/index.astro`
- `public/secretary_general.png`
- `tests/v94-secretary-general-seal.test.ts`
- `scripts/check-v94-secretary-general-seal.mjs`
- `docs/V94_SECRETARY_GENERAL_SEAL_20260921.md`

## 적용 방법
- 전체 적용: `milgyo-system-v96-secretary-general-seal-position-2.zip`
- 패치만 적용: `milgyo-v96-secretary-general-seal-position-2-patch.zip`

## 확인 방법
1. 문서작성 진입
2. 담당부서 = `사무처`
3. 발신명의 표시방식 = `담당부서장 직책만 표시`
4. 미리보기에서 직인이 이전보다 더 오른쪽으로 이동했는지 확인
5. 강력 새로고침(Ctrl+F5) 후 재확인
