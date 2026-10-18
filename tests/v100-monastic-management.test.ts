import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SQLiteD1, TestR2 } from './support/d1-sqlite.mjs';
import { createSession } from '../functions/_shared/security/sessions';
import { onRequestPost as registryAction } from '../functions/api/monastic-registry/action';
import { onRequestPost as registryQuery } from '../functions/api/monastic-registry/query';
import { onRequestPost as evidenceUpload } from '../functions/api/monastic-registry/upload-attachment';
import { onRequestPost as evidenceDownload } from '../functions/api/monastic-registry/attachment-data';
import { onRequestPost as evidenceDelete } from '../functions/api/monastic-registry/delete-attachment';
import { onRequestPost as certAction } from '../functions/api/monastic-certificates/action';
import { onRequestPost as certQuery } from '../functions/api/monastic-certificates/query';
import { monasticToday } from '../functions/_shared/monastic';

const origin = 'https://system.example.test';
const call = async (handler: any, db: any, token: string, data: object, files?: any) => {
  const request = new Request(`${origin}/api/monastic-${handler === certAction || handler === certQuery ? 'certificates' : 'registry'}/query`, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Milgyo-Request': '1',
      ...(token ? { Cookie: `__Host-milgyo_session=${token}` } : {}) }, body: JSON.stringify(data),
  });
  const response = await handler({ request, env: { DB: db, FILES: files }, params: {}, data: {} } as any);
  return { status: response.status, body: response.headers.get('content-type')?.includes('json') ? await response.json() : await response.arrayBuffer() };
};
const sample = (overrides: object = {}) => ({
  monasticNo: '승적-TEST-001', dharmaNameKo: '법광', dharmaNameHanja: '法光', layName: '홍길동',
  birthDate: '1980-03-05', status: '재적', temple: '향천사', acquiredDate: '2020-01-01',
  mentorName: '은사', positionTitle: '주지', contact: '010-1234-5678', managingOffice: '총무원',
  firstRegisteredDate: '2020-01-01', lastVerifiedDate: '2020-02-01',
  ordination: [{ kind: '사미·사미니계', date: '2019-01-01', place: '종단', teacher: '계사', evidence: '수계증명' }],
  career: [{ period: '2020-2025', institution: '향천사', position: '주지', evidence: '임명장' }],
  accessScope: '승적관리 담당자', processingBasis: '동의서 확인', sensitiveBasis: '별도 동의서 확인',
  retentionPeriod: '보존정책 확인', storageLocation: '비공개 내부 관리',
  preparedBy: '관리자', reviewedBy: '검토자', approvedBy: '승인자', ...overrides,
});
const setup = async () => {
  const db = new SQLiteD1();
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO system_users(id,name,username,password_hash,role,active,position,department,created_at)
    VALUES('admin','테스트 관리자','admin','not-for-login','admin',1,'이사장','이사장',?),('viewer','열람금지','viewer','not-for-login','user',1,'실무자','사무처',?)`)
    .bind(now, now).run();
  const admin = (await createSession(db as any, 'admin')).token;
  const viewer = (await createSession(db as any, 'viewer')).token;
  return { db, admin, viewer, close: () => db.close() };
};

test('승적원부·증명서 신규 DB 구조 및 사이드 메뉴 위치가 정확하다', async () => {
  const db = new SQLiteD1();
  try {
    const tables = db.sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'monastic_%' ORDER BY name`).all();
    assert.equal(tables.length, 4);
    const layout = readFileSync('src/layouts/ManagementLayout.astro', 'utf8');
    const home = readFileSync('src/pages/index.astro', 'utf8');
    assert.ok(layout.indexOf('href="/register-management"') < layout.indexOf('href="/monastic-register"'));
    assert.ok(layout.indexOf('href="/monastic-register"') < layout.indexOf('href="/vehicle-register"'));
    assert.ok(layout.indexOf('href="/employee-certificates"') < layout.indexOf('href="/monastic-certificates"'));
    assert.ok(layout.indexOf('href="/monastic-certificates"') < layout.indexOf('href="/ordination-certificates"'));
    for (const sidebar of [layout, home]) {
      assert.ok(sidebar.indexOf('href="/register-management"') < sidebar.indexOf('href="/monastic-register"'));
      assert.ok(sidebar.indexOf('href="/monastic-register"') < sidebar.indexOf('href="/vehicle-register"'));
      assert.ok(sidebar.indexOf('href="/employee-certificates"') < sidebar.indexOf('href="/monastic-certificates"'));
      assert.ok(sidebar.indexOf('href="/monastic-certificates"') < sidebar.indexOf('href="/ordination-certificates"'));
    }
  } finally { db.close(); }
});

