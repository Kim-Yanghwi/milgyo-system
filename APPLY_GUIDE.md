# 종단관리시스템(system.milgyo.org) 배포 가이드

기존 milgyo-official-site와 완전히 분리된 새 Cloudflare Pages 프로젝트로 만드는 걸 전제로 작성했습니다.
공식 홈페이지 코드와 절대 섞지 마세요(같은 저장소에 넣지 않습니다).

## 무엇이 들어있는가
- `docs/schema.sql` — 전용 D1 스키마(documents, document_approvals, received_documents)
- `functions/_shared/helpers.ts` — 인증·결재로직 공용 헬퍼
- `functions/api/documents/*.ts` — 결재대기함/발송대기함/문서등록대장/완료·반려문서함을 움직이는 API
- `functions/api/received/*.ts` — 문서24 등 외부 송수신 문서를 수기로 등록하는 접수·발송대장 API
- `src/pages/index.astro` — 온나라 스타일 사이드바(전자문서/처리한문서/접수·발송) + 네이버웍스 느낌의 좌우 분할 기안작성 화면(왼쪽 입력폼, 오른쪽에 실제 공문서 서식이 실시간으로 그려짐)
- `package.json`, `astro.config.mjs`, `wrangler.toml` — 새 프로젝트 뼈대

## 배포 순서

1. **새 GitHub 저장소 생성** (예: `milgyo-system`). 이 폴더 내용을 그대로 커밋·푸시합니다.
2. **Cloudflare Pages에서 새 프로젝트 생성**: 방금 만든 저장소를 연결하고, 빌드 명령 `npm run build`, 빌드 출력 디렉터리 `dist`로 설정합니다(기존 공식 홈페이지 프로젝트를 만들 때와 동일한 방식입니다).
3. **D1 데이터베이스 생성**: Cloudflare 대시보드 → Workers & Pages → D1에서 `milgyo-system-db`(이름은 자유) 새로 생성. 그 다음 이 Pages 프로젝트 설정의 "Functions" → "D1 database bindings"에서 변수명 `DB`로 방금 만든 D1을 연결합니다.
4. **스키마 적용**: `wrangler d1 execute milgyo-system-db --file=docs/schema.sql --remote` 명령으로 표를 생성합니다(또는 대시보드의 D1 콘솔에서 SQL을 붙여넣어 실행).
5. **환경변수 설정**: Pages 프로젝트 설정 → 환경변수에서 `ADMIN_TOKEN`을 새로 만들어 등록합니다. 보안을 위해 공식 홈페이지의 ADMIN_TOKEN과는 **다른 값**을 쓰는 걸 권장합니다(문서·결재 시스템이 더 민감한 데이터를 다루기 때문).
6. **커스텀 도메인 연결**: Pages 프로젝트 설정 → Custom domains에서 `system.milgyo.org` 추가. milgyo.org가 이미 Cloudflare 네임서버를 쓰고 있으므로 버튼 한 번으로 DNS 레코드가 자동 등록됩니다(별도 수작업 불필요).
7. 배포가 끝나면 `https://system.milgyo.org`로 접속해 ADMIN_TOKEN으로 로그인, 테스트 문서를 하나 등록해 결재 흐름이 규정대로 동작하는지 확인합니다.

## 접속 보호를 한 단계 더 강화하고 싶다면
지금은 ADMIN_TOKEN 하나로 로그인하는 구조입니다(1인~소수 관리자 규모에 맞춘 단순한 방식). 원하시면 이미 쓰고 계신 Cloudflare Access를 `system.milgyo.org` 전체에 앱으로 추가해, ADMIN_TOKEN 입력 화면에 도달하기도 전에 이메일 인증을 한 번 더 거치도록 이중 보호할 수 있습니다. 필요하시면 알려주세요, Access 앱 설정까지 안내해드리겠습니다.

## 문서24 연동은 어떻게 되는가
행정기관 공문 송수신 자체는 말씀하신 대로 문서24를 그대로 쓰시면 됩니다. 이 시스템은 문서24를 대체하지 않고, 문서24로 주고받은 문서를 "접수·발송대장"에 수기로 한 줄 등록해 종단 자체 기록으로 남기는 역할만 합니다(제목, 상대방, 경로, 상대기관 문서번호, 일자를 입력하면 접수번호가 자동 부여됩니다).

## 다음 단계로 고려할 것 (이번 범위에서는 뺐습니다)
- 첨부파일 실제 업로드(R2 연동) — 지금은 "붙임" 항목에 텍스트 설명만 적습니다.
- 완성된 공문서를 PDF로 인쇄/다운로드하는 기능.
- 결재자별 개별 로그인(지금은 관리자 전체가 같은 ADMIN_TOKEN을 공유하고, 결재 시점에 결재자 성명을 직접 입력하는 방식입니다 — 소규모 조직에 맞춘 단순화입니다. 나중에 사람이 늘어나면 개별 계정 체계로 확장할 수 있습니다).
