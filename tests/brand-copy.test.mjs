import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {canonicalBrand,indexCopyWorkbooks,ensureBrandCopySnapshot,trustedCopyContext,brandCopyEnabled} from '../lib/brand-copy-library.mjs';
import {matchOutputCopy,copyIsSupported} from '../lib/brand-copy-match.mjs';
import {prepareOutputBrandCopy} from '../worker/brand-copy-render.mjs';

const book=(name='GuidingCross_FB_Hook库.xlsx',text='Faith in every detail')=>({filename:name,sha256:'a'.repeat(64),sheets:[{name:'总库',rows:[{row:1,cells:{A:'分类',B:'英文 Hook',C:'中文理解',D:'适用场景'}},{row:2,cells:{A:'图案设计',B:text,C:'释义',D:'图案特写'}}]}]});
function fixture(tags=['scene:ootd'],type='overall'){
 const batch={id:'b',brandCopyContext:trustedCopyContext({brandId:'GC'},'authenticated_api')};
 const product={product_id:'p',duration_seconds:10,segments:[{shot_id:'s',content_tags:tags,duration:10}]};
 const semanticEvidence={batchId:'b',records:[{shotId:'s',status:'scored',result:{usable:true,product_match:.9,clothing_visibility:.9,shot_type:type}}]};
 return {batch,product,outputId:'p.mp4',semanticEvidence,templateMaster:{},snapshot:{hash:'snapshot',entries:[
  {id:'unbox',brand:'GC',kind:'hook',text:'A closer look at this design',scene:'开箱',category:'开箱推荐',sources:[]},
  {id:'ootd',brand:'GC',kind:'hook',text:'Faith in everyday style',scene:'OOTD',category:'穿搭',sources:[]},
  {id:'detail',brand:'GC',kind:'hook',text:'The meaning is in the details',scene:'图案特写',category:'设计',sources:[]},
  {id:'cta',brand:'GC',kind:'cta',text:'Explore the collection',scene:'通用',category:'CTA',sources:[]},
  {id:'tt',brand:'TT',kind:'hook',text:'Tokyo style, your way',scene:'OOTD',category:'穿搭',sources:[]},
 ]}};
}
test('aliases are upstream-only; unknown and fitness never infer a brand',()=>{
 for(const v of ['GC','GuidingCross'])assert.equal(canonicalBrand(v),'GC');
 for(const v of ['TT','Tokyo-Tiger','TokyoTiger'])assert.equal(canonicalBrand(v),'TT');
 assert.equal(canonicalBrand('gym'),null);
 assert.equal(indexCopyWorkbooks([book('健身hook库.xlsx')]).entries.length,0);
 const f=fixture();delete f.batch.brandCopyContext;assert.equal(matchOutputCopy(f).hook.text,'');
 assert.equal(brandCopyEnabled({},{}),false);
 assert.equal(trustedCopyContext({brandId:'GC'},'model_guess'),undefined);
});
test('headers, real rows, original punctuation, CTA and duplicate sources; retired table has no effect',()=>{
 const b=book();b.sheets[0].rows.push({row:3,cells:{A:'CTA-通用',B:'Explore the collection',D:'通用'}},{row:4,cells:{A:'说明',B:'Example: do not use this'}},{row:5,cells:{A:'图案设计',B:'Faith in every detail',D:'图案特写'}});
 b.sheets.push({name:'35-44优先测试',rows:[b.sheets[0].rows[0],{row:2,cells:{A:'优先',B:'Retired text only',D:'OOTD'}}]});
 const r=indexCopyWorkbooks([b]);assert.equal(r.entries.length,2);assert.equal(r.entries.find(e=>e.kind==='hook').sources.length,2);assert.ok(!r.entries.some(e=>e.text==='Retired text only'));
 const c=book('TT_Hook_CTA.xlsx','WEAR WHAT YOU’RE INTO');assert.equal(indexCopyWorkbooks([c]).entries[0].text,'WEAR WHAT YOU’RE INTO');
 b.sheets.pop();assert.deepEqual(indexCopyWorkbooks([b]).entries,r.entries);
});
test('same Batch three outputs match independently from selected content, not unselected script shots',()=>{
 const a=fixture(['scene:unboxing']);a.semanticEvidence.records[0].result.shot_type='other';
 a.product.segments.push({shot_id:'ootd-second',content_tags:['scene:ootd'],duration:3});
 a.semanticEvidence.records.push({shotId:'ootd-second',status:'scored',result:{usable:true,product_match:.9,clothing_visibility:.9,shot_type:'overall'}});
 const b=fixture(['scene:ootd']);const c=fixture([], 'detail');
 a.batch.brandCopyContext.script={shots:[{shotId:'not-selected',description:'training discount'}]};
 const values=[a,b,c].map((f,i)=>matchOutputCopy({...f,outputId:`${i}.mp4`,product:{...f.product,product_id:`p${i}`}}));
 assert.deepEqual(values.map(v=>v.hook.entryId),['unbox','ootd','detail']);
 assert.ok(values.every(v=>v.cta.entryId==='cta'));assert.equal(values[0].content.tags.includes('training'),false);
});
test('foreign/REJECT evidence cannot supply scene tags',()=>{
 const f=fixture();f.semanticEvidence.batchId='foreign';assert.equal(matchOutputCopy(f).hook.source,'none');
 f.semanticEvidence.batchId='b';f.semanticEvidence.records[0].verdict='REJECT';assert.equal(matchOutputCopy(f).hook.source,'none');
});
test('Hook and CTA separate; locked fields independent; script/template/none fallback',()=>{
 const f=fixture();f.batch.hookText='My locked message';let r=matchOutputCopy(f);assert.equal(r.hook.source,'locked');assert.equal(r.cta.source,'library');
 delete f.batch.hookText;f.snapshot.entries=[];f.batch.brandCopyContext.script={hook:'Original script',cta:'See more'};r=matchOutputCopy(f);assert.equal(r.hook.source,'script');assert.equal(r.cta.source,'script');
 f.batch.brandCopyContext.script={};f.templateMaster={hook:{text:'Template original'}};assert.equal(matchOutputCopy(f).hook.source,'template');assert.equal(matchOutputCopy(f).cta.source,'none');
});
test('unsupported promotion, claims and outfit counts do not change scheduling or prevent output',()=>{
 const f=fixture();const before=JSON.stringify(f.product);const content=matchOutputCopy(f).content;
 for(const t of ['SHOP THE SALE','40% OFF','FREE SHIPPING','BUY ONE GET ONE FREE','ONLY $20 TODAY','THIS PASSED THE GYM TEST','ONE TEE, 4 EASY OUTFITS','our best seller','more comfortable than expected'])assert.equal(copyIsSupported(t,content),false,t);
 content.claims.promotion={verified:true,active:true,percent:20};assert.equal(copyIsSupported('SHOP THE SALE',content),true);assert.equal(copyIsSupported('40% OFF',content),false);
 assert.equal(JSON.stringify(f.product),before);
});
test('different product brands do not share candidates',()=>{
 const f=fixture();f.batch.brandCopyContext.products={p:{brandId:'TT'}};const r=matchOutputCopy(f);assert.equal(r.hook.entryId,'tt');assert.equal(r.cta.source,'none');
});
test('too short/long captions are optional, never stretch a shot',()=>{
 const f=fixture();f.product.segments[0].duration=.4;const r=matchOutputCopy(f);assert.equal(r.hook.text,'');assert.equal(r.cta.text,'');assert.equal(f.product.segments[0].duration,.4);
});
test('snapshot refresh, stable running Batch, deletion replaces entries, last-good cache and zero-cache degradation',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'cut-copy-'));try{
  let books=[book()],calls=0;const reader=async()=>{calls++;return books;};
  const options={root,batch:{id:'one',brandCopyEnabled:true},batchDir:path.join(root,'one'),reader,env:{}};
  const a=await ensureBrandCopySnapshot(options);books=[book('GuidingCross_FB_Hook库.xlsx','New source text')];
  assert.equal((await ensureBrandCopySnapshot(options)).hash,a.hash);assert.equal(calls,1);
  const b=await ensureBrandCopySnapshot({...options,batch:{id:'two',brandCopyEnabled:true},batchDir:path.join(root,'two')});assert.notEqual(b.hash,a.hash);assert.ok(!b.entries.some(e=>e.text==='Faith in every detail'));
  const unavailable=async()=>{throw Error('NAS_DOWN');};const cached=await ensureBrandCopySnapshot({...options,batch:{id:'three',brandCopyEnabled:true},batchDir:path.join(root,'three'),reader:unavailable});assert.equal(cached.hash,b.hash);
  const empty=await ensureBrandCopySnapshot({...options,batch:{id:'four',brandCopyEnabled:true},batchDir:path.join(root,'four'),cacheFile:path.join(root,'no-cache.json'),reader:unavailable});assert.deepEqual(empty.entries,[]);
  const broken=await ensureBrandCopySnapshot({...options,batch:{id:'five',brandCopyEnabled:true},batchDir:path.join(root,'five'),reader:async()=>[{filename:'GuidingCross_FB_Hook库.xlsx',error:'BadZipFile'}]});assert.equal(broken.hash,b.hash);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('output overlay paths isolated; Excel updates do not replace frozen output selection; optional errors omit copy',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'cut-copy-output-'));try{
  const f=fixture();const opts={root,batchDir:root,editDir:root,runtimeConfig:{pythonExecutable:'unused',subtitleTemplatePath:'unused'},run:async()=>{},master:{},...f};
  const a=await prepareOutputBrandCopy(opts);const b=await prepareOutputBrandCopy({...opts,outputId:'second.mp4'});assert.notEqual(a.hookOverlayPath,b.hookOverlayPath);
  const changed=await prepareOutputBrandCopy({...opts,snapshot:{entries:[],hash:'new'}});assert.equal(changed.decision.hook.text,a.decision.hook.text);
  const failed=await prepareOutputBrandCopy({...opts,outputId:'failure.mp4',run:async()=>{throw Error('font unavailable');}});assert.equal(failed.hookOverlayPath,null);assert.equal(failed.master.hook.text,'');
  assert.equal(JSON.parse(await readFile(path.join(path.dirname(a.hookOverlayPath),'copy-edl.json'))).master.hook.text,a.decision.hook.text);
 }finally{await rm(root,{recursive:true,force:true});}
});
