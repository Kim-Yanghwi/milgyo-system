import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read=(path:string)=>fs.readFileSync(path,'utf8');

test('V92 adds the appointment/commendation issue page and sidebar menu',()=>{
  const page=read('src/pages/appointment-awards.astro');
  const layout=read('src/layouts/ManagementLayout.astro');
  assert.match(page,/임명장·표창장 발급·대장/);
  assert.match(layout,/appointmentAwards/);
  assert.match(layout,/href="\/appointment-awards"/);
});

test('V92 uses the supplied award-paper image and requested typography sizes',()=>{
  const page=read('src/pages/appointment-awards.astro');
  assert.match(page,/\/certificates\/appointment-award-paper\.png/);
  assert.match(page,/\.award-serial\{[^}]*font-size:14pt/);
  assert.match(page,/\.award-title\{[^}]*font-size:53pt/);
  assert.match(page,/\.award-person\{[^}]*font-size:29pt/);
  assert.match(page,/\.award-body\{[^}]*font-size:29pt/);
  assert.match(page,/\.award-date\{[^}]*ShinMyeongGungseo[^}]*font-size:25pt/);
  assert.match(page,/\.award-issuer\{[^}]*font-size:25pt/);
});

test('V92 switches appointment and commendation content correctly',()=>{
  const page=read('src/pages/appointment-awards.astro');
  assert.match(page,/option value="임명장"/);
  assert.match(page,/option value="표창장"/);
  assert.match(page,/본 \$\{values\.bodyOrganization\|\|'종단'\}의/);
  assert.match(page,/\$\{values\.appointmentPosition\|\|'○ ○ ○'\}에 임명함/);
  assert.match(page,/data-commendation-only/);
  assert.match(page,/표창장 본문/);
});

test('V92 stores and manages a dedicated issuance ledger',()=>{
  const action=read('functions/api/appointment-awards/action.ts');
  const query=read('functions/api/appointment-awards/query.ts');
  const migration=read('migrations/main/0011_v92_appointment_award_certificates.sql');
  for(const source of [action,query,migration])assert.match(source,/appointment_award_certificates/);
  assert.match(action,/operation === 'issue'/);
  assert.match(action,/operation === 'cancel'/);
  assert.match(query,/operation === 'detail'/);
  assert.match(query,/serial_no LIKE/);
  assert.match(migration,/UNIQUE INDEX IF NOT EXISTS idx_appointment_award_serial_no/);
});

test('V92 includes preview, print, reuse and CSV ledger controls',()=>{
  const page=read('src/pages/appointment-awards.astro');
  assert.match(page,/data-preview/);
  assert.match(page,/data-print-current/);
  assert.match(page,/data-row-reuse/);
  assert.match(page,/data-ledger-export/);
  assert.match(page,/@page\{size:A4 portrait;margin:0\}/);
});
