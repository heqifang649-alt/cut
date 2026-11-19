import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
const root='D:/CUT-Releases/20261030-production-first-r11';
const dir=path.resolve('.project-governance/evidence/brand-bgm-unification-20261113/deployment');
const candidate=path.join(dir,'candidate');
const digest=b=>createHash('sha256').update(b).digest('hex');
await fs.mkdir(candidate,{recursive:true});
for(const d of ['lib','worker','standards'])await fs.cp(path.join(root,d),path.join(candidate,d),{recursive:true});
await fs.mkdir(path.join(candidate,'config'),{recursive:true});
for(const f of ['cutflow-runtime.json','brand-copy-files.json','brand-bgm-directories.json','classic-brand-activation.json','classic-website-template.json','guided-safe-pool-policy.json'])await fs.copyFile(path.join(root,'config',f),path.join(candidate,'config',f));
if(!await fs.stat(path.join(candidate,'node_modules')).catch(()=>null))await fs.symlink(path.resolve('node_modules'),path.join(candidate,'node_modules'),'junction');
const files=[];
const set=async(p,text)=>{const before=await fs.readFile(path.join(root,p)).catch(e=>{if(e.code==='ENOENT')return null;throw e;});await fs.writeFile(path.join(candidate,p),text);files.push({path:p,before:before?digest(before):null,candidate:digest(Buffer.from(text))});};
// Require approved development edits to be precisely the intended extension of production.
for(const p of ['worker/brand-bgm.mjs','lib/classic-brand-activation.mjs']){
 let prod=await fs.readFile(path.join(root,p),'utf8'),dev=await fs.readFile(p,'utf8');
 const prodNormalized=prod.replace(/\r\n/g,'\n'),devNormalized=dev.replace(/\r\n/g,'\n');
 if(p==='lib/classic-brand-activation.mjs'){
   const prefix=prodNormalized.slice(0,prodNormalized.indexOf('export async function enableClassicBrandResources'));
   const expected=prefix.replace("import { canonicalBrand } from './brand-copy-library.mjs';", "import { canonicalBrand } from './brand-copy-library.mjs';\nimport { canonicalBgmBrand, BRAND_BGM_DIRECTORIES } from './brand-bgm-identity.mjs';");
   if(!devNormalized.startsWith(expected))throw Error('INCOMPATIBLE_ACTIVATION_PREFIX');
 }else{
   const normalize=s=>s.replace(/import \{ canonicalBgmBrand, BRAND_BGM_DIRECTORIES \} from '..\/lib\/brand-bgm-identity.mjs';/,"import { canonicalBrand } from '../lib/brand-copy-library.mjs';")
    .replace('batch.brandBgmContext || batch.brandCopyContext','batch.brandCopyContext')
    .replace('return canonicalBgmBrand(value);',"return canonicalBrand(value) || (String(value).toUpperCase()==='NW' ? 'NW' : null);")
    .replace('  brand = canonicalBgmBrand(brand);\n','')
    .replace("if (!brand || folder !== BRAND_BGM_DIRECTORIES[brand])", "if (!['GC','TT','NW'].includes(brand) || typeof folder!=='string' || path.basename(folder)!==folder || ['.','..'].includes(folder))")
    .replace('cacheRoot,musicDirectory=BGM_ROOT,enabled=true','cacheRoot,enabled=true')
    .replace('cacheRoot,exclude,directory:musicDirectory','cacheRoot,exclude');
   if(normalize(devNormalized)!==prodNormalized)throw Error('INCOMPATIBLE_BGM_MODULE');
 }
 await set(p,dev);
}
for(const p of ['lib/brand-bgm-identity.mjs','worker/classic-multisource-bgm.mjs'])await set(p,await fs.readFile(p,'utf8'));
const mapping=JSON.parse(await fs.readFile(path.join(root,'config/brand-bgm-directories.json'),'utf8'));
const expected={NW:'暗黑',IP:'健身',GC:'基督',TT:'亚文化',GK:'极客',TSG:'教师',PPH:'泛读书'};
for(const [k,v]of Object.entries(mapping))if(expected[k]&&v!==expected[k])throw Error('CONFLICTING_PRODUCTION_MAPPING:'+k);
await set('config/brand-bgm-directories.json',JSON.stringify({...mapping,...expected},null,2)+'\n');
const protectedHashes={};
for(const d of ['lib','worker','config'])for(const e of await fs.readdir(path.join(root,d),{withFileTypes:true})){
 const p=d+'/'+e.name;if(e.isFile()&&!files.some(f=>f.path===p))protectedHashes[p]=digest(await fs.readFile(path.join(root,p)));
}
protectedHashes['.env.local']=digest(await fs.readFile(path.join(root,'.env.local')));
await fs.mkdir(path.join(candidate,'tests'),{recursive:true});
for(const f of ['brand-bgm-mapping.test.mjs','classic-multisource-nw-bgm.test.mjs','brand-bgm.test.mjs','bgm-only.test.mjs','classic-brand-activation.test.mjs','brand-copy.test.mjs','bgm-only-renderer.integration.test.mjs','bgm-only-guided.integration.test.mjs','classic-brand-normal.integration.test.mjs','allwe-website-template-pilot.test.mjs','ootd-template-diversity.test.mjs'])await fs.copyFile(path.join('tests',f),path.join(candidate,'tests',f));
await fs.writeFile(path.join(dir,'prepared.json'),JSON.stringify({root,candidate,preparedAt:new Date().toISOString(),files,protectedHashes},null,2));
console.log(JSON.stringify({candidate,files,protectedCount:Object.keys(protectedHashes).length}));
