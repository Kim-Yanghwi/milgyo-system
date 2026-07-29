# v27 롤백 절차

## 1. 소스 배포만 실패한 경우

Cloudflare Pages에서 직전 성공 배포로 롤백하거나 Git에서 직전 커밋을 되돌린다.

```powershell
git revert HEAD
git push
```

v27 마이그레이션으로 추가된 컬럼과 테이블은 기존 코드에 영향을 주지 않으므로 즉시 삭제하지 않는다.

## 2. 정기점검 Worker만 중지

```powershell
npx.cmd wrangler delete milgyo-accounting-maintenance
```

또는 `wrangler.accounting-maintenance.toml`의 cron을 빈 배열로 바꾸어 재배포한다.

```toml
[triggers]
crons = []
```

## 3. D1 데이터 오류 발생

1. 회계자료 입력을 즉시 중지한다.
2. 오류 발생 직전의 Time Travel 시각 또는 북마크를 확인한다.
3. 영향범위를 검토한 뒤 전체 DB 복원이 필요한 경우에만 Time Travel을 사용한다.
4. 복원 후 R2와 D1의 전체 무결성 점검을 실행한다.

D1 전체 복원은 정상적으로 입력된 다른 자료까지 함께 되돌릴 수 있으므로 단일 행 오류에는 사용하지 않는다.

## 4. R2 객체 오류 발생

- D1 메타정보는 정상이고 R2 파일만 사라졌다면 외부 R2 백업에서 해당 객체만 같은 `object_key`로 복원한다.
- R2에만 남은 파일은 관리자 점검목록에서 확인 후 삭제 또는 예외 승인한다.
- 복원 후 `/accounting-files/`에서 전체점검을 실행한다.
