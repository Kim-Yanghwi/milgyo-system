import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (file: string) => fs.readFileSync(file, 'utf8');

test('electronic document date filter stays compact without redesigning the original toolbar', () => {
  const ui = read('src/styles/system-ui.css');
  const dateInput = read('public/milgyo-date-input.js');
  const page = read('src/pages/index.astro');
  const layout = read('src/layouts/GovLayout.astro');
  assert.doesNotMatch(ui, /DATE_FILTER_COMPACT_V89/);
  assert.match(dateInput, /if \(!isDateInput\(input\) \|\| input\.hasAttribute\('data-no-weekday'\)\) return null;/);
  assert.match(page, /\.panel-filter-grid \{ justify-content: flex-end; \}/);
  assert.match(page, /\.panel-filter-grid \.filter-date-range \{ display: inline-flex;[^}]*white-space: nowrap;/);
  assert.match(page, /\.panel-filter-grid \.filter-date-range input\[type="date"\] \{ width: 145px; min-width: 145px; max-width: 145px; \}/);
  assert.doesNotMatch(page, /DOCUMENT_FILTER_DATE_ROW_V89/);
  assert.doesNotMatch(page, /\.panel-filter-grid \{[^}]*overflow-x: auto/);
  assert.match(layout, /src="\/milgyo-date-input\.js\?v=90"/);
});

test('official document uses the bundled square seal at the original preview position', () => {
  const page = read('src/pages/index.astro');
  assert.equal(fs.existsSync('public/organization-seal-official.png'), true);
  assert.match(page, /\/organization-seal-official\.png/);
  assert.match(page, /const sealSource=orgSealImage\|\|'\/organization-seal-official\.png'/);
  assert.match(page, /\.stamp-mark \{[\s\S]*z-index: 1; right: -0\.45rem; bottom: -0\.55rem;[\s\S]*width: 40px; height: 40px;/);
  assert.match(page, /\.stamp-mark\{position:absolute;z-index:1;right:-8px;bottom:-9px;[\s\S]*width:46px;height:46px/);
  assert.doesNotMatch(page, /width:\s*62px;\s*height:\s*62px/);
});

test('current user department refreshes from D1-backed session data without relogin', () => {
  const sessionApi = read('functions/api/auth/session.ts');
  const page = read('src/pages/index.astro');
  const management = read('src/layouts/ManagementLayout.astro');
  assert.match(sessionApi, /user:\s*\{[\s\S]*\.\.\.auth\.user/);
  assert.match(page, /const refreshCurrentSessionUser = async/);
  assert.match(page, /replaceSessionUser\(data\.user\)/);
  assert.match(page, /editedCurrentUser[\s\S]*refreshCurrentSessionUser\(\)/);
  assert.match(page, /me\.department\s*\|\|\s*\(departmentTree\.some/);
  assert.match(management, /if\(data\.ok&&data\.user\)/);
  assert.match(management, /renderProfile\(fresh\)/);
});
