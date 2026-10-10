import fs from 'node:fs';

const issues = [];
const parseSections = (source) => {
  const sections = [];
  let current = null;
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    const header = /^\[\[([^\]]+)\]\]$/.exec(line);
    if (header) { current = { name: header[1], values: {} }; sections.push(current); continue; }
    if (!current || !line || line.startsWith('#')) continue;
    const assignment = /^([A-Za-z0-9_]+)\s*=\s*"([^"]*)"$/.exec(line);
    if (assignment) current.values[assignment[1]] = assignment[2];
  }
  return sections;
};
const byBinding = (sections, name) => Object.fromEntries(
  sections.filter((section) => section.name === name && section.values.binding)
    .map((section) => [section.values.binding, section.values]),
);

const text = fs.readFileSync('wrangler.toml', 'utf8');
const sections = parseSections(text);
const prodDb = byBinding(sections, 'd1_databases');
const previewDb = byBinding(sections, 'env.preview.d1_databases');
const prodR2 = byBinding(sections, 'r2_buckets');
const previewR2 = byBinding(sections, 'env.preview.r2_buckets');

for (const name of ['DB', 'ACCOUNTING_DB']) {
  if (!prodDb[name]?.database_id) issues.push(`Production D1 ${name} binding/database_id가 없습니다.`);
  if (!previewDb[name]?.database_id) issues.push(`Preview D1 ${name} binding/database_id가 없습니다.`);
  if (prodDb[name]?.database_id && prodDb[name].database_id === previewDb[name]?.database_id) issues.push(`${name} Production/Preview가 같은 D1 ID를 사용합니다.`);
  if (prodDb[name]?.database_name && prodDb[name].database_name === previewDb[name]?.database_name) issues.push(`${name} Production/Preview가 같은 D1 이름을 사용합니다.`);
}
for (const name of ['FILES', 'ACCOUNTING_FILES']) {
  if (!prodR2[name]?.bucket_name) issues.push(`Production R2 ${name} binding이 없습니다.`);
  if (!previewR2[name]?.bucket_name) issues.push(`Preview R2 ${name} binding이 없습니다.`);
  if (prodR2[name]?.bucket_name && prodR2[name].bucket_name === previewR2[name]?.bucket_name) issues.push(`${name} Production/Preview가 같은 R2 버킷을 사용합니다.`);
}
if (!/pages_build_output_dir\s*=\s*"dist"/.test(text)) issues.push('Pages build output이 dist로 설정되지 않았습니다.');
for (const dir of ['migrations/main', 'migrations/accounting']) if (!fs.existsSync(dir)) issues.push(`${dir}가 없습니다.`);

if (fs.existsSync('wrangler.accounting-maintenance.toml')) {
  const maintenanceSections = parseSections(fs.readFileSync('wrangler.accounting-maintenance.toml', 'utf8'));
  const maintenanceDb = byBinding(maintenanceSections, 'd1_databases');
  const maintenanceR2 = byBinding(maintenanceSections, 'r2_buckets');
  if (maintenanceDb.DB?.database_id !== prodDb.DB?.database_id) issues.push('회계 유지보수 Worker의 DB가 Pages Production DB와 다릅니다.');
  if (maintenanceDb.ACCOUNTING_DB?.database_id !== prodDb.ACCOUNTING_DB?.database_id) issues.push('회계 유지보수 Worker의 ACCOUNTING_DB가 Pages Production과 다릅니다.');
  if (maintenanceR2.ACCOUNTING_FILES?.bucket_name !== prodR2.ACCOUNTING_FILES?.bucket_name) issues.push('회계 유지보수 Worker의 ACCOUNTING_FILES가 Pages Production과 다릅니다.');
} else issues.push('wrangler.accounting-maintenance.toml이 없습니다.');

console.log(JSON.stringify({
  ok: issues.length === 0,
  issues,
  production: { DB: prodDb.DB?.database_name, ACCOUNTING_DB: prodDb.ACCOUNTING_DB?.database_name, FILES: prodR2.FILES?.bucket_name, ACCOUNTING_FILES: prodR2.ACCOUNTING_FILES?.bucket_name },
  preview: { DB: previewDb.DB?.database_name, ACCOUNTING_DB: previewDb.ACCOUNTING_DB?.database_name, FILES: previewR2.FILES?.bucket_name, ACCOUNTING_FILES: previewR2.ACCOUNTING_FILES?.bucket_name },
}, null, 2));
if (issues.length) process.exitCode = 1;
