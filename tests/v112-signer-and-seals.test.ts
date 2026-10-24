import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const page = readFileSync('src/pages/index.astro','utf8');
const routes = JSON.parse(readFileSync('public/_routes.json','utf8'));
const slice = (start: string, end: string) => {
  const i=page.indexOf(start);
  const j=page.indexOf(end,i);
  assert.ok(i !== -1 && j>i, `expected function markers ${start} / ${end}`);
  return page.slice(i,j);
};

const signerOptions = () => {
  const match=page.match(/const signerPositionOptions\s*=\s*(\[[^;]+\]);/);
  assert.ok(match, 'Expected static signer title presets');
  return new Function(`return ${match[1]};`)() as string[];
};

test('V112 signer title drop-down contains only four requested institutional positions, plus manual entry', () => {
  assert.deepEqual(signerOptions(), ['이사장','총무원장','사무총장','교육·포교원장']);
  assert.match(page, /'<option value="__custom__">직접입력<\/option>'/);
  assert.doesNotMatch(page, /const signerPositionOptions = Array\.from\(\$\('#office-position-suggestions'\)/);
  assert.match(page,/signerPositionValue\.value = signerPositionCustom\.value;/);
});

test('V112 previously saved arbitrary positions remain editable under direct input without data loss', () => {
  const program=slice('      const signerPositionChoice = (savedPosition) => {','\n      const syncIssueDisplayFields');
  const choose=new Function('signerPositionOptions',`${program}\nreturn signerPositionChoice;`)(signerOptions());
  for (const known of signerOptions()) assert.equal(choose(known),known);
  for (const free of ['사무국장','감사','특별위원장','총무부장']) assert.equal(choose(free),'__custom__');
  assert.equal(choose(''),'');
  assert.match(page,/signerPositionCustom\.value = signerPositionSelect\.value === '__custom__' \? savedPosition : ''/);
});

test('V112 specific seal is restricted to 총무원 internal 기안 and department-head title, not external documents, other subdepartments or custom titles', () => {
  const source=slice('      const shouldShowChongmuwonjangSeal = (','\n      // The protected files are only requested');
  const resolveDepartmentPath=(raw: string) => {
    const value=String(raw).trim();
    const parts=value.split(/\s+-\s+/);
    return {primary:parts[0]||'-',secondary:parts.slice(1).join(' - ')};
  };
  const predicate=new Function('resolveDepartmentPath',`${source}\nreturn shouldShowChongmuwonjangSeal;`)(resolveDepartmentPath);
  assert.equal(predicate('department-head','기안','총무원','총무원장'),true);
  assert.equal(predicate('department-head','발송','총무원','총무원장'),false);
  assert.equal(predicate('signer','기안','총무원','총무원장'),false);
  assert.equal(predicate('organization','기안','총무원','총무원장'),false);
  assert.equal(predicate('department-head','기안','총무원 - 총무부','총무부장'),false);
  assert.equal(predicate('department-head','기안','사무처','사무총장'),false);
  assert.equal(predicate('department-head','기안','사무처 - 사무국','사무국장'),false);
  assert.equal(predicate('department-head','기안','총무원','사무국장'),false);
});

test('V112 protected seals do not request image before login, retry cleanly on department change and hide on error', () => {
  const source=slice('      const updateProtectedSealWarning = (image) => {','\n      const syncDocumentHeadSeals');
  const sync = new Function(`${source}\nreturn syncProtectedSeal;`)();
  class FakeImage {
    dataset={ protectedSealSrc:'/secretary_general.png', sealIntended:'' };
    hidden=true;
    complete=false;
    naturalWidth=0;
    attrs=new Map<string,string>();
    requests=0;
    getAttribute(name:string){return this.attrs.get(name)||null;}
    setAttribute(name:string,val:string){this.attrs.set(name,val); if(name==='src') this.requests++;}
    removeAttribute(name:string){this.attrs.delete(name);}
    onload?:()=>void;
    onerror?:()=>void;
  }
  const image=new FakeImage();
  sync(image,false);
  assert.equal(image.requests,0,'No anonymous eager load');
  sync(image,true);
  assert.equal(image.requests,1);
  assert.equal(image.hidden,true,'Avoid broken image before authenticated load finishes');
  image.naturalWidth=256; image.onload?.();
  assert.equal(image.hidden,false);
  sync(image,false);
  assert.equal(image.getAttribute('src'),null);
  sync(image,true);
  assert.equal(image.requests,2,'Login/department switch re-requests previously failed image');
  image.onerror?.();
  assert.equal(image.hidden,true,'Never display broken image icon as a stamp');
});

test('V112 both composer and persisted document use the same seal switching, and print refuses missing protected seal', () => {
  for (const prefix of ['preview','detail-preview']) {
    assert.match(page,new RegExp(`data-${prefix}-secretary-general-seal data-protected-seal-src="/secretary_general\\.png"`));
    assert.match(page,new RegExp(`data-${prefix}-chongmuwonjang-seal data-protected-seal-src="/chongmuwonjang_seal\\.png"`));
    assert.doesNotMatch(page,new RegExp(`data-${prefix}-(?:secretary-general|chongmuwonjang)-seal\\s+src=`));
  }
  assert.match(page,/syncDocumentHeadSeals\('preview', issueDisplayMode, String\(data\.get\('docType'\) \|\| ''\),/);
  assert.match(page,/syncDocumentHeadSeals\('detail-preview', issueDisplayMode, doc\.doc_type,/);
  assert.match(page,/img\.dataset\.sealIntended === 'true' \|\| !img\.closest\('\[hidden\]'\)/);
  assert.match(page,/if \(img\.dataset\.sealIntended === 'true' && !img\.getAttribute\('src'\)\)/);
  assert.match(page,/images\.filter\(img => img\.dataset\.sealIntended === 'true'\)\.forEach/);
  assert.match(page,/\.chongmuwonjang-seal\s*\{ right: -0\.55rem; \}/);
  assert.match(page,/\.chongmuwonjang-seal\{right:-10px\}/);
  assert.match(page,/data-preview-seal-warning hidden/);
  assert.match(page,/data-detail-preview-seal-warning hidden/);
  assert.match(page,/image\.dataset\.sealFailed = 'true'/);
});

test('V112 original official PNG bytes included, with private Pages function route and no public path bypass', () => {
  const seal='public/chongmuwonjang_seal.png';
  assert.equal(existsSync(seal),true);
  const bytes=readFileSync(seal);
  assert.deepEqual(Array.from(bytes.subarray(0,8)),[137,80,78,71,13,10,26,10]);
  assert.ok(bytes.byteLength > 10_000);
  const requestSource = readFileSync('functions/_shared/security/request.ts','utf8');
  assert.match(requestSource,/chongmuwonjang_seal\\\.png/, 'Protected-path allowlist must include the new seal');
  const line = requestSource.split('\n').find(x => x.trim().startsWith('return /^\\/'));
  assert.ok(line && line.includes('chongmuwonjang_seal'), 'Protected-image path matcher expected');
  const matches = new Function('decoded', line.trim());
  for (const name of ['/chongmuwonjang_seal.png','/secretary_general.png']) {
    assert.equal(matches(name),true, name);
  }
  assert.ok(routes.include.includes('/*'));
  assert.ok(!routes.exclude.some((p:string)=>p.includes('chongmuwonjang')||p.includes('secretary_general')));
  assert.match(readFileSync('scripts/security/browser-harness.mjs','utf8'), /path === '\/chongmuwonjang_seal\.png'/);
});
