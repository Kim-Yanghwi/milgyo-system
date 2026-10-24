import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SQLiteD1 } from './support/d1-sqlite.mjs';
import { createSession } from '../functions/_shared/security/sessions';
import { ROUTINE_CATEGORY, formatDepartmentDisplay, normalizeDepartmentValue, resolveDepartmentHeadTitle } from '../functions/_shared/helpers';
import { onRequestPost as createDocument } from '../functions/api/documents/create';
import { onRequestPost as decideDocument } from '../functions/api/documents/decide';
import { onRequestPost as decideBatch } from '../functions/api/documents/decide-batch';

const origin = 'https://system.example.test';
const call = async (fn:any, db:any, token:string, payload:object) => {
  const request = new Request(`${origin}/api/documents/action`, {
    method: 'POST', headers: { Origin:origin, 'Content-Type':'application/json', 'X-Milgyo-Request':'1', Cookie:`__Host-milgyo_session=${token}` },
    body: JSON.stringify(payload),
  });
  const response = await fn({ request, env:{ DB:db } } as any);
  return { status:response.status, body:await response.json() as any };
};
const setup = async () => {
  const db = new SQLiteD1();
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO system_users (id,name,username,password_hash,role,position,department,can_approve,active,created_at)
    VALUES ('admin','관리자','admin','x','admin','사무총장','사무처',1,1,?),
           ('chief','원권자','chief','x','user','사무국장','사무처 - 사무국',1,1,?),
           ('deputy','직무대리','deputy','x','user','사무담당','사무처 - 사무국',1,1,?),
           ('other','다른결재자','other','x','admin','재정국장','사무처 - 재정국',1,1,?),
           ('staff','일반담당','staff','x','user','사무담당','사무처 - 사무국',0,1,?)`).bind(now,now,now,now,now).run();
  const tokens:Record<string,string> = {};
  for(const id of ['admin','chief','deputy','other','staff']) tokens[id] = (await createSession(db as any,id)).token;
  return { db, tokens, close:()=>db.close() };
};
const requestFor = (mode:string, overrides:object = {}) => ({
  docType:'기안', category:ROUTINE_CATEGORY, title:`${mode} 일반 행정 보고`, body:'서면결재 시험을 위한 다섯 글자 이상의 본문입니다.',
  department:'사무국', approvalMode:mode,
  approverUserId:'deputy', actingForUserId:'chief', actingReason:'이사장 지정문서 2026-001, 출장에 따른 기간 대행',
  formData:{ _actingForName:'거짓 이름', _actingDesignatedBy:'거짓 관리자', _actingReason:'위조' },
  ...overrides,
});

test('V110 display is short but persisted hierarchy, department head and legacy input are unchanged', () => {
  for (const text of ['사무국','사무처(사무국)','사무처 - 사무국']) {
    assert.equal(normalizeDepartmentValue(text),'사무처 - 사무국');
    assert.equal(formatDepartmentDisplay(text),'사무국');
    assert.equal(resolveDepartmentHeadTitle(text),'사무국장');
  }
  assert.equal(formatDepartmentDisplay('사무처'),'사무처');
  assert.equal(formatDepartmentDisplay('사무처 - 재정국'),'사무처(재정국)');
  const html=readFileSync('src/pages/index.astro','utf8');
  for(const mode of ['결재','전결','대결','전대결']) assert.ok(html.includes(`name="approvalMode" value="${mode}"`));
  assert.doesNotMatch(html,/child\s*===\s*'사무국'\s*\?\s*`\$\{dep.name\}/);
});

