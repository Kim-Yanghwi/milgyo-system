# 종단관리시스템(system.milgyo.org) 배포 가이드

기존 milgyo-official-site와 완전히 분리된 Cloudflare Pages 프로젝트입니다.
공식 홈페이지 코드와 절대 섞지 마세요(같은 저장소에 넣지 않습니다).

## 이번 업데이트로 바뀐 것

1. **계정 로그인 체계** — 그동안 관리자 전체가 같은 ADMIN_TOKEN을 공유하던 방식에서,
   `회원전용공간`처럼 사람마다 아이디·비밀번호·직책·직급을 가진 개별 계정으로 바뀌었습니다.
   ADMIN_TOKEN은 "최초 관리자 계정을 만드는 마스터 키"로만 남아 있습니다.
2. **검토자/결재자 지정** — 문서를 작성할 때 검토자(선택)와 결재자(중요문서는 필수)를 계정 목록에서
   직접 지정합니다. 지정된 결재자만 해당 문서를 승인/반려할 수 있습니다(관리자 계정은 예외적으로 처리 가능).
3. **공문서 서식 개편** — 수신/경유/제목, 본문, 기안·검토·결재 라인 표, 발신명의와 관인(도장) 표시까지
   실제 행정기관 공문 형식에 가깝게 다시 그렸습니다.
4. **표 디자인 개선** — 결재대기함 등 목록 화면의 표 테두리를 뚜렷하게 하고 가로 폭을 넓혔습니다.
5. **상단 메뉴 활성화** — 홈/결재/문서대장/접수·발송 메뉴를 누르면 해당 화면으로 바로 이동합니다.
6. **첨부파일 업로드**(지난 업데이트 반영분) — 붙임 파일을 실제로 등록/다운로드할 수 있습니다.

## 배포 순서(코드 반영)

GitHub 저장소(`Kim-Yanghwi/milgyo-system`)에서 아래 파일들을 "연필 아이콘(Edit this file) → 전체선택 후
붙여넣기 → Commit" 방식으로 반영해 주세요. 새 파일은 "Add file → Create new file"로 만들면 됩니다.

**교체할 기존 파일**
- `docs/schema.sql`
- `functions/_shared/helpers.ts`
- `functions/api/documents/list.ts`
- `functions/api/documents/detail.ts`
- `functions/api/documents/create.ts`
- `functions/api/documents/decide.ts`
- `functions/api/documents/decide-batch.ts`
- `functions/api/documents/mark-sent.ts`
- `functions/api/documents/upload-attachment.ts`
- `functions/api/documents/attachment-data.ts`
- `functions/api/received/list.ts`
- `functions/api/received/create.ts`
- `src/pages/index.astro`

**새로 추가할 파일**
- `functions/api/auth/login.ts`
- `functions/api/auth/logout.ts`
- `functions/api/auth/bootstrap.ts`
- `functions/api/users/list.ts`
- `functions/api/users/create.ts`
- `functions/api/users/update.ts`

D1 데이터베이스는 별도 SQL을 다시 실행하실 필요가 없습니다. `functions/_shared/helpers.ts`의
`ensureTables()`가 앱이 실행될 때마다 새 테이블(`system_users`, `system_sessions` 등)과 `documents`
테이블의 새 컬럼(검토자·결재자·문서요지 등)을 자동으로 추가합니다.

## 배포 후 첫 번째로 해야 할 일 — 최초 관리자 계정 만들기

1. 사이트에 접속하면 로그인 화면이 나옵니다. "최초 관리자 계정이 아직 없으신가요?" 링크를 누르세요.
2. Cloudflare Pages 환경변수에 등록해 두신 `ADMIN_TOKEN`(마스터 키), 성명, 원하는 아이디, 비밀번호(8자 이상),
   직책(예: 이사장)을 입력하고 "관리자 계정 만들기"를 누릅니다.
3. 만들어진 아이디/비밀번호로 로그인하세요. 이 계정은 역할이 "관리자"이므로 로그인 후 상단의
   "계정관리" 버튼으로 나머지 직원들의 계정을 추가할 수 있습니다(성명/아이디/비밀번호/직책/직급/
   결재권 부여 여부를 지정).
4. 결재자로 지정될 사람(이사장, 사무총장 등)은 계정 생성 시 "결재자로 지정 가능" 체크박스를
   반드시 켜 주세요. 이 체크가 없으면 문서작성 화면의 결재자 목록에 나타나지 않습니다.

ADMIN_TOKEN은 이후에도 계정을 잃어버리거나 관리자가 아무도 없는 상황을 복구할 때 다시 쓸 수 있는
마스터 키로 남아 있으니, 안전한 곳에 따로 보관해 주세요.

## 접속 보호를 한 단계 더 강화하고 싶다면
원하시면 이미 쓰고 계신 Cloudflare Access를 `system.milgyo.org` 전체에 앱으로 추가해, 로그인 화면에
도달하기도 전에 이메일 인증을 한 번 더 거치도록 이중 보호할 수 있습니다. 필요하시면 알려주세요.

## 문서24 연동은 어떻게 되는가
행정기관 공문 송수신 자체는 말씀하신 대로 문서24를 그대로 쓰시면 됩니다. 이 시스템은 문서24를 대체하지
않고, 문서24로 주고받은 문서를 "접수·발송대장"에 수기로 한 줄 등록해 종단 자체 기록으로 남기는 역할만
합니다.

## 이번에는 넣지 않은 것(범위를 벗어난 온나라 전용 기능)
- 온나라의 열람범위/DRM/공유지정/임시저장 같은 대형 공공기관 전자결재 시스템 전용 관리 기능은
  소규모 종단 사용 목적에 비해 과도하다고 판단해 반영하지 않았습니다.
- 완성된 공문서를 PDF로 인쇄/다운로드하는 기능은 아직 없습니다(필요하시면 다음 단계로 추가해 드릴 수
  있습니다).
- 관인은 실제 직인 이미지가 아니라 화면상 붉은 원형 표시로 대체했습니다. 실제 관인 이미지를 스캔해
  올려 주시면 이미지로 교체해 드릴 수 있습니다.
