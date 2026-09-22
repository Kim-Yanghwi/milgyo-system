# Milgyo OS V95 사무총장 직인 위치 미세조정 가이드

이번 패치는 V94에서 추가한 사무총장 직인의 **겹침 위치만 오른쪽으로 미세 조정**합니다.
기존 직인 코드, 조건부 표시 로직, 파일명, 자산, 데이터 저장 구조는 변경하지 않습니다.

## 조정 내용
- 미리보기 CSS: `.secretary-general-seal` 의 `right` 값을 `-0.72rem` → `-1.02rem` 으로 조정
- 인쇄 CSS: `.secretary-general-seal` 의 `right` 값을 `-13px` → `-20px` 으로 조정
- 목적: `사무총장` 텍스트에서 `총장`을 과도하게 가리지 않고, 마지막 글자 `장`의 `ㅏ`, `ㅇ` 부분에만 직인이 걸치도록 보정

## 포함 파일
- `src/pages/index.astro`
- `public/secretary_general.png`
- `tests/v94-secretary-general-seal.test.ts`
- `scripts/check-v94-secretary-general-seal.mjs`
- `docs/V94_SECRETARY_GENERAL_SEAL_20260921.md`

## 적용 방법
### 1) 전체본 사용
- `milgyo-system-v95-secretary-general-seal-position.zip` 전체를 배포 소스로 사용

### 2) 패치만 적용
- 이 ZIP의 파일들을 기존 프로젝트에 덮어쓰기

## 확인 방법
1. 문서작성 진입
2. 담당부서 = `사무처`
3. 발신명의 표시방식 = `담당부서장 직책만 표시`
4. 미리보기에서 `사무총장`의 마지막 글자 `장` 오른쪽 부분에만 직인이 겹치는지 확인
5. 문서 상세/인쇄 화면에서도 동일한지 확인

## 참고
브라우저 캐시가 남아 있으면 이전 위치처럼 보일 수 있으니 배포 후 강력 새로고침(Ctrl+F5)을 권장합니다.
