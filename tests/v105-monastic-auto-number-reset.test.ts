import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { SQLiteD1 } from './support/d1-sqlite.mjs';
import { createSession } from '../functions/_shared/security/sessions';
import { onRequestPost as registryAction } from '../functions/api/monastic-registry/action';
import { onRequestPost as registryQuery } from '../functions/api/monastic-registry/query';
import { onRequestPost as certAction } from '../functions/api/monastic-certificates/action';
import { getTestResetPreview, resetAllTestData } from '../functions/_shared/test-data-reset';
import { monasticToday, monasticNumberPrefix } from '../functions/_shared/monastic';

const origin = 'https://system.example.test';
const call = async (handler: any, db: any, token: string, data: object) => {
  const request = new Request(`${origin}/api/monastic-registry`, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Milgyo-Request': '1',
      ...(token ? {Cookie: `__Host-milgyo_session=${token}`} : {})}, body: JSON.stringify(data),
  });
  const response = await handler({request, env: {DB: db}, params: {}, data: {}} as any);
  return {status: response.status, body: await response.json() as any};
};
const form = (override: Record<string, any> = {}) => ({
  ordinationRound: '01', monasticNo: '0191-999', dharmaNameKo: '문성', layName: '테스트', status: '재적',
  temple: '가상사찰', acquiredDate: '1992-04-01',
  ordination: [{kind: '사미·사미니계', date: '1991-06-01'}], career: [],
  processingBasis: '동의', sensitiveBasis: '동의', retentionPeriod: '5년', ...override,
});
const setup = async () => {
  const db = new SQLiteD1();
  await db.prepare(`INSERT INTO system_users(id,name,username,password_hash,role,active,position,created_at)
    VALUES ('admin','관리자','admin','unused','admin',1,'이사장',?)`)
    .bind(new Date().toISOString()).run();
  return {db, token: (await createSession(db as any, 'admin')).token};
};

class ListableR2 {
  objects = new Map<string, Uint8Array>();
  deleted: string[] = [];
  async put(key: string, bytes: Uint8Array) {this.objects.set(key, bytes)}
  async delete(keys: string | string[]) {
    for (const key of Array.isArray(keys) ? keys : [keys]) { this.deleted.push(key);this.objects.delete(key); }
  }
  async list({prefix = ''}: {prefix?: string}) {
    return {objects: [...this.objects.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({key})), truncated: false};
  }
}
const setupAccounting = () => {
  const db = new SQLiteD1({migrate: false});
  for (const file of readdirSync('migrations/accounting').filter((name) => name.endsWith('.sql')).sort()) {
    db.sqlite.exec(readFileSync(`migrations/accounting/${file}`, 'utf8'));
  }
  return db;
};

test('계단 회차 01~30과 1991년 수계로 0191-001부터 자동 채번되며 수기 번호는 무시한다', async () => {
  const {db, token} = await setup();
  try {
    const preview = await call(registryQuery, db, token, {operation:'number-preview', ordinationRound:'01', acquiredDate:'1992-04-01', ordination:[{kind:'사미·사미니계',date:'1991-06-01'}]});
    assert.equal(preview.status, 200);assert.equal(preview.body.next, '0191-001');
    const created = await call(registryAction, db, token, {operation:'create', content:form()});
    assert.equal(created.status, 200, created.body.message);
    assert.equal(created.body.row.monastic_no, '0191-001');
    const next = await call(registryQuery, db, token, {operation:'number-preview', ordinationRound:'01', acquiredDate:'1992-04-01', ordination:[{kind:'사미·사미니계',date:'1991-06-01'}]});
    assert.equal(next.body.next, '0191-002');
    assert.equal((await call(registryAction, db, token, {operation:'create',content:form({ordinationRound:'00'})})).status, 400);
    assert.equal((await call(registryAction, db, token, {operation:'create',content:form({ordinationRound:'31'})})).status, 400);
    assert.equal(monasticNumberPrefix('30', '2026'), '3026-');
  } finally {db.close()}
});

