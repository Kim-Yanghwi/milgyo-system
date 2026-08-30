import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (file: string) => fs.readFileSync(file, 'utf8');

test('V90 restores the original typography and toolbar geometry except requested compact dates', () => {
  const index = read('src/pages/index.astro');
  const management = read('src/layouts/ManagementLayout.astro');
  const register = read('src/pages/register-management.astro');
  const ordination = read('src/pages/ordination-certificates.astro');
  const ui = read('src/styles/system-ui.css');

  assert.match(index, /\.panel-header__tools input \{ min-width: 280px; \}/);
  assert.match(index, /\.panel-filter-grid \{ justify-content: flex-end; \}/);
  assert.doesNotMatch(index, /\.panel-filter-grid \{[^}]*width: 100%[^}]*overflow-x: auto/);
  assert.doesNotMatch(index, /\.panel-filter-grid > select \{/);
  assert.doesNotMatch(index, /DOCUMENT_FILTER_DATE_ROW_V89/);

  assert.doesNotMatch(management, /\.filter-date-range\{/);
  assert.doesNotMatch(register, /\.register-filters\{justify-content:flex-end\}/);
  assert.match(register, /\.register-filters input\[type=search\]\{min-width:240px\}/);
  assert.match(ordination, /\.ledger-section-title\{align-items:flex-start\}/);
  assert.match(ordination, /\.ledger-filters\{justify-content:flex-end;flex-wrap:wrap\}/);

  assert.doesNotMatch(ui, /DATE_FILTER_COMPACT_V89/);
  assert.doesNotMatch(ui, /\.filter-date-range\s*\{/);
});

test('V90 keeps the official seal at the original document position and size', () => {
  const index = read('src/pages/index.astro');
  assert.match(index, /position: absolute; z-index: 1; right: -0\.45rem; bottom: -0\.55rem;/);
  assert.match(index, /width: 40px; height: 40px;/);
  assert.match(index, /right:-8px;bottom:-9px;[\s\S]*width:46px;height:46px/);
  assert.doesNotMatch(index, /right:\s*-1\.05rem;\s*bottom:\s*-0\.9rem/);
  assert.doesNotMatch(index, /width:\s*62px;\s*height:\s*62px/);
});

test('V90 hamburger toggles only the sidebar and exposes a reversible state', () => {
  const index = read('src/pages/index.astro');
  const management = read('src/layouts/ManagementLayout.astro');
  for (const source of [index, management]) {
    assert.match(source, /aria-expanded="true"/);
    assert.match(source, /const setSidebarCollapsed=\(collapsed\)=>/);
    assert.match(source, /classList\.toggle\('sidebar-collapsed',!!collapsed\)/);
    assert.match(source, /setAttribute\('aria-expanded',String\(!collapsed\)\)/);
  }
  assert.match(index, /\.app-shell\.sidebar-collapsed \.app-sidebar \{ width: 0; padding: 0; border: 0; overflow: hidden; \}/);
  assert.match(management, /\.management-shell\.sidebar-collapsed \.app-sidebar\{width:0;flex-basis:0;padding:0;border:0;overflow:hidden\}/);
});
