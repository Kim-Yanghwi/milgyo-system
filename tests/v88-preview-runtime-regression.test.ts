import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (file: string) => fs.readFileSync(file, 'utf8');

test('document mutations force fresh list and dashboard counts without stale overwrites', () => {
  const source = read('src/pages/index.astro');
  assert.match(source, /let dashboardRequestSerial=0/);
  assert.match(source, /requestSerial !== dashboardRequestSerial/);
  assert.match(source, /const invalidateDashboard = \(\) =>/);
  assert.match(source, /activateDocumentsView\(result\.nextView\|\|\(saveAsDraft\?'임시저장':'진행'\), true\)/);
  assert.match(source, /activateDocumentsView\('임시저장', true\)/);
  assert.match(source, /data-view="임시저장"[\s\S]*data-count="임시저장"/);
  assert.match(source, /data-view="진행"[\s\S]*data-count="진행"/);
  assert.doesNotMatch(source, /완료문서함\s*<span class="sidebar-link__count"/);
  assert.doesNotMatch(source, /반려문서함\s*<span class="sidebar-link__count"/);
  const summary = read('functions/api/dashboard/summary.ts');
  assert.match(summary, /key: 'rejected'/);
});

test('period filters are compact native dates without detached weekday badges', () => {
  const index = read('src/pages/index.astro');
  assert.match(index, /data-date-from data-no-weekday/);
  assert.match(index, /data-date-to data-no-weekday/);
  assert.match(index, /data-received-date-from data-no-weekday/);
  assert.match(index, /data-received-date-to data-no-weekday/);
  assert.match(index, /filter-date-range input\[type="date"\] \{ width: 145px;/);
  const dateInput = read('public/milgyo-date-input.js');
  assert.match(dateInput, /input\.hasAttribute\('data-no-weekday'\)\) return null/);
  const register = read('src/pages/register-management.astro');
  assert.match(register, /data-date-from data-no-weekday/);
  assert.match(register, /filter-date-range input\[type="date"\]\{width:145px/);
  const ordination = read('src/pages/ordination-certificates.astro');
  assert.match(ordination, /data-ledger-from data-no-weekday/);
  assert.match(ordination, /filter-date-range input\[type="date"\]\{width:145px/);
});

test('official document preview always falls back to the bundled organization seal', () => {
  const source = read('src/pages/index.astro');
  assert.match(source, /\/organization-seal-official\.png/);
  assert.match(source, /const sealSource=orgSealImage\|\|'\/organization-seal-official\.png'/);
  assert.doesNotMatch(source, /orgSealImage\?`<img[^`]+`:'밀교종印'/);
});
