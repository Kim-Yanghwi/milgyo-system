// Explicit opt-in local maintenance. Does not connect to Cloudflare, run D1 migrations,
// change R2 objects, or alter the administrative test-data reset behavior.
// Run only on a backed-up working tree with Node 24.22.3 and npm registry access.
import { spawnSync } from 'node:child_process';
if (!process.argv.includes('--apply')) {
  console.error('Usage: node scripts/security/upgrade-dependencies.mjs --apply');
  console.error('Refreshes the reviewed Astro/Vite/Undici lockfile, installs, tests and builds.');
  process.exit(2);
}
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: 'inherit', shell: process.platform === 'win32',
  });
  if (result.error) { console.error(result.error.message); process.exit(1); }
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log('[security-update] Pin reviewed maintenance versions. No databases are touched.');
run(npm, ['pkg', 'set',
  'dependencies.astro=7.4.13',
  'overrides.vite=8.3.8',
  'overrides.undici=8.12.4',
  'overrides.sharp=0.35.5',
]);
console.log('[security-update] Generate a REAL lockfile from npm registry metadata.');
run(npm, ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund']);
console.log('[security-update] Install exactly as resolved in package-lock.json.');
run(npm, ['ci']);
console.log('[security-update] Run security gate, TypeScript tests, and site build.');
run(npm, ['run', 'verify:release']);
console.log('[security-update] SUCCESS. Commit package.json, package-lock.json and the patch files.');
console.log('[security-update] No D1 migration or deployment was performed.');
