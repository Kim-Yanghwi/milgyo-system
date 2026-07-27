# 회계 화면 첨부파일 UI 후속 구현 명세

## 공통 처리 흐름

1. 회계자료 저장 API를 먼저 호출합니다.
2. 저장 응답의 `id`를 화면 상태에 보관합니다.
3. 파일 선택 시 브라우저에서 Base64로 변환합니다.
4. `/api/accounting/upload-attachment`를 호출합니다.
5. 성공 후 `/api/accounting/list-attachments`를 다시 호출해 목록을 갱신합니다.
6. 다운로드 시 `/api/accounting/attachment-data`의 `dataBase64`를 Blob으로 변환합니다.
7. 삭제 후 목록을 다시 조회합니다.

## 업로드 요청 예시

```json
{
  "token": "로그인 세션 토큰",
  "referenceType": "resolution",
  "referenceId": "RES-자료식별번호",
  "fileCategory": "evidence",
  "fileName": "지출증빙.pdf",
  "mimeType": "application/pdf",
  "dataBase64": "Base64 본문"
}
```

## 목록 요청 예시

```json
{
  "token": "로그인 세션 토큰",
  "referenceType": "resolution",
  "referenceId": "RES-자료식별번호"
}
```

## 다운로드 요청 예시

```json
{
  "token": "로그인 세션 토큰",
  "attachmentId": 1
}
```

## 삭제 요청 예시

```json
{
  "token": "로그인 세션 토큰",
  "attachmentId": 1
}
```

## 화면별 권장 위치

- 수입·지출결의: 결의서 입력 영역 하단, 전자결재선 위
- 전표관리: 전표 상세 또는 전표행 확장영역
- 기부·후원: 기부금 등록 후 생성되는 상세영역
- 자산·비품: 자산 상세 및 처분 증빙영역
- 법인카드: 카드 사용내역 상세영역
- 사찰·교구 취합: 제출자료 입력영역 하단
- 결산·마감: 결산서 조회영역 상단 또는 월별 마감 상세

## 사용자 안내문

`파일은 4MB 이하, 자료별 최대 10개까지 등록할 수 있습니다. 실제 파일은 회계 전용 저장소에 보관됩니다.`
