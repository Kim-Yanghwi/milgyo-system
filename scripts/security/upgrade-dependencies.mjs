// Explicit opt-in local maintenance. Does not connect to Cloudflare or deploy/change a DB.
// Run in a backed-up working tree with real registry access, then review/commit package-lock.json.
import { spawnSync } from 'node:child_process';
if(!process.argv.includes('--apply')){
  console.error('Usage: node scripts/security/upgrade-dependencies.mjs --apply');
  console.error('Updates Astro/Sharp to the reviewed minimum, resolves the real lockfile, installs, tests and builds.');
  process.exit(2);
}
const npm=process.platform==='win32'?'npm.cmd':'npm';
function run(command,args){const r=spawnSync(command,args,{stdio:'inherit',shell:process.platform==='win32'});if(r.status!==0)process.exit(r.status||1);}
run(npm,['pkg','set','dependencies.astro=7.3.5','overrides.sharp=0.35.5']);
run(npm,['install','--package-lock-only','--ignore-scripts']);
run(npm,['ci']);
run(npm,['run','verify:release']);
console.log('Local dependency checks completed. Preview deployment and real environment testing are still required.');
