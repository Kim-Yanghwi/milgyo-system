# 관리시스템 TypeScript 빌드 오류 TS2322 수정 안내 (2026-10-10)

## 대상 오류
`functions/_middleware.ts:43`에서 `new Request(request, { body: bytes })`가 TypeScript 5.9 DOM `BodyInit` 타입과 맞지 않는 문제.

## 수정 내역
`functions/_middleware.ts` 한 파일만 변경.

```diff
-      // Pages next(Request) forwards this bounded, replayable body to the endpoint exactly once.
-      const bounded = new Request(request, { body: bytes });
+      // readLimitedBody() allocates a new Uint8Array spanning its own ArrayBuffer.
+      // Forward the same validated bytes without another copy; ArrayBuffer is BodyInit in TS 5.9 DOM types.
+      const bounded = new Request(request, { body: bytes.buffer as ArrayBuffer });
```

`readLimitedBody()`는 `new Uint8Array(length)`로 읽은 데이터를 복사해 반환하므로 `bytes.buffer`는 공유 메모리가 아닌 전용 ArrayBuffer이며, byteOffset은 0이고 byteLength가 버퍼 전체와 같습니다. 따라서 신규 메모리 복사나 데이터 변경 없이 동일한 본문을 전달합니다.

## 적용 방법
`milgyo-system-main` 프로젝트 폴더의 `functions/_middleware.ts` 파일만 덮어씁니다. **package.json, package-lock.json, node_modules, DB/R2 마이그레이션 파일은 건드리지 마세요.** 앞서 수행한 보안 의존성 업데이트를 유지해야 합니다.

```powershell
npm.cmd run typecheck
```

성공했다면:

```powershell
npm.cmd run verify:release
$LASTEXITCODE
```

`0`인 경우에도 실제 Cloudflare Preview에서 로그인/로그아웃, JSON API 요청, 회계 첨부 multipart POST, 권한 검사를 반드시 확인한 뒤 운영에 반영하세요. 자동 검사만으로 운영 안전성을 보증할 수 없습니다.

검사를 통과하기 위해 `tsconfig.check.json`에서 검사를 해제하거나 `skipLibCheck` 설정으로 오류를 숨기지 마세요.
