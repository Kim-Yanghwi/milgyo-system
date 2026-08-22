import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {
  ACCOUNTING_DOMAIN_ACTIONS,
  ACCOUNTING_DOMAIN_QUERIES,
  type AccountingDomain,
  type AccountingLegacyApi,
} from '../functions/_shared/accounting-domain-contract';

const sourceFiles: Record<AccountingLegacyApi, { query: string; action: string }> = {
  accounting: { query: 'functions/api/accounting/query.ts', action: 'functions/api/accounting/action.ts' },
  operations: { query: 'functions/api/accounting-operations/query.ts', action: 'functions/api/accounting-operations/action.ts' },
  special: { query: 'functions/api/accounting-special/query.ts', action: 'functions/api/accounting-special/action.ts' },
  compliance: { query: 'functions/api/accounting-compliance/query.ts', action: 'functions/api/accounting-compliance/action.ts' },
  tax: { query: 'functions/api/accounting-tax/query.ts', action: 'functions/api/accounting-tax/action.ts' },
};
const domains: AccountingDomain[] = ['core','cash','giving','governance','tax'];

const extractActions = (file: string) => {
  const source = fs.readFileSync(file, 'utf8');
  const actions = new Set<string>();
  for (const match of source.matchAll(/action\s*===\s*['\"]([^'\"]+)['\"]/g)) actions.add(match[1]);
  for (const match of source.matchAll(/\[([^\]]+)\]\.includes\(action\)/g)) {
    for (const item of match[1].matchAll(/['\"]([^'\"]+)['\"]/g)) actions.add(item[1]);
  }
  actions.delete('init');
  return actions;
};

const ownersFor = (kind: 'query'|'action', source: AccountingLegacyApi, action: string) => {
  const contract = kind === 'query' ? ACCOUNTING_DOMAIN_QUERIES : ACCOUNTING_DOMAIN_ACTIONS;
  return domains.filter((domain) => (contract[domain][source] || []).includes(action));
};

test('every legacy accounting business operation has exactly one canonical domain owner', () => {
  for (const [source, files] of Object.entries(sourceFiles) as Array<[AccountingLegacyApi, {query:string;action:string}]>) {
    for (const kind of ['query','action'] as const) {
      const actual = extractActions(files[kind]);
      for (const action of actual) {
        assert.deepEqual(ownersFor(kind, source, action).length, 1,
          `${kind}:${source}:${action} must have exactly one canonical domain owner`);
      }
      const contract = kind === 'query' ? ACCOUNTING_DOMAIN_QUERIES : ACCOUNTING_DOMAIN_ACTIONS;
      const declared = new Set(domains.flatMap((domain) => [...(contract[domain][source] || [])]));
      assert.deepEqual([...declared].sort(), [...actual].sort(),
        `${kind}:${source} domain contract must match the legacy handler exactly (excluding init)`);
    }
  }
});

test('browser API router sends every mapped action to its canonical domain endpoint', () => {
  const code = fs.readFileSync('public/accounting-domain-api.js', 'utf8');
  const sandbox: any = { window: {} };
  vm.runInNewContext(code, sandbox, { filename: 'accounting-domain-api.js' });
  const route = sandbox.window.AccountingDomainApi.route as (path:string,body:any)=>{path:string;body:any};
  const endpoint = (source: AccountingLegacyApi, kind: 'query'|'action') => source === 'accounting'
    ? `/api/accounting/${kind}` : `/api/accounting-${source}/${kind}`;
  for (const kind of ['query','action'] as const) {
    const contract = kind === 'query' ? ACCOUNTING_DOMAIN_QUERIES : ACCOUNTING_DOMAIN_ACTIONS;
    for (const domain of domains) for (const source of Object.keys(sourceFiles) as AccountingLegacyApi[]) {
      for (const action of contract[domain][source] || []) {
        const routed = route(endpoint(source,kind), { action, marker: 1 });
        assert.equal(routed.path, `/api/accounting-domains/${domain}/${kind}`, `${kind}:${source}:${action}`);
        assert.equal(routed.body._legacyApi, source);
        assert.equal(routed.body.marker, 1);
      }
    }
  }
  const bootstrap=route('/api/accounting-operations/query',{action:'init',marker:2});
  assert.equal(bootstrap.path,'/api/accounting-bootstrap');
  assert.equal(bootstrap.body._legacyApi,'operations');
  assert.equal(bootstrap.body.marker,2);
  assert.throws(() => route('/api/accounting-operations/query',{action:'unclassified-future-action'}), /업무영역이 지정되지 않았습니다/,
    'new accounting actions must be classified before the UI can call them');
});

test('accounting navigation exposes five business domains and keeps attachment operations in governance', () => {
  const header = fs.readFileSync('src/components/AccountingHeader.astro','utf8');
  for (const label of ['회계·예산·결산','자금·거래관리','기부·자산·기관회계','계약·조달·준법','세무·신고']) assert.match(header,new RegExp(label));
  assert.match(header,/accounting-files\/\?domain=governance/);
  assert.match(header,/>점검·정책<\/a>/);
  const compliance = fs.readFileSync('src/pages/accounting-compliance.astro','utf8');
  assert.match(compliance,/거래처·계약·지출/);
  assert.match(compliance,/첨부파일·운영점검/);
  const files = fs.readFileSync('src/pages/accounting-files.astro','utf8');
  assert.match(files,/회계 첨부파일 운영 · 점검·정책/);
  assert.match(files,/accounting-compliance\/\?domain=governance&tab=check/);
});

test('mixed legacy workspaces are explicitly partitioned by domain in the UI', () => {
  const operations=fs.readFileSync('src/pages/accounting-operations.astro','utf8');
  assert.match(operations,/data-tab="reconciliation" data-domain="cash"/);
  assert.match(operations,/data-tab="budget" data-domain="core"/);
  assert.match(operations,/data-tab="contract" data-domain="governance"/);
  assert.match(operations,/data-tab="donation" data-domain="tax"/);
  const special=fs.readFileSync('src/pages/accounting-special.astro','utf8');
  assert.match(special,/data-tab="master" data-domain="core"/);
  assert.match(special,/data-tab="card" data-domain="cash"/);
  assert.match(special,/data-tab="donation" data-domain="giving"/);
});

test('mixed workspaces keep navigation domain-owned while cross-domain panels use canonical URL domains', () => {
  const operations=fs.readFileSync('src/pages/accounting-operations.astro','utf8');
  assert.match(operations,/operationsTabDomains=\{overview:'cash',reconciliation:'cash',budget:'core',contract:'governance',donation:'tax'\}/);
  assert.match(operations,/navigateOperationsDomain/);
  assert.match(operations,/url\.searchParams\.set\('domain',targetDomain\)/);
  assert.match(operations,/location\.(?:assign|replace)\(url\.href\)/);
  const special=fs.readFileSync('src/pages/accounting-special.astro','utf8');
  assert.match(special,/specialTabDomains=\{overview:'giving',master:'core',donation:'giving',asset:'giving',card:'cash',branch:'giving',report:'giving'\}/);
  assert.match(special,/navigateSpecialDomain/);
  assert.match(special,/url\.searchParams\.set\('domain',targetDomain\)/);
  assert.match(special,/data-tab="branch" data-domain="giving"/);
  assert.match(special,/data-tab="report" data-domain="giving"/);
  assert.match(special,/data-tab="card" data-domain="cash"/);
  const ui=fs.readFileSync('public/accounting-domain-ui.js','utf8');
  assert.doesNotMatch(ui,/navigationSelector/);
  assert.doesNotMatch(ui,/is-cross-domain/);
  assert.match(ui,/if\(domains\.length\)element\.hidden=!domains\.includes\(domain\)/);
});

test('shared date input exposes the native segmented editor while an existing date is being edited', () => {
  const dateJs=fs.readFileSync('public/milgyo-date-input.js','utf8');
  const css=fs.readFileSync('src/styles/system-ui.css','utf8');
  assert.match(dateJs,/setNativeEditing/);
  assert.match(dateJs,/setNativeEditing\(input, true\)/);
  assert.match(dateJs,/setNativeEditing\(input, false\)/);
  assert.match(css,/\.date-input-shell\.is-native-editing input\[type="date"\]/);
  assert.match(css,/\.date-input-shell\.is-native-editing \.date-display-value/);
});


test('shared accounting foundations are neutral and former special module is compatibility-only', () => {
  const accounting = fs.readFileSync('functions/_shared/accounting.ts','utf8');
  assert.doesNotMatch(accounting,/from ['"]\.\/accounting-special['"]/, 'core accounting must not depend on the former special module');
  assert.match(accounting,/accounting-domain-schema/);
  assert.match(accounting,/accounting-dimensions/);

  for (const file of [
    'functions/_shared/accounting-operations.ts',
    'functions/_shared/accounting-compliance.ts',
    'functions/_shared/accounting-tax.ts',
    'functions/api/accounting/action.ts',
    'functions/api/accounting/query.ts',
    'functions/api/accounting-operations/action.ts',
    'functions/api/accounting-operations/query.ts',
    'functions/api/accounting-compliance/query.ts',
    'functions/api/accounting-tax/action.ts',
    'functions/api/accounting-tax/query.ts',
  ]) {
    assert.doesNotMatch(fs.readFileSync(file,'utf8'),/accounting-special/, `${file} must not import former special-accounting shared utilities`);
  }

  const compat = fs.readFileSync('functions/_shared/accounting-special.ts','utf8');
  assert.match(compat,/ensureAccountingDomainTables as ensureAccountingSpecialTables/);
  assert.match(compat,/from '\.\/accounting-numbering'/);
  assert.match(compat,/from '\.\/accounting-dimensions'/);
});

test('shared accounting header preserves hidden domain controls despite legacy page styles', () => {
  const header = fs.readFileSync('src/components/AccountingHeader.astro','utf8');
  assert.match(header,/\[hidden\]\{display:none!important\}/);
});


test('all accounting workspaces load the domain router and shared API client before page logic', () => {
  for (const file of [
    'src/pages/accounting.astro',
    'src/pages/accounting-operations.astro',
    'src/pages/accounting-special.astro',
    'src/pages/accounting-compliance.astro',
    'src/pages/accounting-tax.astro',
    'src/pages/accounting-files.astro',
  ]) {
    const source = fs.readFileSync(file,'utf8');
    const api = source.indexOf('/accounting-domain-api.js');
    const client = source.indexOf('/accounting-api-client.js');
    const ui = source.indexOf('/accounting-domain-ui.js');
    const inlineLogic = source.search(/<script(?:\s+is:inline)?>(?!\s*<\/script>)/);
    assert.ok(api >= 0 && client >= 0 && ui >= 0, `${file} must load accounting routing, client and UI helpers`);
    assert.ok(api < client && client < inlineLogic && ui < inlineLogic, `${file} shared helpers must load before workspace logic`);
  }
});


test('shared accounting API client applies canonical routing, token injection, and uniform errors', async () => {
  const routerCode = fs.readFileSync('public/accounting-domain-api.js','utf8');
  const clientCode = fs.readFileSync('public/accounting-api-client.js','utf8');
  const calls:any[]=[];
  const sandbox:any={
    window:{},
    fetch:async(path:string,options:any)=>{
      calls.push({path,options});
      return {ok:true,status:200,text:async()=>JSON.stringify({ok:true,result:'ok'})};
    },
  };
  vm.runInNewContext(routerCode,sandbox,{filename:'accounting-domain-api.js'});
  vm.runInNewContext(clientCode,sandbox,{filename:'accounting-api-client.js'});
  const data=await sandbox.window.AccountingApiClient.post('/api/accounting-special/action',{action:'save-donation',marker:1},'TOKEN-1');
  assert.equal(data.result,'ok');
  assert.equal(calls[0].path,'/api/accounting-domains/giving/action');
  const body=JSON.parse(calls[0].options.body);
  assert.equal(body._legacyApi,'special');
  assert.equal(body.token,'TOKEN-1');
  assert.equal(body.marker,1);
  sandbox.fetch=async()=>({ok:false,status:409,text:async()=>JSON.stringify({ok:false,message:'conflict'})});
  await assert.rejects(() => sandbox.window.AccountingApiClient.post('/api/accounting/action',{action:'save-budget'},'TOKEN-1'),(error:any)=>error.message==='conflict'&&error.status===409);
});


test('auxiliary vehicle workflows also route accounting business calls through governance', () => {
  const vehicle = fs.readFileSync('src/pages/vehicle-register.astro','utf8');
  assert.match(vehicle,/src="\/accounting-domain-api\.js"/);
  assert.match(vehicle,/src="\/accounting-api-client\.js"/);
  assert.match(vehicle,/AccountingApiClient\.post/);
  const home = fs.readFileSync('src/pages/index.astro','utf8');
  assert.match(home,/\/api\/accounting-domains\/governance\/query/);
  assert.match(home,/_legacyApi:'compliance'/);
});


test('current UI has no direct network bypass to legacy accounting query/action endpoints', () => {
  for (const file of fs.readdirSync('src/pages').filter((name)=>name.endsWith('.astro'))) {
    const source=fs.readFileSync(`src/pages/${file}`,'utf8');
    assert.doesNotMatch(source,/(?:fetch|callApi)\([^\n]{0,160}['"]\/api\/accounting(?:-operations|-special|-compliance|-tax)?\/(?:query|action)/,
      `${file} must use the shared accounting client or a canonical endpoint instead of direct legacy network calls`);
  }
});

test('domain-owned panels are fail-closed as well as their navigation controls', () => {
  const operations = fs.readFileSync('src/pages/accounting-operations.astro','utf8');
  assert.match(operations,/data-panel="reconciliation" data-domain="cash"/);
  assert.match(operations,/data-panel="budget" data-domain="core"/);
  assert.match(operations,/data-panel="contract" data-domain="governance"/);
  assert.match(operations,/data-panel="donation" data-domain="tax"/);
  const special = fs.readFileSync('src/pages/accounting-special.astro','utf8');
  assert.match(special,/data-panel="master" data-domain="core"/);
  assert.match(special,/data-panel="card" data-domain="cash"/);
  assert.match(special,/data-panel="donation" data-domain="giving"/);
});

test('domain-owned hidden elements override shared display rules', () => {
  const css = fs.readFileSync('src/styles/system-ui.css','utf8');
  assert.match(
    css,
    /:is\(\.accounting-app,\.special-app,\.ops-app,\.compliance-app,\.tax-app,\.file-admin\)\s+\[data-domain\]\[hidden\]\s*\{\s*display:\s*none\s*!important;\s*\}/s,
    'domain-owned hidden controls and panels must stay fail-closed even when shared UI sets display with !important',
  );
});

test('shared date input is native-first and draft overlay is isolated', () => {
  const dateJs = fs.readFileSync('public/milgyo-date-input.js','utf8');
  const css = fs.readFileSync('src/styles/system-ui.css','utf8');
  assert.match(dateJs, /DATE_NATIVE_FIRST_V51/);
  assert.match(dateJs, /display\.classList\.toggle\('is-placeholder',\s*!parsed\);[\s\S]{0,120}display\.hidden\s*=\s*true;/);
  assert.match(css, /DATE_NATIVE_FIRST_V51/);
  assert.match(css, /:not\(\[data-numeric-date-drafting="1"\]\)[\s\S]{0,220}input\[type="date"\]/);
  assert.match(css, /:not\(\[data-numeric-date-drafting="1"\]\)[\s\S]{0,220}:is\(\.date-display-value,\.managed-date-display\)[\s\S]{0,80}display:\s*none\s*!important/);
  assert.match(css, /\[data-numeric-date-drafting="1"\][\s\S]{0,220}:is\(\.date-display-value,\.managed-date-display\)[\s\S]{0,80}display:\s*flex\s*!important/);
  assert.match(css, /-webkit-calendar-picker-indicator[\s\S]{0,220}position:\s*static\s*!important/);
});

test('accounting overview cards collapse to one column at 150 percent desktop zoom', () => {
  const css = fs.readFileSync('src/styles/system-ui.css','utf8');
  assert.match(css, /ACCOUNTING_OVERVIEW_SINGLE_COLUMN_V81_1/);
  assert.match(css, /@media\s*\(max-width:\s*1300px\)/);
  for (const selector of [
    '.accounting-app [data-panel="dashboard"] > .summary-grid',
    '.accounting-app [data-panel="dashboard"] .integration-summary',
    '.ops-app [data-panel="overview"] > .summary-grid',
    '.ops-app [data-panel="overview"] > .guide-grid',
    '.special-app [data-panel="overview"] > .summary-grid',
    '.special-app [data-panel="overview"] .feature-grid',
    '.compliance-app [data-panel="overview"] > .summary-grid',
    '.compliance-app [data-panel="overview"] > .guide-grid',
    '.tax-app [data-panel="overview"] > .summary-grid',
    '.tax-app [data-panel="overview"] .guide-grid',
  ]) {
    assert.ok(css.includes(selector), `${selector} must participate in the 150% overview-card reflow`);
  }
  assert.match(css, /grid-template-columns:\s*minmax\(0,\s*1fr\)\s*!important/);
});

test('tax header shows the organizational position instead of the internal auth role', () => {
  const tax = fs.readFileSync('src/pages/accounting-tax.astro','utf8');
  assert.match(tax, /const headerPosition=String\(me\.position\|\|''\)\.trim\(\)/);
  assert.match(tax, /data-user-label[^;]+headerPosition\?' · '\+headerPosition:''/);
  assert.doesNotMatch(tax, /data-user-label[^;]+me\.role/);
});

test('every accounting table uses solid internal gridlines and centered headings', () => {
  const css = fs.readFileSync('src/styles/system-ui.css','utf8');
  assert.match(css, /ACCOUNTING_TABLE_GRID_CONTRACT_V81_2/);
  for (const root of ['.accounting-app','.ops-app','.special-app','.compliance-app','.tax-app','.file-admin']) {
    assert.ok(css.includes(root), `${root} must participate in the shared table contract`);
  }
  assert.match(css, /table\s+:is\(th,td\)\s*\{[\s\S]{0,120}border:\s*1px\s+solid\s+#8fa4bb\s*!important/);
  assert.match(css, /table\s+thead\s+th\s*\{[\s\S]{0,80}text-align:\s*center\s*!important/);
});

test('accounting money headings stay centered while body and footer values align right', () => {
  const css = fs.readFileSync('src/styles/system-ui.css','utf8');
  assert.match(css, /table\s+thead\s+th\s*\{[\s\S]{0,80}text-align:\s*center\s*!important/);
  assert.match(css, /table\s+:is\(tbody,tfoot\)\s+:is\(td,th\):is\(\.accounting-money-value,\.num,\.money\)\s*\{[\s\S]{0,120}text-align:\s*right\s*!important/);
  assert.match(css, /font-variant-numeric:\s*tabular-nums/);
});

test('dynamic accounting rows inherit the shared monetary column contract', () => {
  const ui = fs.readFileSync('public/accounting-domain-ui.js','utf8');
  assert.match(ui, /ACCOUNTING_TABLE_GRID_CONTRACT_V81_2/);
  assert.match(ui, /monetaryHeaderPattern/);
  assert.match(ui, /accounting-money-heading/);
  assert.match(ui, /accounting-money-value/);
  assert.match(ui, /new MutationObserver\(syncAccountingTables\)/);
  assert.match(ui, /window\.syncAccountingTableContract=syncAccountingTables/);
});

test('the shared table contract is loaded by all 53 live accounting tables', () => {
  const surfaces = [
    ['src/pages/accounting.astro','accounting-app'],
    ['src/pages/accounting-operations.astro','ops-app'],
    ['src/pages/accounting-special.astro','special-app'],
    ['src/pages/accounting-compliance.astro','compliance-app'],
    ['src/pages/accounting-tax.astro','tax-app'],
    ['src/pages/accounting-files.astro','file-admin'],
  ];
  let tableCount = 0;
  for (const [file,rootClass] of surfaces) {
    const source = fs.readFileSync(file,'utf8');
    assert.match(source, new RegExp(`class=["'][^"']*${rootClass}`), `${file} must expose ${rootClass}`);
    assert.match(source, /src=["']\/accounting-domain-ui\.js["']/, `${file} must load the shared table contract`);
    // Exclude printable table templates embedded in the page script. They are
    // not live application table surfaces and keep their print-only borders.
    const mainScriptIndex = source.search(/<script\s+is:inline\s*>/);
    const pageMarkup = mainScriptIndex >= 0 ? source.slice(0, mainScriptIndex) : source;
    tableCount += (pageMarkup.match(/<table\b/g) || []).length;
  }
  assert.equal(tableCount, 53);
});
