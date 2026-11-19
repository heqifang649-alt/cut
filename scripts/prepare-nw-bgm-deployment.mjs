import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
const live='D:/CUT-Releases/20261030-production-first-r11';
const dest=path.resolve('.project-governance/evidence/nw-bgm-deployment-20261113');
const candidate=path.join(dest,'candidate');
const hash=b=>createHash('sha256').update(b).digest('hex');
await fs.mkdir(candidate,{recursive:true});
for(const dir of ['lib','worker','standards'])await fs.cp(path.join(live,dir),path.join(candidate,dir),{recursive:true});
await fs.mkdir(path.join(candidate,'config'),{recursive:true});
for(const f of ['cutflow-runtime.json','brand-copy-files.json','brand-bgm-directories.json','classic-brand-activation.json'])await fs.copyFile(path.join(live,'config',f),path.join(candidate,'config',f));
const replacements={
 'lib/brand-copy-library.mjs':[["key === 'nw' ? 'NW' : null", "['nw','nerdywave'].includes(key) ? 'NW' : null"]],
 'worker/classic-multisource-executor.mjs':[["import { enableClassicBrandResources } from '../lib/classic-brand-activation.mjs';", "import { enableClassicBrandResources } from '../lib/classic-brand-activation.mjs';\nimport { classicMultisourceBgm } from './classic-multisource-bgm.mjs';"],
 ['    Object.assign(batch, scopedBrandResources);','    Object.assign(batch, scopedBrandResources);\n    Object.assign(batch, classicMultisourceBgm(record));']]
};
const files=[];
for(const [p,changes]of Object.entries(replacements)){
 const bytes=await fs.readFile(path.join(live,p));let text=bytes.toString();
 for(const [from,to]of changes){if(text.split(from).length!==2)throw Error('PATCH_ANCHOR:'+p);text=text.replace(from,to);}
 await fs.writeFile(path.join(candidate,p),text);files.push({path:p,before:hash(bytes),candidate:hash(Buffer.from(text))});
}
const p='worker/classic-multisource-bgm.mjs';
try{await fs.stat(path.join(live,p));throw Error('NEW_MODULE_ALREADY_EXISTS');}catch(e){if(e.code!=='ENOENT')throw e;}
await fs.copyFile(p,path.join(candidate,p));files.push({path:p,before:null,candidate:hash(await fs.readFile(p))});
await fs.mkdir(path.join(candidate,'tests'),{recursive:true});
for(const p of ['classic-multisource-nw-bgm.test.mjs','brand-bgm.test.mjs','bgm-only.test.mjs','classic-brand-activation.test.mjs','brand-copy.test.mjs','classic-multisource.test.mjs','classic-multisource-continuity.test.mjs'])await fs.copyFile(path.join('tests',p),path.join(candidate,'tests',p));
// Preserve every unrelated deployed module; do not copy development executor overlays.
const protectedHashes={};
for(const dir of ['lib','worker','config'])for(const f of await fs.readdir(path.join(live,dir))){
 const p=dir+'/'+f;if(files.some(x=>x.path===p)||!(await fs.stat(path.join(live,p))).isFile())continue;
 protectedHashes[p]=hash(await fs.readFile(path.join(live,p)));
}
protectedHashes['.env.local']=hash(await fs.readFile(path.join(live,'.env.local')));
await fs.writeFile(path.join(dest,'prepared.json'),JSON.stringify({live,candidate,preparedAt:new Date().toISOString(),files,protectedHashes},null,2));
console.log(JSON.stringify({candidate,files,protectedCount:Object.keys(protectedHashes).length}));
