import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
const production='D:/CUT-Releases/20261030-production-first-r11';
const base=path.resolve('.project-governance/evidence/tt-admission-20261119');
const manifest={production,baseline:base+'/baseline',candidate:base+'/candidate',files:[]};
const visited=new Set();
async function copy(file){
 if(visited.has(file))return;visited.add(file);
 const bytes=await fs.readFile(production+'/'+file);
 for(const arm of ['baseline','candidate']){const target=manifest[arm]+'/'+file;await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,bytes,{flag:'wx'});}
 manifest.files.push({file,sha256:createHash('sha256').update(bytes).digest('hex')});
 for(const m of bytes.toString().matchAll(/(?:from\s*|import\s*\()\s*['"](\.[^'"]+)['"]/g)){
  const dep=path.posix.normalize(path.posix.join(path.posix.dirname(file),m[1]));
  if(/\.(mjs|ts|json)$/.test(dep))await copy(dep);
 }
}
await copy('worker/classic-multisource-executor.mjs');
await fs.writeFile(base+'/manifest.json',JSON.stringify(manifest,null,2),{flag:'wx'});
console.log(JSON.stringify({base,copied:manifest.files.length,productionWrites:0}));
