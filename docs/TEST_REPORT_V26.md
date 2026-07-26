# v26 점검결과

점검일: 2026-07-26

## 1. 정적 검사

- TypeScript 검사: 통과
- 회계관리·특화회계·전자문서 페이지 인라인 JavaScript 문법검사: 통과
- Astro 컴파일러 페이지 파싱: 통과
- SQL 바인딩 개수·준비검사: 통과

## 2. 데이터베이스 검사

### 신규 회계 DB 전체 초기화

- 회계 테이블: 24개
- 계정과목: 34개
- 회계연도: 5개
- 회계구분: 3개
- 재원: 4개

### 사용자가 이미 적용한 23개 기본 테이블에서 v26 마이그레이션

- 마이그레이션 전: 23개
- 마이그레이션 후: 24개
- 스키마 버전: `2026-07-26.4`
- 기존 전표 기반 월별 집계 재작성: 성공

### 기존 문서 DB

- `accounting_outbox` 생성: 성공
- 상태·재시도·문서별 조회 인덱스: 성공

## 3. 전자결재·회계 연계 단위시험

시험 흐름:

```text
결의서 생성 이벤트
→ 승인 이벤트
→ 회계전표·분개·월별 집계 생성
→ 같은 이벤트 재실행
```

결과:

```json
{
  "journals": 1,
  "lines": 2,
  "summaries": 2,
  "outbox": {
    "pending": 0,
    "processing": 0,
    "succeeded": 2,
    "failed": 0
  }
}
```

동일 이벤트를 다시 처리해도 전표·분개·집계가 중복 생성되지 않았습니다.

## 4. API 통합시험

다음 시나리오를 실제 API 함수와 SQLite 기반 D1 모의환경으로 실행했습니다.

- 기안자·결재자 동일 즉시승인
- 별도 결재자 승인
- 반려
- 일괄 승인
- 수동전표
- 역분개
- 기부금 전표
- 법인카드 전표
- 회계 대시보드
- 합계잔액시산표
- 종단 특화회계 통계

결과:

```json
{
  "documents": 5,
  "resolutions": 5,
  "journals": 8,
  "monthlyRows": 9,
  "totalDebit": 964000,
  "totalCredit": 964000,
  "outbox": [
    {"status": "succeeded", "count": 9}
  ]
}
```

차변·대변 합계가 일치했습니다.

## 5. 장애·재처리 시험

1. 회계 DB 스키마가 없는 상태에서 연계 처리
2. 실패 상태와 오류내용 저장 확인
3. 회계 스키마 초기화
4. 관리자 재처리 수행

결과:

```json
{
  "initialSchemaFailure": true,
  "retry": {"processed": 1, "failed": 0},
  "outbox": {"pending": 0, "processing": 0, "succeeded": 1, "failed": 0}
}
```

문서 DB의 승인자료는 유지되고 회계 연계만 재처리됐습니다.

## 6. 전체 Astro 빌드 관련

이 작업환경은 사용자 ZIP에 포함된 Windows용 `node_modules`를 Linux에서 사용하고 있으며 외부 npm 네트워크가 제한돼 Rollup의 Linux 선택 패키지를 설치할 수 없었습니다. 따라서 이 환경에서는 `astro build` 전체 실행을 완료하지 못했습니다.

대신 다음 검사는 모두 통과했습니다.

- TypeScript 전체 검사
- Astro 페이지 구문 파싱
- 인라인 JavaScript 검사
- 신규·기존 스키마 SQL 실행
- 회계 연계 단위시험
- 주요 API 통합시험
- 장애 복구시험

배포 전 사용자 Windows 환경에서 다음을 반드시 실행해야 합니다.

```powershell
npm.cmd install
npm.cmd run build
```

`[build] Complete!` 확인 후 배포합니다.
