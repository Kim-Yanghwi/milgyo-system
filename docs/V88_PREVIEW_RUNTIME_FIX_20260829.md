# V88 Preview runtime fixes (2026-08-29)

V88 is a code/UI-only update on top of V87. It does not add or change D1 migrations.

## 1. Immediate electronic-document refresh

- Added a request serial to dashboard/side-count refreshes so an older response cannot overwrite a newer post-action count.
- Draft create/update, draft delete, recall, approval/rejection, batch decision, send completion, and registry mutations now invalidate the dashboard cache and force a fresh status count.
- Removed the behavior that overwrote a sidebar status badge with the currently filtered list total.
- Added status badges for Completed and Rejected folders as well.
- Added a rejected count to `/api/dashboard/summary`.

## 2. Compact, visible date ranges

- Document list, received/sent list, register-management list, and ordination ledger period filters do not show detached weekday badges.
- Start/end dates remain in a single `start ~ end` horizontal group on desktop.
- Each period date field is compact (148px base width).
- The date helper still supports eight-digit numeric entry; `data-no-weekday` now suppresses only the weekday badge, not the visual/numeric date handling.
- This fixes the case where a selected date's weekday was visible but the date text itself was not.

## 3. Bundled official seal restored

- `/organization-seal.png` is now the default document seal when no custom seal has been stored in `org_settings`.
- The same fallback is used in compose preview, detail preview, branding preview, and print output.
- A user-uploaded custom seal still takes priority over the bundled seal.

## Validation performed in the build workspace

- Inline JavaScript syntax check: passed.
- Shared date JavaScript syntax check: passed.
- Management/V86/V87/V88 regression tests: 15/15 passed.
- V84/V85 performance/deep-hardening static regression tests: 15/15 passed.
- `git diff` whitespace validation was checked with CRLF-at-EOL allowed for the existing dashboard API file.

A full `npm run verify` could not be rerun in the build workspace because package installation from the external npm registry timed out. Run `npm.cmd run verify` on the deployment workstation before Preview redeploy; V87 had already built successfully there.

## Deployment

No D1 migration command is required for V88.

1. Apply the V88 changed files over the current V87 working tree.
2. Run `npm.cmd run verify`.
3. Confirm `npx.cmd wrangler d1 migrations list DB --remote --env preview` says `No migrations to apply!`.
4. Deploy Preview:
   `npx.cmd wrangler pages deploy dist --project-name=milgyo-system --branch=v85-preopen`
5. Hard refresh the Preview browser and retest document status counts, date filters, and the official seal.
