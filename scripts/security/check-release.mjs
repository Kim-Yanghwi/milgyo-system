// A known-vulnerability gate, not a substitute for npm audit or an up-to-date vulnerability review.
import fs from 'node:fs';
const pkg = JSON.parse(fs.readFileSync('package.json','utf8'));
const lock = JSON.parse(fs.readFileSync('package-lock.json','utf8'));
const atLeast = (v, target) => { if(!/^\d+\.\d+\.\d+$/.test(v||''))return false;const a=v.split('.').map(Number),b=target.split('.').map(Number);for(let i=0;i<3;i++){if(a[i]>b[i])return true;if(a[i]<b[i])return false;}return true; };
const issues=[];
const astro=lock.packages?.['node_modules/astro']?.version;
const sharpEntries=Object.entries(lock.packages||{}).filter(([key])=>/node_modules\/sharp$/.test(key));
if(!atLeast(astro,'7.3.5'))issues.push(`Astro ${astro||'missing'}: reviewed maintenance target requires >=7.3.5.`);
if(!sharpEntries.length)issues.push('Sharp lockfile entry missing; review resolved dependency tree.');
for(const [key,value]of sharpEntries)if(!atLeast(value.version,'0.35.5'))issues.push(`${key} ${value.version}: reviewed maintenance target requires >=0.35.5.`);
if(pkg.overrides?.sharp&&!atLeast(pkg.overrides.sharp,'0.35.5'))issues.push(`The Sharp override ${pkg.overrides.sharp} also needs updating.`);
const root=lock.packages?.[''];
if(JSON.stringify(root?.dependencies)!==JSON.stringify(pkg.dependencies))issues.push('package.json and lockfile root dependencies differ.');
console.log(JSON.stringify({date:'2026-10-04',astro,sharp:sharpEntries.map(([path,v])=>({path,version:v.version})),ok:issues.length===0,issues,
 advisory:'https://github.com/withastro/astro/security/advisories/GHSA-26w7-cxv4-gfx2'},null,2));
if(issues.length)process.exitCode=1;