test('원부는 관리자만 등록·열람할 수 있으며 서식 검증과 중복 방어를 적용한다', async () => {
  const s = await setup(); try {
    const unauth = await call(registryAction, s.db, '', { operation: 'create', content: sample() });
    assert.equal(unauth.status, 401);
    const viewer = await call(registryAction, s.db, s.viewer, { operation: 'create', content: sample() });
    assert.equal(viewer.status, 403);
    assert.equal((await call(registryQuery, s.db, s.viewer, { operation: 'list' })).status, 403);
    assert.equal((await call(registryAction, s.db, s.admin, { operation: 'create', content: sample({ sensitiveBasis: '' }) })).status, 400);
    assert.equal((await call(registryAction, s.db, s.admin, { operation: 'create', content: sample({ birthDate: '2020-02-31' }) })).status, 400);
    const created = await call(registryAction, s.db, s.admin, { operation: 'create', content: sample() });
    assert.equal(created.status, 200);assert.ok(created.body.ok);assert.match(created.body.row.register_no, /^승적원부-\d{4}-\d{5}$/);
    assert.equal((await call(registryAction, s.db, s.admin, { operation: 'create', content: sample() })).status, 409);
    const listed = await call(registryQuery, s.db, s.admin, { operation: 'list' });
    assert.equal(listed.body.total, 1);assert.equal(listed.body.rows[0].dharma_name_ko, '법광');
    const detail = await call(registryQuery, s.db, s.admin, { operation: 'detail', id: created.body.row.id });
    assert.equal(detail.body.changes.length, 1);assert.equal(detail.body.row.ordination[0].kind, '사미·사미니계');
  } finally { s.close(); }
});

test('원부 정정은 변경이력을 보존하고 낡은 버전으로 덮어쓸 수 없다', async () => {
  const s = await setup(); try {
    const created = (await call(registryAction, s.db, s.admin, { operation: 'create', content: sample() })).body.row;
    const edited = await call(registryAction, s.db, s.admin, { operation: 'update', id: created.id, version: created.version,
      changeType: '재적 변경', evidenceNote: '변경 신청서 및 승인기록 확인', content: sample({ temple: '화엄사' }) });
    assert.equal(edited.status, 200);assert.equal(edited.body.row.temple, '화엄사');
    assert.equal(edited.body.row.version, 2);
    const stale = await call(registryAction, s.db, s.admin, { operation: 'update', id: created.id, version: created.version,
      changeType: '법명 변경', evidenceNote: '근거 확인', content: sample({ dharmaNameKo: '다른법명' }) });
    assert.equal(stale.status, 409);
    const detail = await call(registryQuery, s.db, s.admin, { operation: 'detail', id: created.id });
    assert.equal(detail.body.changes.length, 2);
    assert.equal(detail.body.changes[0].before.temple, '향천사');
    assert.equal(detail.body.changes[0].after.temple, '화엄사');
  } finally { s.close(); }
});

