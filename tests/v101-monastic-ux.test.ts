import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SQLiteD1 } from './support/d1-sqlite.mjs';
import { createSession } from '../functions/_shared/security/sessions';
import { onRequestPost as registryAction } from '../functions/api/monastic-registry/action';
import { onRequestPost as registryQuery } from '../functions/api/monastic-registry/query';
import { onRequestPost as certAction } from '../functions/api/monastic-certificates/action';
import { monasticToday } from '../functions/_shared/monastic';

const origin = 'https://system.example.test';
const call = async (handler: any, db: any, token: string, data: object) => {
  const request = new Request(`${origin}/api/monastic-registry`, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Milgyo-Request': '1',
      ...(token ? { Cookie: `__Host-milgyo_session=${token}` } : {}) }, body: JSON.stringify(data),
  });
  const response = await handler({ request, env: { DB: db }, params: {}, data: {} } as any);
  return { status: response.status, body: await response.json() as any };
};
const example = (overrides: object = {}) => ({
  monasticNo: 'V101-UX-TEST', dharmaNameKo: '테스트법명', dharmaNameHanja: '', layName: '테스트속명',
  birthDate: '1996-02-18', status: '재적', temple: '시험사찰', acquiredDate: '2018-01-01',
  firstRegisteredDate: '2025-01-01', lastVerifiedDate: '2025-01-01',
  ordination: [{ kind: '사미·사미니계', date: '2018-01-01', place: '시험기관', teacher: '확인자', evidence: '자료' }],
  career: [{ fromDate: '2020-01-01', toDate: '2024-12-31', institution: '시험기관', position: '소임', evidence: '임명장' }],
  processingBasis: '동의', sensitiveBasis: '동의', retentionPeriod: '5년', preparedBy: 'user:admin',
  reviewedBy: 'user:admin', approvedBy: 'user:admin', ...overrides,
});
const setup = async () => {
  const db = new SQLiteD1(); const now = new Date().toISOString();
  await db.prepare(`INSERT INTO system_users(id,name,username,password_hash,role,active,position,created_at)
    VALUES ('admin','관리자','admin','unused','admin',1,'이사장',?),('viewer','실무자','viewer','unused','user',1,'실무자',?),('inactive','비활성','inactive','unused','user',0,'실무자',?)`)
    .bind(now, now, now).run();
  const admin = (await createSession(db as any, 'admin')).token;
  const viewer = (await createSession(db as any, 'viewer')).token;
  return { db, admin, viewer };
};

test('계정 선택은 관리자에게만 보이고 사용자 ID를 서버가 검증한다', async () => {
  const {db,admin,viewer}=await setup(); try {
    const denied=await call(registryQuery,db,viewer,{operation:'options'});
    assert.equal(denied.status,403);
    const options=await call(registryQuery,db,admin,{operation:'options'});
    assert.equal(options.status,200);
    assert.ok(options.body.users.find((u:any)=>u.id==='admin'&&u.active===1));
    assert.ok(options.body.users.find((u:any)=>u.id==='inactive'&&u.active===0));
    assert.equal((await call(registryAction,db,admin,{operation:'create',content:example({preparedBy:'user:missing'})})).status,400);
    assert.equal((await call(registryAction,db,admin,{operation:'create',content:example({preparedBy:'user:inactive'})})).status,400);
    assert.equal((await call(registryAction,db,admin,{operation:'create',content:example({preparedBy:'임의 입력'})})).status,400);
  } finally {db.close();}
});

