import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (file: string) => fs.readFileSync(file, 'utf8');

test('management date ranges stay grouped as one horizontal control', () => {
  const pages = [
    'src/pages/index.astro',
    'src/pages/register-management.astro',
    'src/pages/ordination-certificates.astro',
  ];
  for (const file of pages) {
    const source = read(file);
    assert.match(source, /class="filter-date-range"/, `${file} must use the shared compact date-range group`);
  }
  const layout = read('src/layouts/ManagementLayout.astro');
  assert.match(layout, /\.filter-date-range\{[^}]*display:inline-flex[^}]*white-space:nowrap/);
  assert.match(layout, /\.filter-date-range>:is\(\.date-with-weekday,\.managed-date-with-weekday\)\{width:174px!important;min-width:174px!important\}/);
});

test('electronic document filters keep date range next to existing search controls', () => {
  const source = read('src/pages/index.astro');
  const documentFilters = source.match(/<div class="panel-header__tools panel-filter-grid">[\s\S]*?<\/div>\s*<\/div>\s*<div class="panel-status" data-status/)?.[0] || '';
  assert.match(documentFilters, /filter-date-range/);
  assert.match(documentFilters, /data-query/);
  assert.ok(documentFilters.indexOf('filter-date-range') < documentFilters.indexOf('data-query'), 'date range should remain in the same toolbar before search');
  assert.match(source, /\.panel-filter-grid \{[^}]*flex-wrap: nowrap[^}]*min-width: 0/);
});

test('management subpages use cheap session validation instead of dashboard aggregation', () => {
  const layout = read('src/layouts/ManagementLayout.astro');
  assert.match(layout, /fetch\('\/api\/auth\/session'/);
  assert.doesNotMatch(layout, /fetch\('\/api\/dashboard\/summary'/);
  const endpoint = read('functions/api/auth/session.ts');
  assert.match(endpoint, /authenticateSession/);
  assert.doesNotMatch(endpoint, /COUNT\s*\(/i);
});

test('document date filters are validated and interpreted in Korea time', () => {
  const source = read('functions/api/documents/list.ts');
  assert.match(source, /isValidIsoDate/);
  assert.match(source, /dateFrom && dateTo && dateFrom > dateTo/);
  assert.match(source, /T00:00:00\+09:00/);
  assert.match(source, /kstDayBoundaryUtc\(dateTo, 1\)/);
});

test('received and register date ranges reject malformed or reversed ranges', () => {
  for (const file of ['functions/api/received/list.ts', 'functions/api/registers/query.ts']) {
    const source = read(file);
    assert.match(source, /isValidIsoDate/, `${file} must validate ISO dates`);
    assert.match(source, /dateFrom.*dateTo.*dateFrom\s*>\s*dateTo/s, `${file} must reject reversed ranges`);
  }
});

test('document and received list refreshes ignore stale responses', () => {
  const source = read('src/pages/index.astro');
  assert.match(source, /let documentRequestSerial=0/);
  assert.match(source, /requestSerial!==documentRequestSerial/);
  assert.match(source, /let receivedRequestSerial=0/);
  assert.match(source, /requestSerial!==receivedRequestSerial/);
});

test('CSV exports defend against spreadsheet formulas even after leading whitespace', () => {
  for (const file of [
    'src/pages/index.astro',
    'src/pages/register-management.astro',
    'src/pages/ordination-certificates.astro',
    'src/pages/employee-certificates.astro',
  ]) {
    const source = read(file);
    assert.match(source, /\^\[\\t\\r\\n \]\*\[=\+\\-@\]/, `${file} must neutralize formula-like CSV cells`);
  }
});
