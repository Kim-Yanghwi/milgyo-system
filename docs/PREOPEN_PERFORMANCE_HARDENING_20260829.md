# 오픈 전 성능·안정성 보강 (2026-08-29)

## 적용 범위
이 문서는 직전 `milgyo-system-main-full-replacement-20260829.zip` 안정화본을 기준으로 추가한 오픈 전 성능 개선을 정리합니다. 회계 금액, 자동대사 점수식, 권한정책, 전자문서 데이터 형식은 유지하고 원격 DB 왕복과 첨부파일 메모리 사용을 줄이는 데 초점을 두었습니다.

## 1. 회계 거래내역 가져오기
- 최대 1,000행마다 실행되던 `external_key=?` 개별 중복조회를 제거했습니다.
- 외부키를 먼저 계산하고 기존 키를 80개 단위 `IN (...)` 조회로 모아 D1 batch 처리합니다.
- 동일 입력파일 안의 중복 외부키도 사전 제거합니다.
- 동시 업로드 경쟁상황은 `ON CONFLICT(external_key) DO NOTHING`으로 전체 실패를 방지합니다.
- 최종 `imported_rows`는 실제 batch에 커밋된 행 수를 다시 조회해 기록하므로 경쟁상황에서도 통계가 맞습니다.

## 2. 자동대사
- 최대 250건의 거래를 대상으로 배치 회계차원을 먼저 조회합니다.
- 기부금/지출결의/법인카드 후보 SQL에서 상태, 금액, 날짜범위, 회계구분, 회계조직, 재원, 카드 조건을 직접 필터링합니다.
- 후보조회는 최대 80개 statement씩 D1 batch로 처리합니다.
- 이미 다른 거래에 확정된 `matched_type + matched_id`는 후보 ID 기준으로 일괄 조회합니다.
- 같은 실행 중 자동확정된 대상은 메모리 Set에 즉시 예약하여 중복 자동확정을 막습니다.
- 기존 추천이 더 이상 유효하지 않으면 추천 필드를 지우고 `unmatched`로 복원합니다.
- 카드 환불 등 `direction='in'` 거래가 지출결의/카드지출로 자동대사되지 않도록 방향 가드를 명시했습니다.

## 3. 성능 인덱스
`migrations/accounting/0017_v83_preopen_performance_indexes.sql`을 추가했습니다.

- `idx_import_tx_match_target`
- `idx_donations_auto_match`
- `idx_resolutions_auto_match`
- `idx_card_transactions_auto_match`

SQLite `EXPLAIN QUERY PLAN`에서 대표 후보 조회 3종과 사용중 매칭키 조회가 모두 신규 인덱스를 사용하는 것을 확인했습니다. 이 마이그레이션은 인덱스만 추가하므로 `accounting_meta.schema_version`은 `2026-08-21.1` 그대로 유지합니다.

## 4. 첨부파일 다운로드
전자문서, 접수·발송, 대장관리 첨부파일의 현재 UI를 바이너리 다운로드 방식으로 변경했습니다.

- R2 객체: `R2ObjectBody.body`를 `Response`로 직접 스트리밍
- 기존 방식: `arrayBuffer() -> Base64 -> JSON -> atob() -> Blob`
- 신규 방식: `R2 stream -> HTTP binary -> Blob`
- D1에 남아 있는 구형 소용량 첨부는 바이너리 응답을 위해 Base64를 서버에서 디코딩하되, R2 정상경로에는 전체버퍼/Base64 변환이 없습니다.
- 외부 구형 호출 호환을 위해 `binary`를 보내지 않는 기존 JSON 응답은 유지합니다.

## 5. 검증 결과
- 변경 TypeScript 파일 개별 strict typecheck 통과
- 신규 오픈 전 성능 회귀테스트 4개 통과
- 관리화면 안정성 회귀테스트 7개 통과
- 회계 도메인 아키텍처 회귀테스트 21개 통과
- accounting base schema + 14개 migration(0004~0017) SQLite 순차 적용 성공
- `accounting_meta.schema_version = 2026-08-21.1` 유지 확인
- 신규 성능 인덱스 4개 생성 확인
- 대표 후보 SQL의 `EXPLAIN QUERY PLAN`에서 신규 인덱스 사용 확인
- 수정된 Astro inline JavaScript 및 public JavaScript 구문검사 통과

## 6. 배포 순서
1. Preview 회계 D1에 `0017_v83_preopen_performance_indexes.sql`을 먼저 적용합니다.
2. Preview에 소스를 배포합니다.
3. 500~1,000건 거래 가져오기, 100~250건 자동대사, 전자문서/접수·발송/대장 R2 첨부 다운로드를 확인합니다.
4. 결과건수와 자동대사 대상이 기존 기대값과 일치하면 Production 회계 D1에 0017을 적용합니다.
5. Production 소스를 배포합니다.

Cloudflare Wrangler를 사용하는 경우 프로젝트 루트에서 회계 DB migration 설정이 `migrations/accounting`으로 지정되어 있으므로 기존 운영 절차에 따라 ACCOUNTING_DB migration을 적용하면 됩니다. 인덱스 migration을 누락해도 코드의 업무결과가 달라지지는 않지만, 이번 성능개선 효과가 감소하므로 오픈 전 적용을 권장합니다.
