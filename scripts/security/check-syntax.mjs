// Parse-only check of TypeScript/JavaScript and Astro script blocks; NOT `astro build/check`.
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';import path from 'node:path';
const require=createRequire(import.meta.url);let ts;
try{ts=require('typescript');}catch{ts=require(path.join(execFileSync('npm',['root','-g'],{encoding:'utf8'}).trim(),'typescript'));}
const results=[];const errors=[];
function parse(file,source,kind=ts.ScriptKind.TS){
  const ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,kind);
  results.push(file);
  for(const d of ast.parseDiagnostics||[])errors.push({file,message:ts.flattenDiagnosticMessageText(d.messageText,' '),position:d.start});
}
function visit(dir){for(const item of fs.readdirSync(dir,{withFileTypes:true})){
  if(['node_modules','dist','.git','.astro','security-evidence'].includes(item.name))continue;
  const file=path.join(dir,item.name);if(item.isDirectory()){visit(file);continue;}
  if(/\.(?:[cm]?js|ts)$/.test(file))parse(file,fs.readFileSync(file,'utf8'),file.endsWith('.ts')?ts.ScriptKind.TS:ts.ScriptKind.JS);
  if(file.endsWith('.astro')){
    const source=fs.readFileSync(file,'utf8');const front=/^---\s*\r?\n([\s\S]*?)^---\s*$/m.exec(source);
    if(front)parse(file+'#frontmatter',front[1]);
    let n=0;for(const match of source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)){
      if(/\bsrc=/.test(match[1])||!match[2].trim())continue;
      parse(file+'#script-'+(++n),match[2]);
    }
  }
}}
for(const dir of ['functions','workers','src','public','scripts','tests'])if(fs.existsSync(dir))visit(dir);
parse('astro.config.mjs',fs.readFileSync('astro.config.mjs','utf8'),ts.ScriptKind.JS);
console.log(JSON.stringify({ok:!errors.length,compiler:ts.version,parsedUnits:results.length,scope:'Syntax only; does not resolve dependencies, validate Astro templates or render UI',errors,units:results},null,2));
if(errors.length)process.exitCode=1;
