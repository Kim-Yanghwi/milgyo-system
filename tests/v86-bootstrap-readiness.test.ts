import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read=(p:string)=>fs.readFileSync(p,'utf8');

test('fresh migrated main DB is finalized without legacy full runtime migration',()=>{
  const helpers=read('functions/_shared/helpers.ts');
  assert.match(helpers,/hasMigratedMainStructure/);
  assert.match(helpers,/finalizeMigratedMainSchema/);
  assert.match(helpers,/if \(hasMigratedMainStructure\(state\)\) await finalizeMigratedMainSchema\(db\)/);
  assert.match(read('migrations/main/0009_v86_bootstrap_finalize.sql'),/schema_version/);
});

test('built-in templates are seeded set-wise rather than one D1 statement per template',()=>{
  const helpers=read('functions/_shared/helpers.ts');
  assert.match(helpers,/FROM json_each\(\?\) AS j/);
  assert.doesNotMatch(helpers,/db\.batch\(BUILT_IN_TEMPLATES\.map/);
});

test('bootstrap failures include an internal stage marker in logs',()=>{
  const bootstrap=read('functions/api/auth/bootstrap.ts');
  assert.match(bootstrap,/let stage = 'rate-limit'/);
  assert.match(bootstrap,/console\.error\('bootstrap failed', \{ stage, error \}\)/);
});