for (const [mode,status,track] of [['대결','결재대기','일반결재'],['전대결','전결대기','전결']] as const) {
  test(`V110 ${mode}: admin designates authority, only deputy signs, event and printed metadata remain distinct`,async()=>{
    const s=await setup();try{
      const created=await call(createDocument,s.db,s.tokens.admin,requestFor(mode));
      assert.equal(created.status,200,JSON.stringify(created.body));
      const doc=s.db.sqlite.prepare('SELECT * FROM documents WHERE id=?').get(created.body.id) as any;
      const data=JSON.parse(doc.form_data_json);
      assert.equal(doc.department,'사무처 - 사무국');
      assert.equal(doc.approval_mode,mode);assert.equal(doc.approval_track,track);assert.equal(doc.status,status);
      assert.equal(doc.access_scope,'관련자');
      assert.equal(data._actingForUserId,'chief');assert.equal(data._actingForName,'원권자');
      assert.equal(data._actingDesignatedBy,'관리자');
      assert.equal(data._actingReason,requestFor(mode).actingReason);
      assert.equal(s.db.sqlite.prepare('SELECT line_type FROM document_approval_lines WHERE document_id=?').get(doc.id).line_type,mode);
      assert.equal((await call(decideDocument,s.db,s.tokens.admin,{id:doc.id,action:'승인'})).status,403,'admin must not impersonate deputy');
      assert.equal((await call(decideDocument,s.db,s.tokens.other,{id:doc.id,action:'승인'})).status,403);
      const approved=await call(decideDocument,s.db,s.tokens.deputy,{id:doc.id,action:'승인'});
      assert.equal(approved.status,200,JSON.stringify(approved.body));
      assert.equal(approved.body.action,mode);
      assert.equal(s.db.sqlite.prepare('SELECT status FROM documents WHERE id=?').get(doc.id).status,'승인');
      const event=s.db.sqlite.prepare(`SELECT * FROM document_approvals WHERE document_id=? AND action=?`).get(doc.id,mode) as any;
      assert.equal(event.approver_name,'직무대리');
    }finally{s.close()}
  });
}

test('V110 proxy submission rejects user-supplied authority and illegitimate delegation',async()=>{
  const s=await setup();try{
    assert.equal((await call(createDocument,s.db,s.tokens.staff,requestFor('대결'))).status,403);
    assert.equal((await call(createDocument,s.db,s.tokens.admin,requestFor('대결',{actingReason:'짧음'}))).status,400);
    assert.equal((await call(createDocument,s.db,s.tokens.admin,requestFor('대결',{actingForUserId:'deputy'}))).status,400);
    assert.equal((await call(createDocument,s.db,s.tokens.admin,requestFor('전대결',{actingForUserId:'staff'}))).status,400);
    assert.equal((await call(createDocument,s.db,s.tokens.admin,requestFor('대결',{approverUserId:'admin'}))).status,400);
    const normal=await call(createDocument,s.db,s.tokens.admin,requestFor('결재'));
    assert.equal(normal.status,200,JSON.stringify(normal.body));
    const formData=JSON.parse((s.db.sqlite.prepare('SELECT form_data_json FROM documents WHERE id=?').get(normal.body.id) as any).form_data_json);
    assert.equal(formData._actingForName,undefined);
  }finally{s.close()}
});

test('V110 proxy prevents bulk-admin impersonation and blocks revoked deputy privilege',async()=>{
  const s=await setup();try{
    const a=await call(createDocument,s.db,s.tokens.admin,requestFor('대결'));
    assert.equal(a.status,200,JSON.stringify(a.body));
    const blocked=await call(decideBatch,s.db,s.tokens.admin,{ids:[a.body.id],action:'승인'});
    assert.equal(blocked.status,400,'admin cannot bulk-sign for the delegated user');
    await s.db.prepare('UPDATE system_users SET can_approve=0 WHERE id=?').bind('deputy').run();
    assert.ok([401,403].includes((await call(decideDocument,s.db,s.tokens.deputy,{id:a.body.id,action:'승인'})).status), 'revoked signing privilege must fail closed');
  }finally{s.close()}
});

test('V110 delegated approver can complete batch action; audit records actual acting person', async()=>{
  const s=await setup();try{
    const created=await call(createDocument,s.db,s.tokens.admin,requestFor('전대결'));
    assert.equal(created.status,200,JSON.stringify(created.body));
    const done=await call(decideBatch,s.db,s.tokens.deputy,{ids:[created.body.id],action:'승인'});
    assert.equal(done.status,200,JSON.stringify(done.body));
    assert.equal(done.body.processed,1);
    const row=s.db.sqlite.prepare('SELECT status,approval_mode FROM documents WHERE id=?').get(created.body.id) as any;
    assert.equal(row.status,'승인');
    assert.equal(row.approval_mode,'전대결');
    const audit=s.db.sqlite.prepare('SELECT action,approver_name FROM document_approvals WHERE document_id=? AND action=?').get(created.body.id,'전대결') as any;
    assert.equal(audit.action,'전대결');
    assert.equal(audit.approver_name,'직무대리');
  }finally{s.close()}
});
