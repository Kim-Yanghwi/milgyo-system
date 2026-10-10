// Release audit: fail on every high/critical npm advisory except the narrowly documented
// Astro build-time http-cache-semantics advisory while upstream has no patched release.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ALLOWED = 'GHSA-ch52-4w7c-c8xp';
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const result = spawnSync(npm, ['audit', '--omit=dev', '--audit-level=high', '--json'], {
  encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 20 * 1024 * 1024,
});

let report;
try { report = JSON.parse(result.stdout || '{}'); }
catch {
  process.stderr.write(result.stderr || '');
  console.error('npm audit 결과 JSON을 해석하지 못했습니다. 네트워크와 npm 레지스트리 연결을 확인하십시오.');
  process.exit(1);
}
if (report?.error) {
  console.error('npm audit 실행 오류:', report.error.summary || report.error.message || report.error);
  process.exit(1);
}

const rank = { low: 1, moderate: 2, high: 3, critical: 4 };
const high = Object.entries(report.vulnerabilities || {}).filter(([, value]) => rank[value?.severity] >= rank.high);
const unexpected = [];
let allowedSeen = false;

function advisoryIds(vulnerability) {
  return (vulnerability?.via || [])
    .filter((item) => item && typeof item === 'object')
    .flatMap((item) => [item.url, item.title])
    .filter(Boolean)
    .map(String);
}

function buildOnlyAstroPathIsStillTrue() {
  const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
  const parents = Object.entries(lock.packages || {})
    .filter(([, value]) => value?.dependencies?.['http-cache-semantics'])
    .map(([key]) => key);
  if (parents.length !== 1 || parents[0] !== 'node_modules/astro') return false;
  const roots = ['functions', 'workers'];
  const sourceFiles = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(?:[cm]?[jt]s|tsx?)$/i.test(entry.name)) sourceFiles.push(full);
    }
  };
  roots.forEach(walk);
  return sourceFiles.every((file) => {
    const source = fs.readFileSync(file, 'utf8');
    return !/http-cache-semantics|(?:from\s*['\"]astro['\"]|require\(['\"]astro['\"]\))/.test(source);
  });
}

for (const [name, vulnerability] of high) {
  const ids = advisoryIds(vulnerability);
  const exactAllowed = name === 'http-cache-semantics' && ids.some((value) => value.includes(ALLOWED));
  if (exactAllowed && buildOnlyAstroPathIsStillTrue()) { allowedSeen = true; continue; }
  unexpected.push({ name, severity: vulnerability.severity, via: ids });
}

if (unexpected.length) {
  console.error('배포를 중단합니다. 검토되지 않은 high/critical 취약점이 있습니다.');
  console.error(JSON.stringify(unexpected, null, 2));
  process.exit(1);
}
if (high.length === 0 && result.status !== 0) {
  console.error('npm audit가 비정상 종료했지만 high/critical 항목을 확인할 수 없습니다.');
  process.stderr.write(result.stderr || '');
  process.exit(1);
}
if (allowedSeen) {
  console.warn(`[release-audit] ${ALLOWED} 한 건만 임시 예외 처리했습니다. Astro의 빌드 전이 의존성에만 존재하며 운영 Functions 런타임에는 포함되지 않는지 재검증했습니다.`);
  console.warn('[release-audit] 전체 감사(npm run audit:full)는 수정 버전이 나올 때까지 이 항목을 계속 표시하는 것이 정상입니다.');
} else {
  console.log('[release-audit] high/critical 알려진 취약점이 없습니다.');
}
