import { existsSync, readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const checks = [];
const check = (label, ok) => checks.push({ label, ok: Boolean(ok) });

check('재직증명서 신규 스키마 기본 이사장 = 조화연', /signatory_name TEXT NOT NULL DEFAULT '조화연'/.test(read('functions/_shared/helpers.ts')));
check('재직증명서 화면 fallback 이사장 = 조화연', /r\.signatory_name\|\|'조화연'/.test(read('src/pages/employee-certificates.astro')));
check('사용자 목록 조화연 → 김양휘 순서', /name='조화연' THEN 0 WHEN name='김양휘' THEN 1/.test(read('functions/api/users/list.ts')));
check('재직증명서 사용자/발급명의 후보 조화연 → 김양휘 순서', /u\.name='조화연' THEN 0 WHEN u\.name='김양휘' THEN 1/.test(read('functions/api/employment/query.ts')));
check('회계 이사장 후보 조화연 → 김양휘 순서', /name='조화연' THEN 0 WHEN name='김양휘' THEN 1/.test(read('functions/api/accounting-special/query.ts')));
check('불필요한 MAIN V93 데이터이관 migration 없음', !existsSync(new URL('../migrations/main/0012_v93_chairman_handover.sql', import.meta.url)));
check('불필요한 ACCOUNTING V93 데이터이관 migration 없음', !existsSync(new URL('../migrations/accounting/0019_v93_chairman_handover.sql', import.meta.url)));
check('기존 0005 migration 이력 보존', /DEFAULT '김양휘'/.test(read('migrations/main/0005_v61_employment_certificate_signatory.sql')));
check('V91.1 테스트가 현재 동적 class 구조 허용', /groups\\\.map/.test(read('tests/v91-1-immigration-ui-paper.test.ts')) && /foreign-input-section\//.test(read('tests/v91-1-immigration-ui-paper.test.ts')));

let failed = 0;
for (const item of checks) {
  const tag = item.ok ? 'PASS' : 'FAIL';
  console.log(`[${tag}] ${item.label}`);
  if (!item.ok) failed += 1;
}
if (failed) {
  console.error(`[v93-final] ${failed}개 검사 실패`);
  process.exit(1);
}
console.log('[v93-final] OK');
