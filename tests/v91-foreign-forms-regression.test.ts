import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (file: string) => fs.readFileSync(file, 'utf8');

const FORM_FILES = [
  'public/forms/거주숙소제공확인서(한글-영문).hwpx',
  'public/forms/[별지 제34호서식] 통합신청서 (신고서) APPLICATION FORM (REPORT FORM)(출입국관리법 시행규칙).hwpx',
  'public/forms/[별지 제21호서식] 사증발급인정신청서 APPLICATION FOR CERTIFICATE OF VISA ELIGIBILITY(출입국관리법 시행규칙).hwpx',
];

test('V91 exposes the foreign application workspace from the renamed certificate/application menu', () => {
  const index = read('src/pages/index.astro');
  const layout = read('src/layouts/ManagementLayout.astro');
  assert.match(index, /증명서·신청서 발급·대장/);
  assert.match(layout, /증명서·신청서 발급·대장/);
  assert.match(index, /href="\/foreign-applications"/);
  assert.match(layout, /href="\/foreign-applications"/);
  assert.ok(fs.existsSync('src/pages/foreign-applications.astro'));
  assert.ok(!fs.existsSync('src/pages/foreign-application-forms.astro'));
});

test('V91 bundles the three supplied HWPX source forms', () => {
  for (const file of FORM_FILES) {
    assert.ok(fs.existsSync(file), `${file} must exist`);
    assert.ok(fs.statSync(file).size > 10_000, `${file} must contain a real HWPX payload`);
  }
  const page = read('src/pages/foreign-applications.astro');
  assert.match(page, /원본 HWPX 서식/);
  assert.match(page, /거주숙소제공확인서\(한글-영문\)\.hwpx/);
  assert.match(page, /별지 제34호서식/);
  assert.match(page, /별지 제21호서식/);
});

test('V91 schema marker and migration include foreign application history', () => {
  const helpers = read('functions/_shared/helpers.ts');
  const migration = read('migrations/main/0010_v91_foreign_application_forms.sql');
  assert.match(helpers, /SCHEMA_VERSION = '2026-08-30\.1'/);
  assert.match(helpers, /CREATE TABLE IF NOT EXISTS foreign_application_forms/);
  assert.match(helpers, /idx_foreign_application_forms_type_date/);
  assert.match(helpers, /has_foreign_application_forms/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS foreign_application_forms/);
  assert.match(migration, /print_count INTEGER NOT NULL DEFAULT 0/);
  assert.match(migration, /download_count INTEGER NOT NULL DEFAULT 0/);
});

test('V91 foreign form APIs preserve snapshots, owner access and admin or audit visibility', () => {
  const shared = read('functions/_shared/foreign-forms.ts');
  const query = read('functions/api/foreign-forms/query.ts');
  const action = read('functions/api/foreign-forms/action.ts');
  assert.match(shared, /sanitizeForeignSnapshot/);
  assert.match(query, /role === 'admin' \|\| role === 'audit'/);
  assert.match(query, /created_by_user_id=\?/);
  assert.match(action, /snapshot_json/);
  assert.match(action, /status='취소'/);
  assert.match(action, /print_count=print_count\+1/);
  assert.match(action, /download_count=download_count\+1/);
  for (const source of [query, action]) assert.match(source, /foreign_application_forms/);
});

test('V91 test-data reset includes foreign application records and CSV export is formula-safe', () => {
  const reset = read('functions/_shared/test-data-reset.ts');
  const page = read('src/pages/foreign-applications.astro');
  assert.match(reset, /COUNT\(\*\) FROM foreign_application_forms/);
  assert.match(reset, /DELETE FROM foreign_application_forms/);
  assert.match(page, /const csvSafe=/);
  assert.match(page, /\[=\+\\-@\]/);
});

test('V91 web fields cover the major sections of all three supplied forms', () => {
  const page = read('src/pages/foreign-applications.astro');
  assert.match(page, /외국인등록\(거소\)번호/);
  assert.match(page, /거주\/숙소 제공일/);
  assert.match(page, /체류자격 부여 \/ GRANTING STATUS OF SOJOURN/);
  assert.match(page, /반환용 계좌번호 \/ Refund Bank Account No\./);
  assert.match(page, /1\. 인적사항 \/ PERSONAL DETAILS/);
  assert.match(page, /7\. 방문정보 \/ DETAILS OF VISIT/);
  assert.match(page, /9\. 초청 정보 \/ DETAILS OF INVITATION/);
});