test('기존 0191-111이 있으면 이어서 0191-112 발급하고, 수계일 없으면 취득 연도로 부여한다', async () => {
  const {db, token} = await setup();
  try {
    const old = await call(registryAction, db, token, {operation:'create', content:form()});
    await db.prepare("UPDATE monastic_registry SET monastic_no='0191-111' WHERE id=?").bind(old.body.row.id).run();
    const proposed = await call(registryQuery, db, token, {operation:'number-preview', ordinationRound:'01', acquiredDate:'1992-04-01', ordination:form().ordination});
    assert.equal(proposed.body.next, '0191-112');
    const second = await call(registryAction, db, token, {operation:'create', content:form({dharmaNameKo:'다른법명'})});
    assert.equal(second.body.row.monastic_no, '0191-112');
    const fallback = await call(registryAction, db, token, {operation:'create',content:form({ordinationRound:'02',ordination:[], acquiredDate:'2026-02-01'})});
    assert.equal(fallback.body.row.monastic_no, '0226-001');
    const priorEdit = await call(registryAction, db, token, {operation:'update', id:old.body.row.id, version:old.body.row.version,changeType:'기타 정정',evidenceNote:'기존 번호 보존 확인',content:form({monasticNo:'0191-111', temple:'수정사찰'})});
    assert.equal(priorEdit.status, 200, priorEdit.body.message);
    assert.equal(priorEdit.body.row.monastic_no, '0191-111');
  } finally {db.close()}
});

test('같은 계단·연도에서 동시 채번 요청도 서로 다른 번호를 확보한다', async () => {
  const {db} = await setup();
  try {
    const {nextMonasticNumber} = await import('../functions/_shared/monastic');
    const numbers = await Promise.all(Array.from({length:5}, () => nextMonasticNumber(db as any, '03', '2025', true)));
    assert.deepEqual([...numbers].sort(), ['0325-001','0325-002','0325-003','0325-004','0325-005']);
    assert.equal(await nextMonasticNumber(db as any,'03','2025',false), '0325-006');
  } finally {db.close()}
});

test('일괄 초기화 미리보기에 원부·변경이력·발급대장·첨부 R2를 포함하고 전체삭제 검증도 통과한다', async () => {
  const {db, token} = await setup();const acct=setupAccounting();
  const files=new ListableR2(),accountingFiles=new ListableR2();
  try {
    const created=await call(registryAction,db,token,{operation:'create',content:form()});
    assert.equal(created.status,200);
    const registryId=created.body.row.id;
    const issued=await call(certAction,db,token,{operation:'issue',requestId:'v105-reset-issue-001',registryId,issueDate:monasticToday(),purpose:'테스트',signatoryTitle:'이사장',signatoryUserId:'admin'});
    assert.equal(issued.status,200,issued.body.message);
    await db.prepare(`INSERT INTO monastic_registry_attachments(id,registry_id,file_name,mime_type,size_bytes,storage_type,data_base64,r2_key,actor_user_id,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).bind('TATT',''+registryId,'검증.pdf','application/pdf',12,'r2','','monastic-registry/TEST/TATT.pdf','admin',new Date().toISOString()).run();
    await files.put('monastic-registry/TEST/TATT.pdf',new TextEncoder().encode('test-data'));
    await files.put('monastic-registry/TEST/ORPHAN.pdf',new TextEncoder().encode('orphan'));
    await files.put('non-reset-folder/keep.pdf',new TextEncoder().encode('keep'));
    const env={DB:db,ACCOUNTING_DB:acct,FILES:files,ACCOUNTING_FILES:accountingFiles};
    const preview=await getTestResetPreview(env as any);
    assert.equal(preview.main.monasticRegistry,1);
    assert.equal(preview.main.monasticRegistryChanges,1);
    assert.equal(preview.main.monasticCertificates,1);
    assert.equal(preview.main.monasticRegistryAttachments,1);
    assert.ok(preview.main.r2Objects>=2);
    const result=await resetAllTestData(env as any,{name:'관리자'} as any);
    assert.equal(result.verified,true,JSON.stringify(result.verification.main));
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM monastic_registry').get().n,0);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM monastic_certificates').get().n,0);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM document_sequences WHERE seq_key LIKE 'MONASTIC:%'").get().n,0);
    assert.equal(files.objects.has('monastic-registry/TEST/TATT.pdf'),false);
    assert.equal(files.objects.has('monastic-registry/TEST/ORPHAN.pdf'),false);
    assert.equal(files.objects.has('non-reset-folder/keep.pdf'),true,'승적관리 이외 R2 영역은 건드리지 않음');
  } finally {acct.close();db.close()}
});

test('미리보기 인쇄에는 직인 이미지와 테스트 워터마크가 함께 존재한다',()=>{
  const page=readFileSync('src/pages/monastic-certificates.astro','utf8');
  assert.match(page,/monastic-certificate-seal--preview/);
  assert.match(page,/monastic-certificate-test-watermark/);
  assert.match(page,/organization-seal\.png/);
  assert.doesNotMatch(page,/\$\{previewMode\?'':'<img class="monastic-certificate-seal"/);
});
