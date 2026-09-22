import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const read = (file: string) => readFileSync(file, 'utf8');

test('사무총장 직인은 독립 자산으로만 추가되고 기존 종단 직인 코드는 유지된다', () => {
  const page = read('src/pages/index.astro');
  assert.equal(existsSync('public/secretary_general.png'), true);
  assert.match(page, /src="\/secretary_general\.png" alt="사무총장 직인"/);
  assert.match(page, /const sealSource=orgSealImage\|\|'\/organization-seal-official\.png'/);
  assert.match(page, /\$\$\('\[data-stamp\]'\)/);
  assert.doesNotMatch(page, /data-preview-secretary-general-seal[^>]*data-stamp/);
  assert.doesNotMatch(page, /data-detail-preview-secretary-general-seal[^>]*data-stamp/);
});

test('사무처의 담당부서장 직책 표시가 사무총장일 때만 전용 직인을 표시한다', () => {
  const page = read('src/pages/index.astro');
  assert.match(page, /const shouldShowSecretaryGeneralSeal = \(issueDisplayMode, department, departmentHeadTitle, position=''\) => \{/);
  assert.match(page, /issueDisplayMode === 'department-head'[\s\S]*departmentHeadTitle === '사무총장'[\s\S]*path\.primary === '사무처'[\s\S]*!path\.secondary/);
  assert.match(page, /data-preview-secretary-general-seal/);
  assert.match(page, /data-detail-preview-secretary-general-seal/);
});

test('사무총장 직인은 장 글자 쪽에 겹쳐 보이도록 미리보기와 인쇄 CSS에 포함된다', () => {
  const page = read('src/pages/index.astro');
  assert.match(page, /\.secretary-general-seal \{[\s\S]*width: 42px; height: 42px; right: -1\.38rem; top: 50%;/);
  assert.match(page, /\.secretary-general-seal\{position:absolute;z-index:3;width:46px;height:46px;right:-28px;top:50%;/);
  assert.match(page, /mix-blend-mode:multiply/);
});
