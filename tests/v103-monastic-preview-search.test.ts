import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SQLiteD1 } from './support/d1-sqlite.mjs';
import { createSession } from '../functions/_shared/security/sessions';
import { onRequestPost as registryAction } from '../functions/api/monastic-registry/action';
import { onRequestPost as certificateQuery } from '../functions/api/monastic-certificates/query';
import { onRequestPost as certificateAction } from '../functions/api/monastic-certificates/action';
import { monasticToday } from '../functions/_shared/monastic';

const origin = 'https://system.example.test';
const call = async (handler: any, db: any, token: string, payload: object) => {
  const request = new Request(`${origin}/api/monastic`, { method: 'POST', headers: {
    Origin: origin, 'Content-Type': 'application/json', 'X-Milgyo-Request': '1',
    ...(token ? { Cookie: `__Host-milgyo_session=${token}` } : {}),
  }, body: JSON.stringify(payload) });
  const response = await handler({ request, env: { DB: db }, params: {}, data: {} } as any);
  return { status: response.status, body: await response.json() as any };
};
const sample = (monasticNo: string, dharmaNameKo: string, layName: string, temple: string, status = '재적') => ({
  ordinationRound: '01', monasticNo, dharmaNameKo, layName, temple, status,
  acquiredDate: '2020-01-01', firstRegisteredDate: '2020-01-01', lastVerifiedDate: '2024-01-01',
  processingBasis: '동의', sensitiveBasis: '동의', retentionPeriod: '5년',
  preparedBy: 'user:chair', reviewedBy: 'user:chair', approvedBy: 'user:chair',
  ordination: [], career: [],
});

