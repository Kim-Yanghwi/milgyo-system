import fs from 'node:fs';

const page = fs.readFileSync('src/pages/index.astro', 'utf8');
const required = [
  ['asset', fs.existsSync('public/secretary_general.png')],
  ['preview marker', page.includes('data-preview-secretary-general-seal')],
  ['detail marker', page.includes('data-detail-preview-secretary-general-seal')],
  ['department-head condition', page.includes("issueDisplayMode === 'department-head'")],
  ['secretary general condition', page.includes("departmentHeadTitle === '사무총장'")],
  ['office condition', page.includes("path.primary === '사무처'")],
  ['no child department condition', page.includes('&& !path.secondary')],
  ['existing seal source intact', page.includes("const sealSource=orgSealImage||'/organization-seal-official.png'")],
  ['dedicated seal css', page.includes('.secretary-general-seal')],
];
const failed = required.filter(([, ok]) => !ok);
if (failed.length) {
  for (const [name] of failed) console.error(`[v94] FAIL: ${name}`);
  process.exit(1);
}
console.log('[v94] OK - secretary general seal is isolated and conditionally rendered.');
