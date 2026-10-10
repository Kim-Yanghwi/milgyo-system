// Offline audit helper: uses the real installed TypeScript compiler, never a stub.
// Normal CI uses the project's pinned tsx/TypeScript via `npm test`.
import { createRequire } from 'node:module';
import { readFile, access } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
const require = createRequire(import.meta.url);
let ts;
try { ts = require('typescript'); }
catch { ts = require(path.join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), 'typescript')); }
export async function resolve(specifier, context, nextResolve) {
  try { return await nextResolve(specifier, context); }
  catch (error) {
    if (!specifier.startsWith('.') && !specifier.startsWith('/')) throw error;
    const base = new URL(specifier, context.parentURL);
    for (const suffix of ['.ts', '/index.ts']) {
      const url = new URL(base.href + suffix);
      try { await access(fileURLToPath(url)); return { url: url.href, shortCircuit: true }; } catch {}
    }
    throw error;
  }
}
export async function load(url, context, nextLoad) {
  if (!url.endsWith('.ts')) return nextLoad(url, context);
  const fileName = fileURLToPath(url);
  const source = await readFile(fileName, 'utf8');
  const result = ts.transpileModule(source, { fileName, reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, isolatedModules: true } });
  const errors = (result.diagnostics || []).filter(d => d.category === ts.DiagnosticCategory.Error);
  if (errors.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(errors, { getCurrentDirectory: () => process.cwd(), getCanonicalFileName: f => f, getNewLine: () => '\n' }));
  return { format: 'module', source: result.outputText, shortCircuit: true };
}
