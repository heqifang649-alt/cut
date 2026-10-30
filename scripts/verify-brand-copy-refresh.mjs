import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {indexCopyWorkbooks,ensureBrandCopySnapshot,trustedCopyContext,copyHash} from '../lib/brand-copy-library.mjs';
import {matchOutputCopy} from '../lib/brand-copy-match.mjs';
import {loadRenderRuntimeConfig} from '../worker/runtime-config.mjs';

const root=process.cwd(), dir=path.join(root,'.project-governance/evidence/brand-copy-refresh-20261021');
const json=async p=>JSON.parse(await readFile(p,'utf8'));
const books=await json(path.join(dir,'workbooks-readonly.json'));
const old=await json(path.join(root,'.project-governance/evidence/brand-copy-20261020/workbooks-readonly.json'));
const mapping=(await json(path.join(root,'config/brand-copy-files.json'))).filesByBrand;
const index=indexCopyWorkbooks(books,mapping);
const counts=entries=>({hook:entries.filter(e=>e.kind==='hook').length,cta:entries.filter(e=>e.kind==='cta').length});
const comparison=books.map(b=>({filename:b.filename,sha256:b.sha256,previousSameHash:old.find(o=>o.sha256===b.sha256)?.filename||null}));
const nw=index.entries.filter(e=>e.brand==='NW');
assert.ok(nw.length>0);
assert.equal(index.files.find(f=>f.filename==='暗黑.xlsx').validRows,110);
for(const entry of nw) for(const source of entry.sources){
 const row=books.find(b=>b.filename===source.filename).sheets.find(s=>s.name===source.sheet).rows.find(r=>r.row===source.row);
 assert.equal(entry.text,row.cells.C);
 assert.equal(entry.kind,source.sheet==='暗黑引导语'?'cta':'hook');
 assert.ok(entry.category&&entry.scene);
}
assert.ok(!index.entries.some(e=>e.sources.some(s=>/35[–-]44优先测试/.test(s.sheet))));
assert.ok(!index.entries.some(e=>e.sources.some(s=>s.filename==='健身.xlsx')));
const runtime=await loadRenderRuntimeConfig(root);
const batch={id:'refresh-nw-live',brandCopyEnabled:true,brandCopyContext:trustedCopyContext({brandId:'NW'},'authenticated_api')};
const options={root,batch,batchDir:path.join(dir,'live'),pythonExecutable:runtime.pythonExecutable,cacheFile:path.join(dir,'cache.json'),env:{}};
const snapshot=await ensureBrandCopySnapshot(options);
assert.equal(snapshot.hash,index.hash); assert.equal(snapshot.warning,null);
const outputs=[];
for(const [i,tags,type] of [[1,['scene:ootd'],'overall'],[2,['scene:detail'],'detail']]){
 const product={product_id:'nw-product',duration_seconds:12,segments:[{shot_id:'s',content_tags:tags,duration:12}]};
 const semanticEvidence={batchId:batch.id,records:[{shotId:'s',status:'scored',result:{usable:true,product_match:.9,clothing_visibility:.9,shot_type:type}}]};
 const decision=matchOutputCopy({batch,product,outputId:`nw-${i}.mp4`,snapshot,semanticEvidence,templateMaster:{}});
 for(const kind of ['hook','cta']) if(decision[kind].source==='library') assert.ok(nw.some(e=>e.id===decision[kind].entryId&&e.text===decision[kind].text));
 outputs.push(decision);
 const without=matchOutputCopy({batch,product,outputId:`missing-${i}.mp4`,snapshot:{entries:[],hash:copyHash([])},semanticEvidence,templateMaster:{}});
 assert.equal(without.hook.source,'none');assert.equal(without.cta.source,'none');
 const unknown=matchOutputCopy({batch:{...batch,brandCopyContext:trustedCopyContext({brandId:'UNMAPPED'},'authenticated_api')},product,outputId:'unknown',snapshot,semanticEvidence,templateMaster:{}});
 assert.equal(unknown.hook.source,'none');assert.equal(unknown.cta.source,'none');
}
const offline=await ensureBrandCopySnapshot({...options,batch:{...batch,id:'nw-offline'},batchDir:path.join(dir,'offline'),reader:async()=>{throw Error('NAS_DOWN');}});
assert.equal(offline.hash,snapshot.hash);
const broken=await ensureBrandCopySnapshot({...options,batch:{...batch,id:'nw-broken'},batchDir:path.join(dir,'broken'),reader:async()=>[{filename:'暗黑.xlsx',error:'BadZipFile'}]});
assert.equal(broken.hash,snapshot.hash);
const empty=await ensureBrandCopySnapshot({...options,batch:{...batch,id:'nw-no-cache'},batchDir:path.join(dir,'empty'),cacheFile:path.join(dir,'absent-cache.json'),reader:async()=>{throw Error('NAS_DOWN');}});
assert.deepEqual(empty.entries,[]);
assert.equal((await ensureBrandCopySnapshot({...options,reader:async()=>{throw Error('FROZEN_SNAPSHOT_SHOULD_NOT_READ');}})).hash,snapshot.hash);
const report={comparison,mapping,counts:Object.fromEntries(Object.keys(mapping).map(b=>[b,counts(index.entries.filter(e=>e.brand===b))])),fitnessUnbound:counts(indexCopyWorkbooks(books,{UNBOUND:['健身.xlsx']}).entries),checks:{originalText:true,scenesAndCategories:true,perOutputSelection:true,brandIsolation:true,unknownBrandSkipped:true,retiredSheetExcluded:true,liveDynamicRead:true,offlineCache:true,parseFailureCache:true,zeroCacheFallback:true,frozenSnapshot:true},outputs,providerCalls:0,productionDefaultsChanged:false,deployed:false};
await mkdir(dir,{recursive:true});
await writeFile(path.join(dir,'index.json'),JSON.stringify(index,null,2));
await writeFile(path.join(dir,'report.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({comparison,counts:report.counts,fitnessUnbound:report.fitnessUnbound,checks:report.checks,outputs:outputs.map(o=>({outputId:o.outputId,hook:o.hook,cta:o.cta}))},null,2));
