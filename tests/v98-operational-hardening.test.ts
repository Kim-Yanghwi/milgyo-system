import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { validateXlsxArchiveBuffer } from '../src/lib/xlsxArchiveGuard.mjs';

const encoder = new TextEncoder();
function fakeZip(entries: Array<{name:string, compressed:number, uncompressed:number}>) {
  const centralParts: Uint8Array[] = [];
  let centralSize = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const part = new Uint8Array(46 + name.length);
    const view = new DataView(part.buffer);
    view.setUint32(0, 0x02014b50, true);
    view.setUint32(20, entry.compressed, true);
    view.setUint32(24, entry.uncompressed, true);
    view.setUint16(28, name.length, true);
    part.set(name, 46);
    centralParts.push(part); centralSize += part.length;
  }
  const out = new Uint8Array(centralSize + 22);
  let offset = 0;
  for (const part of centralParts) { out.set(part, offset); offset += part.length; }
  const eocd = new DataView(out.buffer, centralSize, 22);
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, entries.length, true);
  eocd.setUint16(10, entries.length, true);
  eocd.setUint32(12, centralSize, true);
  eocd.setUint32(16, 0, true);
  return out.buffer;
}

test('XLSX preflight accepts a bounded workbook-shaped archive', () => {
  const buffer = fakeZip([
    { name: '[Content_Types].xml', compressed: 100, uncompressed: 500 },
    { name: 'xl/workbook.xml', compressed: 120, uncompressed: 600 },
  ]);
  const result = validateXlsxArchiveBuffer(buffer, buffer.byteLength, { maxFileBytes: 1024 * 1024 });
  assert.equal(result.entries, 2);
  assert.equal(result.totalUncompressedBytes, 1100);
});

test('XLSX preflight rejects extreme compression before ExcelJS parses it', () => {
  const buffer = fakeZip([
    { name: '[Content_Types].xml', compressed: 1, uncompressed: 1000 },
    { name: 'xl/workbook.xml', compressed: 1, uncompressed: 1000 },
  ]);
  assert.throws(() => validateXlsxArchiveBuffer(buffer, buffer.byteLength, { maxFileBytes: 1024 * 1024, maxCompressionRatio: 100 }), /압축률/);
});

test('health readiness requires both D1 and both R2 bindings', () => {
  const source = fs.readFileSync('functions/api/health.ts', 'utf8');
  assert.match(source, /env\.DB/);
  assert.match(source, /env\.ACCOUNTING_DB/);
  assert.match(source, /env\.FILES/);
  assert.match(source, /env\.ACCOUNTING_FILES/);
});

test('release targets current reviewed Astro and Sharp maintenance versions', () => {
  const release = fs.readFileSync('scripts/security/check-release.mjs', 'utf8');
  const upgrade = fs.readFileSync('scripts/security/upgrade-dependencies.mjs', 'utf8');
  assert.match(release, /7\.3\.5/);
  assert.match(release, /0\.35\.5/);
  assert.match(upgrade, /dependencies\.astro=7\.3\.5/);
  assert.match(upgrade, /overrides\.sharp=0\.35\.5/);
});

test('release audit keeps a full audit command and narrows the temporary exception to one advisory', () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const source = fs.readFileSync('scripts/security/audit-release.mjs', 'utf8');
  assert.match(pkg.scripts['audit:full'], /npm audit/);
  assert.match(pkg.scripts['verify:release'], /audit:release/);
  assert.match(source, /GHSA-ch52-4w7c-c8xp/);
  assert.match(source, /parents\.length !== 1/);
});

test('Pages routing bypasses Functions for known public static assets but never for protected seals', () => {
  const routes = JSON.parse(fs.readFileSync('public/_routes.json', 'utf8'));
  assert.ok(routes.exclude.includes('/_astro/*'));
  assert.ok(routes.exclude.includes('/system-session.js'));
  for (const protectedPath of [
    '/organization-seal.png', '/organization-seal-official.png', '/secretary_general.png',
    '/signature-seals/*', '/certificates/ordination/organization-seal.png', '/certificates/ordination/top-seal.png',
  ]) assert.ok(!routes.exclude.includes(protectedPath));
});
