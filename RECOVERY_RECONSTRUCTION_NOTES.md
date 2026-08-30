# Milgyo system recovery reconstruction notes — 2026-08-30

## Baseline chosen
This recovery uses the user-uploaded full replacement package:

- `milgyo-system-main-full-replacement-v90-1-20260830(1).zip`
- SHA-256: `2e71963e94b9310a0a6cdbd12f722390650dd791a2c6973b78b1f99d13ad3aaa`

This is treated as the strongest known complete baseline before the later foreigner-form request.

## Why this baseline is materially newer than the current GitHub export
Compared with the uploaded current-main export `milgyo-system-main(1).zip` (SHA-256 `47abc17e0154d5fa3f06e799ecc705578946bcb6b4b1a4ea222f24b0ad44d30f`):

- 24 files are added
- 30 existing files are changed
- 0 files are removed
- 54 file entries differ in total
- text diff is approximately +2,139 / -781 lines, plus one binary asset change

The V90.1 package contains the stabilization history and regression coverage for V85 through V90.1, including:

- V85 deep hardening / migration-chain completion / approval-race and accounting-integrity work
- V86 bootstrap finalization
- V87 Cloudflare PBKDF2 runtime compatibility
- V88 preview runtime/status/date/seal corrections
- V89 display/session/department corrections
- V90 UI baseline rollback while retaining non-visual stabilization
- V90.1 regression-test synchronization

## Later foreigner-form add-on reconstructed on top
The later request has been layered on top of V90.1 without replacing the stabilized runtime files.

Added:
- `src/pages/foreign-application-forms.astro`
- `functions/_shared/foreign-forms.ts`
- `functions/api/foreign-forms/query.ts`
- `functions/api/foreign-forms/action.ts`
- `migrations/main/0010_foreign_application_forms.sql`

Minimally modified:
- `src/pages/index.astro`
- `src/layouts/ManagementLayout.astro`

Menu label:
- `증명서 발급·대장` -> `증명서·신청서 발급·대장`

Added menu:
- `외국인 신청서·신고서 작성·대장`

The migration number is intentionally `0010` because the V90.1 baseline already contains main migrations through `0009_v86_bootstrap_finalize.sql`; this avoids the earlier recovery patch's conflicting `0007` filename.

## Validation performed in the recovery workspace
- TypeScript syntax transpilation passed for the three new TS files.
- Inline browser JavaScript syntax check passed for the foreign-form page.
- Menu integration anchors and unique main migration sequence were checked.
- A full `npm run verify` was attempted, but package installation in this isolated container timed out and left incomplete type packages. Therefore a clean-machine `npm ci && npm run verify` remains required before deployment.

## Important provenance limitation
The V90.1 baseline is source-exact to the uploaded package. The foreigner-form add-on is a reconstruction from the later requirements available in the conversation, not a byte-for-byte recovery of a deleted working directory. The three originally supplied HWPX files are not present in this recovery session, so exact field/layout parity with those files should be revalidated if they are uploaded again.

## Deployment safety
Use a new recovery/preview branch first. Do not overwrite Production until the Preview behavior is compared against the currently deployed site.
