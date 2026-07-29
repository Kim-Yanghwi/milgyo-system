# 밀교 시스템 운영 백업정책 v27

## 1. 대상

| 구분 | 운영자원 | 백업수단 |
|---|---|---|
| 전자문서·CMS·사용자 정보 | `milgyo-system-db` | D1 Time Travel + 정기 SQL export |
| 회계정보 | `milgyo-accounting-db` | D1 Time Travel + 정기 SQL export |
| 전자문서·CMS 파일 | `milgyo-system-files` | R2 외부 복제본 |
| 회계 첨부파일 | `milgyo-accounting-files` | R2 외부 복제본 + D1/R2 무결성 점검 |
| 프로그램 소스·설정 | Git 저장소와 배포 ZIP | 커밋·릴리스별 보관 |
| 비밀정보 | Cloudflare Secrets 등 | 값 자체는 일반 ZIP에 저장하지 않고 별도 비밀관리대장으로 복구절차만 관리 |

## 2. 백업주기와 보존

| 백업 | 주기 | 권장 보존 |
|---|---|---|
| D1 Time Travel | 플랫폼 제공 범위 내 상시 | 장애 직후 신속복구용 |
| D1 전체 SQL export | 매주 및 배포 직전 | 주간 8개, 월간 12개 |
| R2 외부 증분복제 | 매일 | 현재본 + 변경이력 1년 |
| 소스 릴리스 ZIP | 운영 배포마다 | 전체 보존 |
| 복구훈련 | 분기 1회 | 결과보고서 3년 |

## 3. 기본 원칙

- 운영계정과 동일한 장소의 데이터만으로 백업을 완료했다고 판단하지 않는다.
- R2 복제 시 운영 원본에서 삭제된 파일을 백업에서 즉시 삭제하지 않는다.
- D1 SQL, R2 파일, 소스코드를 동일한 백업시각으로 묶고 SHA-256 목록을 남긴다.
- 백업파일에는 `.env`, `.dev.vars`, API 토큰, 비밀번호를 포함하지 않는다.
- 백업 성공 여부가 아니라 실제 복원시험 성공 여부로 정책 준수를 판단한다.

## 4. 실행방법

D1과 소스만 백업:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\backup-production.ps1 -SkipR2
```

Rclone에 Cloudflare R2 S3 원격이 구성된 경우 D1·소스·R2 통합백업:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\backup-production.ps1 -RcloneRemote "milgyo-r2"
```

R2 백업은 `r2-current`를 운영 R2와 동일한 현재본으로 `sync`하고, 운영에서 삭제되거나 같은 키로 변경되는 기존 파일은 `--backup-dir`을 통해 `r2-history/<백업시각>`에 보존한다. 따라서 현재본은 운영상태와 일치하고 삭제·변경 전 파일은 이력에서 복구할 수 있다.

## 5. 복구 우선순위

### 단일 파일 유실

1. D1의 `object_key` 확인
2. R2 외부백업에서 같은 키의 파일 복원
3. 다운로드 시험
4. 전체 무결성 점검

### D1 오입력·대량삭제

1. 서비스 쓰기 중지
2. 오류시각 확정
3. Time Travel 또는 SQL export로 별도 시험 DB 복구
4. 정상성 확인 후 운영 DB 복원 여부 결정
5. R2 전체 무결성 점검

### 전체 장애

1. 소스 릴리스 복원 및 바인딩 재설정
2. D1 복원
3. R2 현재본 복원
4. D1/R2 전체 무결성 점검
5. 관리자·감사계정 권한시험
6. 서비스 재개

## 6. 운영점검표

- [ ] 최근 D1 export 2개가 존재하고 파일크기가 0보다 큼
- [ ] SHA256SUMS 검증 성공
- [ ] R2 현재본 백업일이 24시간 이내
- [ ] 실패한 Rclone 로그 없음
- [ ] 최근 분기 복구훈련 완료
- [ ] Cloudflare 바인딩 목록과 비밀관리대장 최신화
