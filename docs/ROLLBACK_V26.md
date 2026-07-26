# v26 롤백 안내

## 롤백이 필요한 상황

- 배포 후 회계관리 접속이 지속적으로 실패
- 전자결재 승인 시 서버 오류 발생
- `/api/health`에서 `accountingDatabase: false`
- 회계연계 실패가 반복되고 재처리로 복구되지 않음

## 1. 즉시 조치

Cloudflare Pages의 Deployments에서 v26 직전 정상 배포를 선택하여 Rollback 합니다.

```text
Workers & Pages
→ milgyo-system
→ Deployments
→ 직전 정상 배포
→ Rollback to this deployment
```

## 2. 데이터베이스 처리

v26 마이그레이션은 기존 자료를 삭제하지 않습니다. 롤백을 위해 테이블을 제거할 필요가 없습니다.

- `accounting_outbox`: 그대로 보관
- `accounting_monthly_summary`: 그대로 보관
- 추가 인덱스: 그대로 보관
- 기존 DB의 과거 회계 테이블: 삭제하지 않음

직전 코드가 새 테이블을 사용하지 않으므로 테이블이 남아 있어도 기존 운영에 영향을 주지 않습니다.

## 3. 연계대기 자료 처리

롤백 기간 중 생성된 회계 결의는 기존 코드와 새 코드의 저장위치가 다를 수 있으므로 SQL로 임의 삭제하지 않습니다. v26 재배포 후 관리자 재처리 기능으로 처리합니다.

상태 확인:

```sql
SELECT status, COUNT(*) AS count
FROM accounting_outbox
GROUP BY status;
```

실패내역 확인:

```sql
SELECT id,event_type,document_id,attempt_count,last_error,updated_at
FROM accounting_outbox
WHERE status='failed'
ORDER BY updated_at DESC;
```

## 4. 전체 DB 복구가 필요한 경우

전체 자료 훼손이 확인된 경우에만 Cloudflare D1 Time Travel 또는 배포 전 SQL 백업을 사용합니다. 정상 자료가 추가된 뒤 과거 시점으로 복구하면 그 이후 입력자료가 사라질 수 있으므로 반드시 별도 백업 후 진행합니다.
