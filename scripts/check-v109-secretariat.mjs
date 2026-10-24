// V109: prevent a partial UI-only addition of the second-tier Secretariat.
// Safe to run locally and in CI; reads repository files only (no DB/R2 changes).
import { readFileSync } from 'node:fs';
const read = (path) => readFileSync(path, 'utf8');
const errors = [];
const must = (path, patterns) => {
  const text = read(path);
  for (const [name, expression] of patterns) {
    if (!expression.test(text)) errors.push(`${path}: ${name}`);
  }
};
const tree = [/사무처['"],?\s*children\s*:\s*\[\s*['"]사무국['"]/];
for (const file of [
  'src/pages/index.astro',
  'src/pages/accounting.astro',
  'src/pages/accounting-operations.astro',
  'src/pages/accounting-special.astro',
  'functions/api/accounting-compliance/query.ts',
]) must(file, [['사무처 아래 사무국 누락', tree[0]]]);
for (const file of [
  'src/pages/index.astro',
  'src/pages/accounting.astro',
  'src/pages/accounting-operations.astro',
  'src/pages/accounting-special.astro',
  'src/pages/accounting-tax.astro',
  'src/pages/register-management.astro',
  'src/pages/employee-certificates.astro',
  'src/layouts/ManagementLayout.astro',
]) must(file, [['구형 사무국->사무처 일괄변환이 남아 있음', /if\s*\(primary\s*===\s*'사무국'\)\s*\{?.*secondary\s*=\s*'사무국'/]]);
// Note: the check above positively requires the canonical fallback; it does not mutate data.
must('functions/_shared/helpers.ts', [
  ['사무국장 직책 누락', /'사무국': '사무국장'/],
  ['사무국 저장값 재매핑 누락', /if \(primary === '사무국'\) \{ primary = '사무처'; if \(!secondary\) secondary = '사무국'; \}/],
  ['복구 처리 시 사무처(사무국) 보존 누락', /'사무국','사무처 - 사무국','사무처\(사무국\)'\) THEN '사무처 - 사무국'/],
]);
for (const file of ['functions/api/users/create.ts', 'functions/api/users/update.ts'])
  must(file, [['사무국장 계정의 기본 소속 처리 누락', /position === '사무국장' \? '사무처 - 사무국'/]]);
must('src/pages/employee-certificates.astro', [['재직증명서 소속에 사무국 표시 누락', /<option value="사무국"><\/option>/]]);
must('src/pages/index.astro', [
  ['공문 담당부서장 명칭 누락', /'사무국': '사무국장'/],
  ['사무국장 직책입력 제안 누락', /<option value="사무국장"><\/option>/],
  ['조직도 2차 부서 렌더링 누락', /dep\.name\+' - '\+c/],
  ['사무총장 직인의 부서 단위 구분 누락', /!path\.secondary/],
]);
must('src/pages/accounting-special.astro', [['책임자 직책 선택에 사무국장 누락', /'사무총장','사무국장','재정국장'/]]);
must('src/pages/appointment-awards.astro', [
  ['임명장 상단 직위명 제안 누락', /id="award-header-position"[^>]*list="award-position-suggestions"/],
  ['임명장 임명 직위명 제안 누락', /id="award-appointment-position"[^>]*list="award-position-suggestions"/],
  ['사무국장 직위명 누락', /<option value="사무국장"><\/option>/],
]);
for (const f of ['src/pages/accounting.astro','src/pages/accounting-special.astro','src/pages/accounting-operations.astro'])
  must(f, [['사무국 표시명 단축 누락', /if\(n===['"]사무처 - 사무국['"]\)return ['"]사무국['"]/]]);

if (errors.length) {
  for (const error of errors) console.error('[v109-check] FAIL', error);
  process.exitCode = 1;
} else {
  console.log('[v109-check] PASS: organization, account, documents, signatory title, accounting and legacy normalization.');
}