test('발급번호·문서 스냅샷·재발급 중복·취소·비재적 거부가 정상이다', async () => {
  const s = await setup(); try {
    const created = (await call(registryAction, s.db, s.admin, { operation: 'create', content: sample() })).body.row;
    const issue = { operation: 'issue', requestId: 'one-unique-request-001', registryId: created.id,
      issueDate: monasticToday(), purpose: '기관 제출', signatoryTitle: '이사장', signatoryUserId: 'admin',
      includeLogoSqSeal: true, managerName: '담당자', contact: '000-0000' };
    const first = await call(certAction, s.db, s.admin, issue);
    assert.equal(first.status, 200);assert.ok(first.body.ok);assert.match(first.body.row.certificate_no, /^승적-\d{4}-\d{5}$/);
    const snapshot = JSON.parse(first.body.row.certificate_snapshot);
    assert.equal(snapshot.dharmaName, '법광');assert.equal(snapshot.layName, '홍길동');assert.equal(snapshot.includeLogo, true);
    assert.ok(!JSON.stringify(snapshot).includes('010-1234-5678'));
    assert.ok(!JSON.stringify(snapshot).includes('1980-03-05'));
    assert.ok(!JSON.stringify(snapshot).includes('mentorName'));
    const repeated = await call(certAction, s.db, s.admin, issue);
    assert.equal(repeated.body.repeated, true);assert.equal(repeated.body.row.certificate_no, first.body.row.certificate_no);
    assert.equal((await call(certAction, s.db, s.viewer, { ...issue, requestId: 'different-id-1234' })).status, 403);
    const revoked = await call(registryAction, s.db, s.admin, { operation: 'update', id: created.id, version: created.version,
      changeType: '제적', evidenceNote: '제적 처리 승인', content: sample({ status: '제적' }) });
    assert.equal(revoked.status, 200);
    const blocked = await call(certAction, s.db, s.admin, { ...issue, requestId: 'new-unique-request-002' });
    assert.equal(blocked.status, 409);
    const existing = await call(certQuery, s.db, s.admin, { operation: 'detail', id: first.body.row.id });
    assert.equal(JSON.parse(existing.body.row.certificate_snapshot).status, '재적');
    const canceled = await call(certAction, s.db, s.admin, { operation: 'cancel', id: first.body.row.id, reason: '발급내용 재검토' });
    assert.equal(canceled.status, 200);
    const canceledDetail = await call(certQuery, s.db, s.admin, { operation: 'detail', id: first.body.row.id });
    assert.equal(canceledDetail.body.row.status, '취소');
  } finally { s.close(); }
});

test('승적 증명서 대장 표시도 발급 당시 내용을 그대로 유지한다', async () => {
  const s = await setup(); try {
    const created = (await call(registryAction, s.db, s.admin, { operation: 'create', content: sample() })).body.row;
    const issued = await call(certAction, s.db, s.admin, { operation: 'issue', requestId: 'historical-view-test-001',
      registryId: created.id, issueDate: monasticToday(), purpose: '종단 제출', signatoryTitle: '이사장', signatoryUserId: 'admin' });
    assert.equal(issued.status, 200);
    const edited = await call(registryAction, s.db, s.admin, { operation: 'update', id: created.id, version: created.version,
      changeType: '재적 변경', evidenceNote: '자료 대조 및 승인', content: sample({ temple: '새사찰', dharmaNameKo: '새법명' }) });
    assert.equal(edited.status, 200);
    const ledger = await call(certQuery, s.db, s.admin, { operation: 'list' });
    assert.equal(ledger.status, 200);
    assert.equal(ledger.body.rows[0].temple, '향천사');
    assert.equal(ledger.body.rows[0].dharma_name_ko, '법광');
    const filter = await call(certQuery, s.db, s.admin, { operation: 'list', query: '법광' });
    assert.equal(filter.body.total, 1);
  } finally { s.close(); }
});

test('대외발급은 지정된 직위·적법한 날짜만 허용하고 발급 권한을 재확인한다', async () => {
  const s = await setup(); try {
    const created = (await call(registryAction, s.db, s.admin, { operation: 'create', content: sample() })).body.row;
    const standard = { operation: 'issue', requestId: 'signer-basis-test-001', registryId: created.id,
      issueDate: monasticToday(), purpose: '사찰 제출', signatoryTitle: '이사장', signatoryUserId: 'admin' };
    assert.equal((await call(certAction, s.db, s.admin, { ...standard, signatoryUserId: 'viewer' })).status, 403);
    assert.equal((await call(certAction, s.db, s.admin, { ...standard, signatoryTitle: '이사장 직무대리' })).status, 403);
    assert.equal((await call(certAction, s.db, s.admin, { ...standard, issueDate: '2015-01-01' })).status, 400);
    assert.equal((await call(certAction, s.db, s.admin, { ...standard, issueDate: '2099-01-01' })).status, 400);
    assert.equal((await call(certAction, s.db, s.admin, { ...standard, purpose: ' ' })).status, 400);
    const options = await call(certQuery, s.db, s.admin, { operation: 'options' });
    assert.equal(options.status, 200);
    assert.equal(options.body.signatories.length, 1);
    assert.equal(options.body.signatories[0].position, '이사장');
    const issued = await call(certAction, s.db, s.admin, standard);
    assert.equal(issued.status, 200);
    assert.equal(issued.body.row.signatory_name, '테스트 관리자');
    const audit = s.db.sqlite.prepare("SELECT action FROM management_audit_logs WHERE category='승적증명서' ORDER BY created_at").all();
    assert.equal(audit.length, 1);
    assert.equal(audit[0].action, '발급');
  } finally { s.close(); }
});