test('서버는 날짜 범위·동의 선택값·보유기간을 검증하고 기존 D1 구조에 저장한다',async()=>{
  const {db,admin}=await setup();try{
    assert.equal((await call(registryAction,db,admin,{operation:'create',content:example({career:[{fromDate:'2025-12-31',toDate:'2024-01-01',institution:'시험'}]})})).status,400);
    assert.equal((await call(registryAction,db,admin,{operation:'create',content:example({ordination:[{kind:'구족계',date:'2025-02-30'}]})})).status,400);
    assert.equal((await call(registryAction,db,admin,{operation:'create',content:example({processingBasis:'임의 문구'})})).status,400);
    assert.equal((await call(registryAction,db,admin,{operation:'create',content:example({retentionPeriod:'25년'})})).status,400);
    const created=await call(registryAction,db,admin,{operation:'create',content:example()});
    assert.equal(created.status,200);
    assert.equal(created.body.row.career[0].fromDate,'2020-01-01');
    assert.equal(created.body.row.career[0].period,'2020-01-01 ~ 2024-12-31');
    assert.equal(created.body.row.prepared_by,'user:admin');
    const detail=await call(registryQuery,db,admin,{operation:'detail',id:created.body.row.id});
    assert.equal(detail.body.changes[0].changeType,'최초 취적');
    const updated=await call(registryAction,db,admin,{operation:'update',id:created.body.row.id,version:created.body.row.version,changeType:'기타 정정',evidenceNote:'계정 선택 확인',content:example({retentionPeriod:'준영구'})});
    assert.equal(updated.status,200);
    assert.equal(updated.body.row.retention_period,'준영구');
  }finally{db.close()}
});

test('비동의를 기록할 수 있으나 대외 승적증명서 발급은 차단한다',async()=>{
  const {db,admin}=await setup();try{
    const created=await call(registryAction,db,admin,{operation:'create',content:example({processingBasis:'비동의'})});
    assert.equal(created.status,200);
    const cert=await call(certAction,db,admin,{operation:'issue',requestId:'v101-consent-test-00001',registryId:created.body.row.id,issueDate:monasticToday(),purpose:'제출',signatoryTitle:'이사장',signatoryUserId:'admin'});
    assert.equal(cert.status,409);
    assert.match(cert.body.message,/동의하지 않은/);
  }finally{db.close()}
});

