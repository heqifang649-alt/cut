import assert from 'node:assert/strict';
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {readCopyWorkbooks,indexCopyWorkbooks,ensureBrandCopySnapshot,canonicalBrand} from '../lib/brand-copy-library.mjs';
import {enableClassicBrandResources} from '../lib/classic-brand-activation.mjs';
import {reserveOutputCopy} from '../lib/brand-copy-history.mjs';
const out='.project-governance/evidence/hook-library-20261113';await fs.mkdir(out,{recursive:true});
const root=await fs.mkdtemp(path.join(os.tmpdir(),'hook-update-'));await fs.mkdir(path.join(root,'config'));await fs.mkdir(path.join(root,'data'));
const config=JSON.parse(await fs.readFile('config/brand-copy-files.json'));const runtime=JSON.parse(await fs.readFile('config/cutflow-runtime.json'));
await fs.writeFile(path.join(root,'config/brand-copy-files.json'),JSON.stringify(config));
const books=await readCopyWorkbooks({root:process.cwd(),pythonExecutable:runtime.pythonExecutable,files:Object.values(config.filesByBrand).flat()});assert.ok(books.every(b=>!b.error));
const snapshot=indexCopyWorkbooks(books,config.filesByBrand);const summary=[];
for(const [brand,names] of Object.entries(config.filesByBrand)){
 const entries=snapshot.entries.filter(e=>e.brand===brand&&e.kind==='hook');assert.ok(entries.length>1);assert.ok(entries.every(e=>e.sources.every(s=>names.includes(s.filename))));
 const decisions=[];for(let i=0;i<4;i++)decisions.push(await reserveOutputCopy({root,batch:{id:brand+i,brandCopyContext:{brandId:brand,provenance:'verified_handoff'}},product:{product_id:'fixture',duration_seconds:12,segments:[{duration:3},{duration:3}]},outputId:'fixture',fingerprint:'fixture',snapshot}));
 assert.ok(decisions.every(d=>d.brand===brand&&d.hook.source==='library'));assert.ok(new Set(decisions.map(d=>d.hook.entryId)).size>1);
 const stat=await fs.stat(path.join(String.raw`\\192.168.120.60\新成片交付\批量剪辑素材\HOOK文案`,names[0]));
 summary.push({brand,file:names[0],hooks:entries.length,sha256:books.find(b=>b.filename===names[0]).sha256,modifiedAt:stat.mtime.toISOString(),bytes:stat.size,rotation:decisions.map(d=>d.hook.text)});
}
let current=books;const opts={root,batch:{id:'before',brandCopyEnabled:true},batchDir:path.join(root,'before'),pythonExecutable:runtime.pythonExecutable,reader:async()=>current};await fs.mkdir(opts.batchDir);
const old=await ensureBrandCopySnapshot(opts);current=structuredClone(books);current[0].sha256='a'.repeat(64);current[0].sheets[0].rows.push({row:999,cells:{B:'A fresh updated hook'}});
assert.equal((await ensureBrandCopySnapshot(opts)).hash,old.hash);
await fs.mkdir(path.join(root,'after'));const fresh=await ensureBrandCopySnapshot({...opts,batch:{id:'after',brandCopyEnabled:true},batchDir:path.join(root,'after')});assert.notEqual(fresh.hash,old.hash);assert.ok(fresh.entries.some(e=>e.text==='A fresh updated hook'));
await fs.mkdir(path.join(root,'failure'));assert.ok((await ensureBrandCopySnapshot({...opts,batch:{id:'failure',brandCopyEnabled:true},batchDir:path.join(root,'failure'),reader:async()=>{throw Error('offline')}})).entries.length);
config.classicHookEnabledAfter='2026-11-13T00:00:00Z';await fs.writeFile(path.join(root,'config/brand-copy-files.json'),JSON.stringify(config));
for(const brand of ['NW','IP','PPH']){
 const o={root,context:{brandId:brand,provenance:'verified_handoff'},taskId:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',manifestSha256:'a'.repeat(64),acceptedAt:'2026-11-13T01:00:00Z',sources:[{brandIdentity:brand}]};
 assert.equal((await enableClassicBrandResources(o)).brandCopyEnabled,true);assert.notEqual((await enableClassicBrandResources({...o,acceptedAt:'2026-11-12T00:00:00Z'})).brandCopyEnabled,true);assert.notEqual((await enableClassicBrandResources({...o,sources:[{brandIdentity:'TT'}]})).brandCopyEnabled,true);
}
assert.equal(canonicalBrand('IronPandaFit'),'IP');assert.equal(canonicalBrand('PurpleHecate'),'PPH');
await fs.writeFile(out+'/audit.json',JSON.stringify({summary,tests:['five_brand_reads','brand_isolation','real_library_rotation','new_task_refresh','existing_snapshot_immutable','offline_cache','activation_cutoff','mixed_brand_rejected'],productionChanged:false},null,2));console.log(JSON.stringify(summary));console.log('PASS isolated checks');

