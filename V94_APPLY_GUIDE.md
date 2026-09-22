# Milgyo OS V94 사무총장 직인 적용 가이드

이번 패치는 전자문서 발신명의의 **사무총장 전용 직인 표시만 추가**합니다.

## 적용 파일
- `src/pages/index.astro`
- `public/secretary_general.png`
- `tests/v94-secretary-general-seal.test.ts`
- `scripts/check-v94-secretary-general-seal.mjs`
- `docs/V94_SECRETARY_GENERAL_SEAL_20260921.md`

## 동작 조건
다음 세 조건이 모두 만족될 때만 `사무총장` 마지막 글자 `장` 위치에 직인이 겹쳐 표시됩니다.

1. 발신명의 표시방식 = `담당부서장 직책만 표시`
2. 담당부서 = `사무처`
3. 표시 직책 = `사무총장`

다른 부서·다른 표시방식에는 영향을 주지 않습니다.

## 기존 관인 코드
기존 `data-stamp`, 관인 설정 DB, `organization-seal-official.png` 처리 코드는 수정하지 않았습니다.

## DB 및 Cloudflare
- D1 migration 없음
- R2 변경 없음
- `wrangler.toml` 변경 없음

## 로컬 확인
의존성 설치 전에도 다음 검사를 실행할 수 있습니다.

```powershell
node .\scripts\check-v94-secretary-general-seal.mjs
```

정상 결과:

```text
[v94] OK - secretary general seal is isolated and conditionally rendered.
```

의존성 설치가 가능한 환경에서는 기존 절차대로 추가 확인합니다.

```powershell
npm.cmd ci
npm.cmd test
npm.cmd run build
```

## 화면 확인
문서작성에서 담당부서를 `사무처`, 발신명의 표시방식을 `담당부서장 직책만 표시`로 선택하여 `사무총장`의 `장` 글자에 직인이 겹치는지 확인합니다. 작성 후 문서 상세 미리보기와 인쇄에서도 같은 위치인지 확인합니다.
