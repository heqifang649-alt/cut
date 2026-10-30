import { readFile,mkdir,stat,copyFile } from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {copyHash,ensureBrandCopySnapshot,readCopyWorkbooks,indexCopyWorkbooks,trustedCopyContext} from '../lib/brand-copy-library.mjs';
import {createProductViews} from '../worker/shot-scheduler.mjs';
import {renderBatchFromRenderPlans,verifyEncodedSafeDuration} from '../worker/batch-renderer.mjs';
import {loadRenderRuntimeConfig} from '../worker/runtime-config.mjs';
import {writeJsonAtomic} from '../lib/atomic-json.mjs';

const root=process.cwd(),out=path.join(root,'.project-governance/evidence/brand-copy-20261020');
const delivery=path.join(root,'artifacts/brand-copy-20261020');await mkdir(out,{recursive:true});await mkdir(delivery,{recursive:true});
const json=async p=>JSON.parse(await readFile(p,'utf8'));
const config=await loadRenderRuntimeConfig(root);
const run=(exe,args)=>new Promise((resolve,reject)=>{const p=spawn(exe,args,{windowsHide:true});let error='';p.stderr.on('data',d=>error+=d);p.on('error',reject);p.on('exit',c=>c===0?resolve():reject(Error(error.slice(-1500))));});
const protectedFiles=['data/production-path.json','config/cutflow-runtime.json','.env.local','standards/quality-gate-v2-policy.json','worker/scheduler-v2-policy.mjs'];
const protectedHashes=await Promise.all(protectedFiles.map(async file=>({file,hash:copyHash(await readFile(file))})));
const books=await readCopyWorkbooks({root,pythonExecutable:config.pythonExecutable,files:['GuidingCross_FB_Hook库.xlsx','TT_Hook_CTA.xlsx','健身hook库.xlsx'],timeoutMs:5000});
await writeJsonAtomic(path.join(out,'workbooks-readonly.json'),books);
const index=indexCopyWorkbooks(books);await writeJsonAtomic(path.join(out,'index.json'),index);
const previous=await json(path.join(root,'.project-governance/evidence/safe8-real-canary-20261020/report.json'));
const gcA=previous.scenarios.find(s=>s.id==='S1-single-ootd'),gcB=previous.scenarios.find(s=>s.id==='S4-three-mixed-views');
const report={version:'brand-copy-canary.v1',providerCalls:0,generationCalls:0,independentHumanReview:'pending',protectedHashes,sourceIntegrity:[],outputs:[],warnings:[]};
for(const row of [gcA,gcB])for(const s of row.sources){
 if(copyHash(await readFile(s.copy))!==s.sha256)throw Error('SOURCE_HASH_CHANGED');
 if(s.qualityVerdict!=='accept'&&row.schedule.selections.some(x=>x.source===s.copy))throw Error('UNACCEPTED_SOURCE_SELECTED');
 report.sourceIntegrity.push({file:s.copy,sha256:s.sha256,evidence:s.qualityEvidence});
}
async function gcInput(row,batchId){
 const dir=path.join(root,'.project-governance/evidence/safe8-real-canary-20261020',row.id);
 const sem=await json(path.join(dir,'semantic-evidence.used.json'));
 const product={id:row.schedule.renderPlan.slots[0].shot.path.includes('75b9')?'P001':'P003',label:row.id,files:[...new Set(row.schedule.selections.map(s=>path.basename(s.source)))]};
 const result=structuredClone(row.schedule);result.renderPlan.batchId=batchId;
 const sourceNamesByShotId=Object.fromEntries(result.renderPlan.slots.map(s=>[s.shot.id,path.basename(s.shot.path)]));
 return {entry:{product,sourceNamesByShotId,scheduleResult:result},records:sem.records,provenance:path.join(dir,'semantic-evidence.used.json')};
}
async function renderCase({id,brand,inputs,context,products}){
 const dir=path.join(out,id);await mkdir(dir,{recursive:true});
 const batch={id,ownerId:'isolated-canary',name:id,status:'editing',files:[],requirements:'Existing real sources; optional original library copy only',durationMax:13,outputCount:1,targetOutputsPerBatch:inputs.length,speed:1,colorStrategy:'none',musicSource:'library',transitionMode:'standard',brandCopyEnabled:true,brandCopyContext:trustedCopyContext({brandId:brand,...context},'isolated_canary')};
 const snapshot=await ensureBrandCopySnapshot({root,batch,batchDir:dir,pythonExecutable:config.pythonExecutable,cacheFile:path.join(out,'library-cache.json')});
 const semanticEvidence={batchId:id,complete:true,records:inputs.flatMap(i=>i.records),provenance:inputs.map(i=>i.provenance)};
 await writeJsonAtomic(path.join(dir,'semantic-evidence.used.json'),semanticEvidence);
 console.log(id,'render start',snapshot.hash);
 const options={root,batch,batchDir:dir,editDir:path.join(dir,'edit'),outputDir:path.join(dir,'output'),ffmpeg:config.ffmpegExecutable,scheduledProducts:inputs.map(i=>i.entry),semanticEvidence,onActivity:async label=>console.log(id,label)};
 const rendered=await renderBatchFromRenderPlans(options);
 const originals=[];
 for(const record of rendered.files){
  const file=path.resolve(root,record.storagePath),duration=await verifyEncodedSafeDuration(config.ffprobeExecutable,file);
  const decode=await run(config.ffmpegExecutable,['-v','error','-i',file,'-f','null','-']);void decode;
  const destination=path.join(delivery,id+'-'+record.productId+'.mp4');await copyFile(file,destination);
  const preview=path.join(dir,'preview-'+record.productId+'.jpg');
  await run(config.ffmpegExecutable,['-v','error','-y','-i',file,'-vf','fps=1,scale=180:320,tile=6x2','-frames:v','1',preview]);
  const frameA=path.join(dir,'first-'+record.productId+'.jpg');await run(config.ffmpegExecutable,['-v','error','-y','-ss','0.3','-i',file,'-frames:v','1','-vf','scale=540:960',frameA]);
  report.outputs.push({id,brand,productId:record.productId,mp4:destination,duration,copy:record.brandCopy,sourcePlan:inputs.find(i=>i.entry.product.id===record.productId)?.entry.scheduleResult,semanticProvenance:semanticEvidence.provenance,preview,firstFrame:frameA,sha256:copyHash(await readFile(file)),decode:'pass',independentHumanReview:'pending',inputProducts:products});
  originals.push({file,mtimeMs:(await stat(file)).mtimeMs,hash:copyHash(await readFile(file))});
 }
 // Local cache mutation simulates a future workbook refresh; frozen snapshot/output must survive it.
 await writeJsonAtomic(path.join(out,'library-cache.json'),{books:[],version:'simulated_future_cache'});
 await renderBatchFromRenderPlans(options);
 for(const prior of originals)if((await stat(prior.file)).mtimeMs!==prior.mtimeMs||copyHash(await readFile(prior.file))!==prior.hash)throw Error('COMPLETED_OUTPUT_RERENDERED');
 report.outputs.filter(r=>r.id===id).forEach(r=>{r.resumeWithoutRerender=true;});
 await writeJsonAtomic(path.join(out,'report.json'),report);
}
const gcId='copy-gc-multi-output';
await renderCase({id:gcId,brand:'GC',inputs:[await gcInput(gcA,gcId),await gcInput(gcB,gcId)],context:{products:{P001:{garment:'sweatshirt',script:{hook:'Faith in everyday style',description:'OOTD front and print close-ups'}},P003:{garment:'hoodie',script:{hook:'The message on this one',description:'Back graphic and front display'}}}}});