test('화면은 A4 출력·날짜 수기입력·행별 이력·계정 선택을 제공하고 관리 페이지 공통 기능을 변경하지 않는다',()=>{
  const source=readFileSync('src/pages/monastic-register.astro','utf8');
  assert.match(source,/data-monastic-date/);
  assert.match(source,/inputmode="numeric"/);
  assert.match(source,/data-monastic-calendar/);
  assert.match(source,/data-detail-ordination/);
  assert.match(source,/data-detail-career/);
  assert.match(source,/const changeRows=change/);
  assert.match(source,/min-width:1000px/);
  assert.match(source,/@page\{size:A4 portrait/);
  assert.match(source,/210mm/);
  assert.match(source,/monastic-info-table/);
  for(const field of ['preparedBy','reviewedBy','approvedBy','processingBasis','sensitiveBasis','retentionPeriod']){
    assert.match(source,new RegExp(`<select data-field="${field}"`));
  }
  assert.doesNotMatch(source,/<input type="date" data-field="(?:birthDate|acquiredDate|firstRegisteredDate|lastVerifiedDate)"/);
});

test('원부 상세는 실제 표로 표시하고 정정 내역은 변경 항목마다 한 줄씩 나뉜다',()=>{
  const source=readFileSync('src/pages/monastic-register.astro','utf8');
  const from=source.indexOf('      const labels='); const to=source.indexOf('      const loadDetail=async id=>',from);
  assert.ok(from>0&&to>from);
  const esc=(v:any)=>String(v??'').replace(/[&<>"']/g,(c:string)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'} as any)[c]);
  const api=new Function('esc','accountName',`${source.slice(from,to)};return {visible,changeRows,historyCells}`)(esc,(v:string)=>v) as any;
  const summary=api.visible({register_no:'시험-001',monastic_no:'TEST',lay_name:'시험자'});
  assert.match(summary,/<table class="data-table monastic-info-table">/);
  assert.match(summary,/종단명/);
  assert.match(summary,/대한불교밀교종/);
  assert.equal(api.changeRows({changeType:'최초 취적',before:{},after:{monasticNo:'TEST'}}).length,1);
  const event={changeDate:'2026-10-18',changeType:'수계 정정',actorName:'담당자',evidenceNote:'증빙 확인',
    before:{temple:'옛사찰',ordination_json:JSON.stringify([{kind:'구족계',date:'2020-01-01',teacher:'구계사'}])},
    after:{temple:'새사찰',ordination_json:JSON.stringify([{kind:'구족계',date:'2020-01-01',teacher:'신계사'}])}};
  const changes=api.changeRows(event);
  assert.equal(changes.length,2);
  assert.deepEqual(changes.map((c:any)=>c.label),['재적 사찰','수계·법계 1 · 계사·확인자']);
  assert.equal((api.historyCells(event).match(/<tr>/g)||[]).length,2);
  assert.doesNotMatch(api.historyCells(event),/ordination_json|monasticNo/);
});

test('날짜 수기 입력은 작성 중 자동 변형하지 않고 완료 시 8자리 및 점·하이픈을 검증한다',()=>{
  const source=readFileSync('src/pages/monastic-register.astro','utf8');
  const from=source.indexOf('      const isIsoDate='); const to=source.indexOf('      const dateControl=',from);
  const date=new Function(`${source.slice(from,to)};return {isIsoDate,normalizeDate}`)() as any;
  assert.equal(date.normalizeDate('20261018'),'2026-10-18');
  assert.equal(date.normalizeDate('2026.10.18'),'2026-10-18');
  assert.equal(date.normalizeDate('2026-10-18'),'2026-10-18');
  assert.equal(date.normalizeDate('20260229'),null);
  assert.equal(date.normalizeDate('20240131'),'2024-01-31');
  assert.equal(date.normalizeDate('20000229'),'2000-02-29');
  assert.equal(date.normalizeDate('2026-10'),null);
});

test('기존 Preview 원부의 자유입력 담당자 기록을 정정 시 손실 없이 보존한다',async()=>{
  const {db,admin}=await setup();try{
    const created=await call(registryAction,db,admin,{operation:'create',content:example()});
    assert.equal(created.status,200);
    await db.prepare("UPDATE monastic_registry SET prepared_by='기존 작성자',reviewed_by='기존 검토자',approved_by='기존 승인자' WHERE id=?")
      .bind(created.body.row.id).run();
    const legacy={preparedBy:'기존 작성자',reviewedBy:'기존 검토자',approvedBy:'기존 승인자'};
    const changed=await call(registryAction,db,admin,{operation:'update',id:created.body.row.id,version:1,changeType:'기타 정정',evidenceNote:'기존 기록 보존 확인',content:example({temple:'수정된 사찰',...legacy})});
    assert.equal(changed.status,200);
    assert.equal(changed.body.row.prepared_by,'기존 작성자');
    assert.equal(changed.body.row.reviewed_by,'기존 검토자');
    const invalid=await call(registryAction,db,admin,{operation:'update',id:created.body.row.id,version:2,changeType:'기타 정정',evidenceNote:'검증',content:example({...legacy,preparedBy:'임의 입력'})});
    assert.equal(invalid.status,400);
  }finally{db.close()}
});

test('기존 자유입력 활동 기간도 시작일·종료일로 안전하게 분리한다',()=>{
  const source=readFileSync('src/pages/monastic-register.astro','utf8');
  const from=source.indexOf('      const isIsoDate='),to=source.indexOf('      const dateControl=',from);
  const parseFrom=source.indexOf('      const parsePeriod='),parseTo=source.indexOf('      const careerRow=',parseFrom);
  const fn=new Function(`${source.slice(from,to)};${source.slice(parseFrom,parseTo)};return parsePeriod`)() as any;
  assert.deepEqual(fn({period:'2018.01.01.~2026.01.01'}),{from:'2018-01-01',to:'2026-01-01',legacy:''});
  assert.deepEqual(fn({period:'2020-2025'}),{from:'',to:'',legacy:'2020-2025'});
});
