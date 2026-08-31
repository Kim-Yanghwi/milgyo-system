# milgyo-system V91 복구 재구성본

- 기준 전체본: V90.1 full replacement (2026-08-30)
- 추가 근거: 사용자가 재업로드한 외국인 관련 원본 HWPX 3종
- 복구 경로: `/foreign-applications`
- DB migration: `0010_v91_foreign_application_forms.sql`
- schema marker: `2026-08-30.1`

이 파일은 삭제된 과거 V91 patch의 바이트 단위 복원본이 아니다.
V90.1 전체본, 대화에서 확인된 V91 구조 단서, 사용자 제공 원본 HWPX를 결합한 근거 기반 재구성본이다.
상세 내용은 `docs/V91_FOREIGN_FORMS_RECONSTRUCTION_20260830.md`를 참고한다.


## V91.1 출입국 신청서 UI·출력 보정
- 2026-08-31: 메뉴/레이아웃/날짜 필터를 정리하고 3종 HWPX 기준 A4 출력 템플릿을 상세화함.
- 상세: `docs/V91_1_IMMIGRATION_UI_PRINT_HARDENING_20260831.md`
