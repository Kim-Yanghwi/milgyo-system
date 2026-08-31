import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (file: string) => fs.readFileSync(file, 'utf8');

test('V91.1 shortens the immigration menu and page wording', () => {
  const page = read('src/pages/foreign-applications.astro');
  const index = read('src/pages/index.astro');
  const layout = read('src/layouts/ManagementLayout.astro');
  for (const source of [page, index, layout]) assert.match(source, /출입국 신청서 작성·대장/);
  assert.doesNotMatch(index, /외국인 신청서·신고서 작성·대장/);
  assert.doesNotMatch(layout, /외국인 신청서·신고서 작성·대장/);
  assert.match(page, /출입국 관련 신청서\(신고서\)를 화면에서 작성하고, 작성본 다운로드·인쇄 및 이력을 관리합니다\./);
});

test('V91.1 aligns form and ledger controls to the requested layout', () => {
  const page = read('src/pages/foreign-applications.astro');
  assert.match(page, /form-selector-actions/);
  assert.match(page, /official-form-downloads/);
  assert.match(page, /data-no-weekday data-ledger-from/);
  assert.match(page, /data-no-weekday data-ledger-to/);
  assert.match(page, /\.foreign-actions\{display:flex;justify-content:flex-end;align-items:center;gap:\.75rem/);
  assert.match(page, /\.official-form-downloads\{display:flex;align-items:center;justify-content:flex-end/);
  assert.match(page, /\.filter-date-range\{display:flex;align-items:center/);
});

test('V91.1 isolates input sections so numbered sections cannot flow into adjacent columns', () => {
  const page = read('src/pages/foreign-applications.astro');
  assert.match(page, /foreign-form-sections/);
  assert.match(page, /foreign-input-section/);
  assert.match(page, /foreign-section-number/);
  assert.match(page, /groups\.map\(\(group,index\)=>`<section class="foreign-input-section"/);
});

test('V91.1 renders form-specific A4 previews with tables and multi-page visa output', () => {
  const page = read('src/pages/foreign-applications.astro');
  assert.match(page, /official-page--residence/);
  assert.match(page, /official-page--integrated/);
  assert.match(page, /official-page--visa/);
  assert.match(page, /paper-table residence-table/);
  assert.match(page, /paper-table integrated-table/);
  assert.match(page, /visaPageTitle\(5\)/);
  assert.match(page, /@page\{size:A4 portrait;margin:0\}/);
  assert.match(page, /border:0\.65pt solid #111/);
});
