import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const page = readFileSync('src/pages/index.astro', 'utf8');

const extractFunction = (startMarker: string, endMarker: string, functionName: string) => {
  const start = page.indexOf(startMarker);
  const end = page.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `Function ${functionName} must be present`);
  return new Function(`${page.slice(start, end)}\nreturn ${functionName};`)();
};

test('V111 signer position has a stable select without datalist auto-complete, with custom entry and hidden original payload name', () => {
  assert.match(page, /<select data-issue-signer-position-select aria-label="발신자 직함 선택">/);
  assert.match(page, /<input data-issue-signer-position-custom type="text"[^>]*autocomplete="off" hidden disabled/);
  assert.match(page, /<input type="hidden" name="issueSignerPosition" value="" \/>/);
  assert.doesNotMatch(page, /<input name="issueSignerPosition"[^>]*\blist=/);
  assert.match(page, /\.signer-position-control \{ display: grid;/);
  assert.match(page, /signerPositionSelect\.addEventListener\('change',/);
  assert.match(page, /signerPositionValue\.value = signerPositionSelect\.value === '__custom__' \? signerPositionCustom\.value : signerPositionSelect\.value;/);
  assert.match(page, /signerPositionCustom\.addEventListener\('input',/);
  assert.match(page, /signerPositionValue\.value = signerPositionCustom\.value;/);
  assert.match(page, /composeForm\.elements\.issueSignerPosition\.value=doc\.form_data\?\._issueSignerPosition\|\|'';/);
  assert.match(page, /restoreSignerPositionChoice\(\);renderApprovalPickers\(\);/);
  assert.match(page, /composeForm\.reset\(\);[\s\S]*?restoreSignerPositionChoice\(\);/);
});

test('V111 signer preset and arbitrary pre-existing titles can be restored without erasing text', () => {
  // The helper reads the lexical preset list; isolate it with the exact tested values.
  const start = page.indexOf('      const signerPositionChoice = (savedPosition) => {');
  const end = page.indexOf('\n      const syncIssueDisplayFields', start);
  const picker = new Function('signerPositionOptions', `${page.slice(start, end)}\nreturn signerPositionChoice;`)(['사무총장', '사무국장']);
  assert.equal(picker('사무총장'), '사무총장');
  assert.equal(picker('사무국장'), '사무국장');
  assert.equal(picker('교무부장'), '__custom__');
  assert.equal(picker('특별법무위원'), '__custom__');
  assert.equal(picker(''), '');
});

test('V111 draft preview: proxy acts in left 대결 cell and original delegated authority appears in right 전결 cell', () => {
  const finalLines = extractFunction('      const previewFinalApprovalLines = (mode,', '\n      const renderApprovalStrip', 'previewFinalApprovalLines');
  const authority = { id: 'chief', name: '원권자', position: '사무국장' };
  const deputy = { id: 'deputy', name: '대행자', position: '사무담당' };
  const proxy = finalLines('전대결', authority, deputy);
  assert.deepEqual(proxy.map((l: any) => l.type), ['대결','전결']);
  assert.equal(proxy[0].user, deputy);
  assert.equal(proxy[1].user, authority);
  assert.deepEqual(finalLines('결재', authority, deputy).map((l: any) => l.type), ['결재']);
  assert.deepEqual(finalLines('전결', authority, deputy).map((l: any) => l.type), ['전결']);
  assert.deepEqual(finalLines('대결', authority, deputy).map((l: any) => l.type), ['대결']);
});

test('V111 saved document detail and printable approval show the same deputy-first layout without rewriting database approval lines', () => {
  const visible = extractFunction('      const visibleApprovalLines = (doc, lines) => {', '\n      const previewFinalApprovalLines', 'visibleApprovalLines');
  const serverLines = [{ line_order: 3, line_type: '전대결', user_id: 'deputy', user_name: '대행자', user_position: '사무담당', status: '완료' }];
  const doc = { approval_mode: '전대결', form_data: { _actingForUserId: 'chief', _actingForName: '원권자', _actingForPosition: '사무국장' } };
  const shown = visible(doc, serverLines);
  assert.deepEqual(shown.map((l: any) => l.line_type), ['대결', '전결']);
  assert.deepEqual(shown.map((l: any) => l.user_id), ['deputy', 'chief']);
  assert.equal(shown[1].status, '전결표시');
  assert.ok(shown[0].line_order < shown[1].line_order);
  assert.equal(serverLines[0].line_type, '전대결', 'Source API line is unchanged');
  assert.equal(visible({approval_mode:'결재'}, serverLines), serverLines);
  assert.match(page, /data-detail-preview-approval-strip[\s\S]*?/, 'Printed detail uses the same preview region');
  assert.match(page, /renderApprovalStrip\(\$\('\[data-detail-preview-approval-strip\]'\),[^\n]*visibleApprovalLines\(doc,currentDetailApprovalLines\),true\)/);
});
