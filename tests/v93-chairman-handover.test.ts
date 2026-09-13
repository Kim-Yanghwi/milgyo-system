import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const urlFor = (path: string) => new URL(`../${path}`, import.meta.url);
const read = (path: string) => readFileSync(urlFor(path), 'utf8');

test('현재 재직증명서 기본 이사장 이름은 조화연이다', () => {
  assert.match(read('functions/_shared/helpers.ts'), /signatory_name TEXT NOT NULL DEFAULT '조화연'/);
  assert.match(read('src/pages/employee-certificates.astro'), /r\.signatory_name\|\|'조화연'/);
});

test('현재 사용자/증명서/회계 후보 목록에서 조화연이 김양휘보다 먼저 표시된다', () => {
  const users = read('functions/api/users/list.ts');
  assert.match(users, /name='조화연' THEN 0 WHEN name='김양휘' THEN 1/);

  const employment = read('functions/api/employment/query.ts');
  assert.match(employment, /name='조화연' THEN 0 WHEN u\.name='김양휘' THEN 1|u\.name='조화연' THEN 0 WHEN u\.name='김양휘' THEN 1/);

  const accounting = read('functions/api/accounting-special/query.ts');
  assert.match(accounting, /name='조화연' THEN 0 WHEN name='김양휘' THEN 1/);
});

test('V93 데이터 이관 migration은 최종 소스에 남기지 않는다', () => {
  assert.equal(existsSync(urlFor('migrations/main/0012_v93_chairman_handover.sql')), false);
  assert.equal(existsSync(urlFor('migrations/accounting/0019_v93_chairman_handover.sql')), false);
});

test('이미 적용된 과거 0005 migration은 원본 이력을 보존한다', () => {
  const historical = read('migrations/main/0005_v61_employment_certificate_signatory.sql');
  assert.match(historical, /DEFAULT '김양휘'/);
});