const setup = async () => {
  const db = new SQLiteD1();
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO system_users(id,name,username,password_hash,role,active,position,department,created_at)
    VALUES ('chair','정식이사장','chair','unused','admin',1,'이사장','총무원',?),
      ('staff','조직도직원','staff','unused','user',1,'사무총장','사무처',?),
      ('inactive','휴면이사장','inactive','unused','user',0,'이사장','총무원',?)`)
      .bind(now, now, now).run();
  const admin = (await createSession(db as any, 'chair')).token;
  const staff = (await createSession(db as any, 'staff')).token;
  return { db, admin, staff };
};

test('관리자만 대상자를 검색할 수 있고 이름·법명·사찰·승적번호 검색을 지원한다', async () => {
  const { db, admin, staff } = await setup();
  try {
    const numbers: string[] = [];
    for (const row of [
      sample('M-103-A', '법광', '홍길동', '동해사'),
      sample('M-103-B', '청련', '김소영', '백련사'),
      sample('M-103-C', '해인', '이상호', '동해사', '제적'),
    ]) {
      const result = await call(registryAction, db, admin, { operation: 'create', content: row });
      assert.equal(result.status, 200, result.body.message);
      numbers.push(result.body.row.monastic_no);
    }
    const initial = await call(certificateQuery, db, admin, { operation: 'options' });
    assert.equal(initial.status, 200);
    assert.equal(initial.body.registry.length, 2, '재적 원부만 초기에 표시');
    for (const [query, expected] of [
      ['길동', numbers[0]], ['법광', numbers[0]], ['백련사', numbers[1]], [numbers[1], numbers[1]],
    ]) {
      const result = await call(certificateQuery, db, admin, { operation: 'search-registry', query });
      assert.equal(result.status, 200);
      assert.deepEqual(result.body.registry.map((r: any) => r.monastic_no), [expected]);
    }
    const temple = await call(certificateQuery, db, admin, { operation: 'search-registry', query: '동해사' });
    assert.deepEqual(temple.body.registry.map((r: any) => r.monastic_no), [numbers[0]]);
    const wildcard = await call(certificateQuery, db, admin, { operation: 'search-registry', query: '%' });
    assert.equal(wildcard.body.registry.length, 0, 'LIKE 특수문자는 검색어 문자 그대로 처리');
    assert.equal((await call(certificateQuery, db, staff, { operation: 'search-registry', query: '법광' })).status, 403);
    assert.equal((await call(certificateQuery, db, '', { operation: 'search-registry', query: '법광' })).status, 401);
  } finally { db.close(); }
});

test('조직도 활성 계정은 미리보기용으로 표시하지만 실제 발급권자는 별도로 제한한다', async () => {
  const { db, admin } = await setup();
  try {
    const options = await call(certificateQuery, db, admin, { operation: 'options' });
    assert.deepEqual(options.body.organizationUsers.map((u: any) => u.id), ['chair', 'staff']);
    assert.deepEqual(options.body.signatories.map((u: any) => u.id), ['chair']);
    const created = await call(registryAction, db, admin, { operation: 'create', content: sample('M-103-SIGN', '계정시험', '테스트인물', '시험사찰') });
    assert.equal(created.status, 200);
    const issueBase = { operation: 'issue', registryId: created.body.row.id, issueDate: monasticToday(), purpose: '서류 제출', signatoryTitle: '이사장' };
    const withStaff = await call(certificateAction, db, admin, { ...issueBase, requestId: 'v103-signatory-any-000001', signatoryUserId: 'staff' });
    assert.equal(withStaff.status, 200, withStaff.body.message);
    const accepted = await call(certificateAction, db, admin, { ...issueBase, requestId: 'v103-signatory-valid-00002', signatoryUserId: 'chair' });
    assert.equal(accepted.status, 200, accepted.body.message);
  } finally { db.close(); }
});

test('테스트 미리보기에는 좌측 상단 테스트용 표기와 직인 위치 확인용 이미지가 있으며 정식 발급번호는 없다', () => {
  const source = readFileSync('src/pages/monastic-certificates.astro', 'utf8');
  const from = source.indexOf('      const printCss=`');
  const to = source.indexOf('      // 테스트 미리보기는', from);
  assert.ok(from >= 0 && to > from);
  const esc = (v: any) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as any)[c]);
  const markup = new Function('esc', 'koreanDate', 'signatoryName', `${source.slice(from, to)};return markup;`)(
    esc, (d: string) => d || '-', (n: string) => n,
  ) as (s: any, invalid: boolean, preview: boolean) => string;
  const record = { certificateNo: '테스트용 · 미발급', dharmaName: '시험법명', layName: '시험사람',
    monasticNo: '', signatoryName: '조직도직원', signatoryTitle: '이사장', includeLogo: true };
  const testPrint = markup(record, false, true);
  assert.match(testPrint, /monastic-certificate-test-watermark/);
  assert.match(testPrint, /테스트용/);
  assert.match(testPrint, /미리보기·미발급 · 효력 없음/);
  assert.match(testPrint, /organization-seal\.png/);
  assert.match(testPrint, /monastic-certificate-seal--preview/);
  assert.doesNotMatch(testPrint, /\(직인\)/);
  assert.match(testPrint, /승적 등재 여부를 증명하지 않습니다/);
  assert.doesNotMatch(testPrint, /대한불교밀교종 \| 서식 02 승적증명서/);
  assert.match(testPrint, /monastic-certificate-disclaimer-line">필요한 경우 별도 확인합니다\./);
  const finalPrint = markup({ ...record, certificateNo: '승적-2026-00001', monasticNo: 'M-103-A' }, false, false);
  assert.match(finalPrint, /organization-seal\.png/);
  assert.doesNotMatch(finalPrint, /monastic-certificate-test-watermark/);
});

test('원부 구분선은 상세 1개·신규등록 1개이며 대상자 선택과 검색은 같은 행을 양분한다', () => {
  const registry = readFileSync('src/pages/monastic-register.astro', 'utf8');
  const cert = readFileSync('src/pages/monastic-certificates.astro', 'utf8');
  const editor = registry.split('<section class="surface monastic-editor"')[1].split('<section class="surface monastic-surface"')[0];
  const detail = registry.split('<section class="surface monastic-detail"')[1].split('<script is:inline>')[0];
  assert.equal((editor.match(/class="monastic-section-divider/g) || []).length, 1);
  assert.ok(editor.indexOf('data-career') < editor.indexOf('monastic-editor-divider') && editor.indexOf('monastic-editor-divider') < editor.indexOf('<h3>접근권한'));
  assert.equal((detail.match(/class="monastic-section-divider/g) || []).length, 0);
  assert.match(detail, /class="section-title monastic-part-title"><div><h3>승적 기재사항 변경·정정 이력/);
  assert.match(cert, /class="form-field--full certificate-person-pick"/);
  assert.match(cert, /grid-template-columns:minmax\(0,1fr\) minmax\(0,1fr\)/);
  assert.match(cert, /data-registry-query/);
  assert.match(cert, /operation:'search-registry'/);
  assert.ok(cert.includes("$('[data-preview]').addEventListener('click',()=>{preview(snapshotFromForm())})"));
});
