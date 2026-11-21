// Security floor for dependencies actually resolved in package-lock.json.
// Does not replace npm audit or a production/preview integration test.
import fs from 'node:fs';
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
const floors = Object.freeze({ astro: '7.4.13', vite: '8.3.8', undici: '8.12.4', sharp: '0.35.5' });
const semver = (value) => /^\d+\.\d+\.\d+$/.test(value || '') ? value.split('.').map(Number) : null;
function atLeast(value, expected) {
  const actual = semver(value); const minimum = semver(expected);
  if (!actual || !minimum) return false;
  for (let i = 0; i < 3; i++) {
    if (actual[i] > minimum[i]) return true;
    if (actual[i] < minimum[i]) return false;
  }
  return true;
}
const issues = [];
const packages = lock.packages || {};
const match = (name) => Object.entries(packages).filter(([key]) => key === `node_modules/${name}` || key.endsWith(`/node_modules/${name}`));
for (const [name, min] of Object.entries(floors)) {
  const entries = match(name);
  if (!entries.length) issues.push(`${name}: missing from lockfile`);
  for (const [path, meta] of entries) {
    if (!atLeast(meta.version, min)) issues.push(`${path}: ${meta.version || 'missing'} is below ${min}`);
  }
}
if (pkg.dependencies?.astro !== floors.astro) issues.push(`package.json astro must be pinned to ${floors.astro}`);
for (const name of ['vite','undici','sharp']) {
  if (pkg.overrides?.[name] !== floors[name]) issues.push(`package.json overrides.${name} must be pinned to ${floors[name]}`);
}
const root = packages[''];
if (JSON.stringify(root?.dependencies) !== JSON.stringify(pkg.dependencies)) issues.push('package.json and package-lock.json root dependencies differ. Run npm run security:upgrade locally.');
if (JSON.stringify(root?.devDependencies) !== JSON.stringify(pkg.devDependencies)) issues.push('package.json and package-lock.json root devDependencies differ.');
console.log(JSON.stringify({ date: '2026-11-21', floors,
  resolved: Object.fromEntries(Object.keys(floors).map(name => [name, match(name).map(([path, meta])=>({path,version:meta.version}))])),
  ok: issues.length === 0, issues,
  advisories: [
    'https://github.com/vitejs/vite/security/advisories/GHSA-p4f5-76q4-ffq7',
    'https://github.com/nodejs/undici/security/advisories/GHSA-mqg3-3v4r-cm32',
    'https://github.com/withastro/astro/security/advisories/GHSA-mh32-jxcr-mh9f',
  ]
}, null, 2));
if (issues.length) process.exitCode = 1;