test('비공개 원부 증빙은 위조 파일형식과 민감정보 무권한 접근을 거부한다', async () => {
  const s = await setup(); try {
    const created = (await call(registryAction, s.db, s.admin, { operation: 'create', content: sample() })).body.row;
    const invalid = await call(evidenceUpload, s.db, s.admin, { registryId: created.id,
      fileName: '위조.pdf', dataBase64: Buffer.from('not a pdf').toString('base64') }, new TestR2());
    assert.equal(invalid.status, 400);
    assert.equal((await call(registryQuery, s.db, s.viewer, { operation: 'detail', id: created.id })).status, 403);
    assert.equal((await call(certQuery, s.db, s.viewer, { operation: 'options' })).status, 403);
    assert.equal((await call(certQuery, s.db, '', { operation: 'list' })).status, 401);
  } finally { s.close(); }
});

test('승적 증빙파일은 R2 우선 저장·세션 검증·다운로드·삭제를 적용한다', async () => {
  const s = await setup(); try {
    const bucket = new TestR2();
    const created = (await call(registryAction, s.db, s.admin, { operation: 'create', content: sample() })).body.row;
    const file = Buffer.from('%PDF-1.7\nTEST');
    const payload = { registryId: created.id, fileName: '수계증빙.pdf', dataBase64: file.toString('base64'), evidenceType: '수계증빙', verifiedDate: monasticToday() };
    assert.equal((await call(evidenceUpload, s.db, s.viewer, payload, bucket)).status, 403);
    const uploaded = await call(evidenceUpload, s.db, s.admin, payload, bucket);
    assert.equal(uploaded.status, 200);
    assert.equal(bucket.objects.size, 1);
    const attachmentId = uploaded.body.id;
    assert.equal((await call(evidenceDownload, s.db, s.viewer, { attachmentId }, bucket)).status, 403);
    const download = await call(evidenceDownload, s.db, s.admin, { attachmentId }, bucket);
    assert.equal(download.status, 200);
    assert.deepEqual(Buffer.from(download.body), file);
    assert.equal((await call(evidenceDelete, s.db, s.admin, { attachmentId }, bucket)).status, 200);
    assert.equal(bucket.objects.size, 0);
    assert.equal((await call(evidenceDownload, s.db, s.admin, { attachmentId }, bucket)).status, 404);
  } finally { s.close(); }
});

test('승적 증빙은 R2 미연결 시 D1 소형 파일 저장도 지원한다', async () => {
  const s = await setup(); try {
    const created = (await call(registryAction, s.db, s.admin, { operation: 'create', content: sample() })).body.row;
    const file = Buffer.from('%PDF-1.7\nTEST');
    const uploaded = await call(evidenceUpload, s.db, s.admin, { registryId: created.id, fileName: '확인.pdf', dataBase64: file.toString('base64') });
    assert.equal(uploaded.status, 200);
    const stored = s.db.sqlite.prepare('SELECT storage_type,data_base64 FROM monastic_registry_attachments WHERE id=?').get(uploaded.body.id);
    assert.equal(stored.storage_type, 'd1');assert.equal(stored.data_base64, file.toString('base64'));
    const download = await call(evidenceDownload, s.db, s.admin, { attachmentId: uploaded.body.id });
    assert.deepEqual(Buffer.from(download.body), file);
  } finally { s.close(); }
});

test('대외증명서 발급 화면은 재직증명서와 동일한 로고·직인 이미지를 사용한다', () => {
  const cert = readFileSync('src/pages/monastic-certificates.astro', 'utf8');
  const registry = readFileSync('src/pages/monastic-register.astro', 'utf8');
  assert.match(cert, /certificates\/logo-sq\.png/);assert.match(cert, /organization-seal\.png/);
  assert.match(cert, /monastic-certificate-seal\{[^}]*right:-62px;top:2px;width:98px;height:98px/);
  assert.match(cert, /@page\{size:A4;margin:0\}/);
  assert.match(cert, /미리보기·미발급/);
  assert.match(cert, /previewMode\?'':/);
  assert.match(registry, /monastic-registry\/upload-attachment/);
  assert.match(registry, /승적자료 · 비공개 내부 관리/);
});