const ttQuality=await json(path.join(out,'tt-quality-source.json'));
const ttBytes=await readFile(ttQuality.path);if(copyHash(ttBytes)!==ttQuality.hash)throw Error('TT_SOURCE_CHANGED');
for(const ref of ttQuality.refs)if(copyHash(await readFile(ref.sourcePath))!==ref.sha256)throw Error('TT_REFERENCE_CHANGED');
const quality=(await json(path.resolve(ttQuality.evidence))).sources.find(s=>s.sourceHash===ttQuality.hash);
if(quality.manualReview||quality.decision.verdict!=='accept')throw Error('TT_QUALITY_NOT_AUTOMATIC_ACCEPT');
report.sourceIntegrity.push({file:ttQuality.path,sha256:ttQuality.hash,evidence:ttQuality.evidence,limitation:'Prior isolated model-comparison evidence, not a new provider/production quality pass'});
const inventory=await json(path.join(root,'.tmp/safe8-real-inventory.json'));
const origin=inventory.find(r=>r.batchId.startsWith('f1e8578b')&&r.product.id==='TT4-M1');
const pool=await json(path.join(root,origin.dir,'shot-pool.json')),groups=await json(path.join(root,origin.dir,'product-groups.json'));
const view=createProductViews({shotPool:pool,productGroups:groups.groups}).find(v=>v.product.id==='TT4-M1');
const selected=view.shots.filter(s=>s.path===ttQuality.path).sort((a,b)=>a.start-b.start);
const oldSem=await json(path.join(root,origin.dir,'semantic-evidence.v1.json'));
if(selected.length!==3)throw Error('TT_FROZEN_WINDOWS_NOT_FOUND');
for(const shot of selected){const r=oldSem.records.find(r=>r.shotId===shot.id);if(!r?.result?.usable||r.result.product_match<.5||r.result.clothing_visibility<.5)throw Error('TT_SEMANTIC_NOT_ACCEPTED');}
const ttId='copy-tt-ootd';
const ttResult={status:'success',renderPlan:{id:'copy-canary-replayed-tt-windows',batchId:ttId,createdAt:new Date().toISOString(),minimumSafeDuration:8,transitionProfile:'hard_cut',slots:selected.map((shot,i)=>({shot,slot:{id:'product_'+i,label:'product',requireTags:[],targetDuration:shot.duration}}))}};
await renderCase({id:ttId,brand:'TokyoTiger',inputs:[{entry:{...view,scheduleResult:ttResult},records:oldSem.records.filter(r=>selected.some(s=>s.id===r.shotId)),provenance:path.join(root,origin.dir,'semantic-evidence.v1.json')}],context:{product:{garment:'sweater'},script:{hook:'Japanese-inspired graphic sweater',cta:'See the full collection'}}});
const noCopy='copy-no-match';
await renderCase({id:noCopy,brand:'UNMAPPED',inputs:[await gcInput(gcA,noCopy)],context:{}});
for(const item of protectedHashes)if(copyHash(await readFile(path.join(root,item.file)))!==item.hash)throw Error('PROTECTED_FILE_CHANGED');
for(const book of books){if(book.sha256&&copyHash(await readFile(path.join('\\\\192.168.120.60\\新成片交付\\批量剪辑素材\\HOOK文案',book.filename)))!==book.sha256)report.warnings.push('WORKBOOK_CHANGED_EXTERNALLY:'+book.filename);}
report.protectedFilesUnchanged=true;report.excelModifiedByCanary=false;report.delivery=delivery;
await writeJsonAtomic(path.join(out,'report.json'),report);
await copyFile(path.join(out,'report.json'),path.join(delivery,'manifest.json'));
console.log(JSON.stringify(report.outputs.map(o=>({file:o.mp4,duration:o.duration,hook:o.copy?.actualHook,cta:o.copy?.actualCTA})),null,2));
