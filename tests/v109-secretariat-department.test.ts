import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { formatDepartmentDisplay, normalizeDepartmentValue, resolveDepartmentHeadTitle } from '../functions/_shared/helpers';

const read = (path: string) => readFileSync(path, 'utf8');
const officePath = '사무처 - 사무국';

test('사무국의 내부 저장값과 표시값이 일치하며 기존 사무처는 보존된다', () => {
  for (const value of ['사무국', officePath, '사무처(사무국)', ' 사무처 – 사무국 ']) {
    assert.equal(normalizeDepartmentValue(value), officePath, value);
    assert.equal(formatDepartmentDisplay(value), '사무국', value);
  }
  assert.equal(normalizeDepartmentValue('사무처'), '사무처');
  assert.equal(formatDepartmentDisplay('사무처'), '사무처');
  assert.equal(normalizeDepartmentValue('사무국 - 재정국'), '사무처 - 재정국');
  assert.equal(normalizeDepartmentValue('사무처(재정국)'), '사무처 - 재정국');
  assert.equal(formatDepartmentDisplay('사무처 - 재정국'), '사무처(재정국)');
});

test('담당부서장 명칭은 사무국장이고 사무처 사무총장 명칭은 유지된다', () => {
  assert.equal(resolveDepartmentHeadTitle(officePath), '사무국장');
  assert.equal(resolveDepartmentHeadTitle('사무처(사무국)'), '사무국장');
  assert.equal(resolveDepartmentHeadTitle('사무국'), '사무국장');
  assert.equal(resolveDepartmentHeadTitle('사무처'), '사무총장');
  assert.equal(resolveDepartmentHeadTitle('사무처 - 재정국'), '재정국장');
});

test('조직도, 문서·계정 선택, 회계·규정대응의 모든 부서 트리에 사무국이 등록된다', () => {
  const views = [
    'src/pages/index.astro',
    'src/pages/accounting.astro',
    'src/pages/accounting-operations.astro',
    'src/pages/accounting-special.astro',
    'functions/api/accounting-compliance/query.ts',
  ];
  for (const path of views) {
    const s = read(path);
    assert.match(s, /사무처['"],?\s*children\s*:\s*\[\s*['"]사무국['"]/, path);
  }
  const page = read('src/pages/index.astro');
  assert.match(page, /'사무국': '사무국장'/);
  assert.match(page, /renderDepartmentOptions/);
  assert.match(page, /renderDepartmentFilterOptions/);
  assert.match(page, /membersOf\(dep\.name\+' - '\+c\)/);
  assert.match(page, /data-preview-department-title-text/);
  assert.match(page, /data-detail-preview-department-title-text/);
  assert.match(page, /!path\.secondary/); // 사무국장에게 사무총장 직인을 자동 표시하지 않는다.
});

test('사용자 계정 및 일반 직책 입력란에서 사무국장 입력·표시가 가능하다', () => {
  const page = read('src/pages/index.astro');
  assert.match(page, /list="office-position-suggestions"/);
  assert.match(page, /<option value="사무국장"><\/option>/);
  assert.match(page, /userForm\.elements\.department\.value = '사무처 - 사무국'/);
  const create = read('functions/api/users/create.ts');
  const update = read('functions/api/users/update.ts');
  for (const value of [create, update]) {
    assert.match(value, /position === '사무국장' \? '사무처 - 사무국'/);
    assert.match(value, /normalizeDepartmentValue\(payload\.department, position\)/);
  }
  assert.match(read('src/pages/accounting-special.astro'), /'사무총장','사무국장','재정국장'/);
  assert.match(read('src/pages/employee-certificates.astro'), /id="employee-position-suggestions"/);
});

test('자동 스키마 정비는 새 경로를 훼손하지 않으며 과거 이관은 유지된다', () => {
  const s = read('functions/_shared/helpers.ts');
  assert.match(s, /'사무국','사무처 - 사무국','사무처\(사무국\)'\) THEN '사무처 - 사무국'/);
  assert.match(s, /WHEN TRIM\(\$\{column\}\) LIKE '사무국 - %'/);
  assert.doesNotMatch(s, /ELSE REPLACE\(\$\{column\}, '사무국', '사무처'\)/);
  assert.match(read('functions/api/auth/bootstrap.ts'), /normalizedPosition === '사무국장'/);
});

test('서식 제출·주관기구 목록도 사무처(사무국)을 선택할 수 있다', () => {
  const source = read('functions/_shared/helpers.ts');
  assert.ok(source.includes("'사무국'"));
  assert.ok((source.match(/'사무국'/g) || []).length >= 2);
});


test('임명장·표창장 직위 및 회계 화면의 사무국 소속 표시는 누락되지 않는다', () => {
  const award = read('src/pages/appointment-awards.astro');
  assert.match(award, /id="award-position-suggestions"/);
  assert.match(award, /id="award-header-position"[^>]*list="award-position-suggestions"/);
  assert.match(award, /id="award-appointment-position"[^>]*list="award-position-suggestions"/);
  assert.match(award, /<option value="사무국장"><\/option>/);
  for (const page of ['accounting', 'accounting-operations', 'accounting-special']) {
    assert.match(read(`src/pages/${page}.astro`), /if\(n==='사무처 - 사무국'\)return '사무국'/, page);
  }
  assert.match(read('src/pages/employee-certificates.astro'), /<option value="사무국"><\/option>/);
  const employment = read('functions/api/employment/query.ts');
  assert.match(employment, /normalizeDepartmentValue\(user.department,position\)/);
});
