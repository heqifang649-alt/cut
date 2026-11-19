// Offline only. Never invoke the Classic executor, queue, quality API or publication.
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {allocateOotdDuration} from '../worker/ootd-dynamic-duration.mjs';
const production='D:/CUT-Releases/20261030-production-first-r11';
const base=path.resolve('artifacts/ootd-dynamic-duration-20261113/edit');
const load=p=>import(pathToFileURL(production+'/'+p));
const read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
const {collectGuidedEditingEvidence}=await load('worker/guided-editing-evidence.mjs');
const {renderBatchFromRenderPlans}=await load('worker/batch-renderer.mjs');
const {refineGuidedV22,analyseGuidedMusic}=await load('worker/guided-rhythm-v22.mjs');
const {normalizeBrandTrack}=await load('worker/brand-bgm.mjs');
const {renderOotdTemplate}=await load('worker/ootd-template-render.mjs');
const {trustedCopyContext}=await load('lib/brand-copy-library.mjs');
await fs.mkdir(base,{recursive:true});
for(const id of ['2a4ec2a9-436e-4f46-a490-ab99035e3a83','336ab52a-ef45-4039-9ff4-794018b5bade']){
 const work='E:/cutflow批量/classic-multisource/'+id,dir=base+'/'+id;
 await fs.mkdir(dir,{recursive:true});
 const schedule=await read(work+'/edit/multisource-schedule-result.json');
 const shots=schedule.scheduledProducts.flatMap(p=>p.scheduleResult.renderPlan.slots.map(e=>e.shot));
 let evidence;try{evidence=await read(dir+'/local-evidence.json');}catch{
 evidence=await collectGuidedEditingEvidence({shots,ffmpeg:(await read(production+'/config/cutflow-runtime.json')).ffmpegExecutable,includeInternalCuts:true,budgetMs:60000});
 await fs.writeFile(dir+'/local-evidence.json',JSON.stringify(evidence,null,2));}
 if(process.argv.includes('--prepare-only'))continue;
 const record=(await read(production+'/data/classic-multisource-records.json')).find(r=>r.taskId===id);
 const quality=await read(work+'/quality/classic-multisource-quality.v1.json');
 const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
 const inputs=await read(work+'/analyze/deterministic-inputs.v1.json');
 for(const s of inputs.sidecars){if(hash(await fs.readFile(s.videoPath))!==record.sources.find(r=>r.id===s.fileId).sha256)throw Error('SOURCE_HASH');}
 for(const d of quality.decisions){if(hash(await fs.readFile(work+'/quality/'+d.evidencePath))!==d.evidenceSha256)throw Error('QUALITY_HASH');}
 const edl=await read(work+'/edit/render-plan-edl.json'),manifest=await read(work+'/output/render-manifest.json');
 const baseline=structuredClone(schedule.scheduledProducts);
 for(const p of baseline){p.scheduleResult.renderPlan.slots=edl.products.find(x=>x.product_id===p.product.id).segments.map((s,i)=>{
 const d=quality.decisions.find(d=>d.shotId===s.shot_id);
 if(!quality.admittedShotIds.includes(d.shotId))throw Error('NOT_ADMITTED');
 return {slot:{id:'segment_'+i,label:'Original final segment',requireTags:[],targetDuration:s.duration},shot:{id:d.shotId,source:d.sourceId,path:s.source_original,start:s.source_in,end:s.source_out,duration:s.duration,tags:s.content_tags,reject:false,origin:'real',productVisibility:.5,productCentered:true,motionEnergy:'medium'}};
 });}
 const allocated=allocateOotdDuration({products:schedule.scheduledProducts,baselineProducts:baseline,evidence,context:{templateId:'1527e301-7707-449d-8e7c-d27014080c8d',postDeployment:true,types:record.sources.map(s=>s.videoType)}});
 await fs.writeFile(dir+'/allocation.json',JSON.stringify(allocated,null,2));
 for(const arm of ['A','B']){
  const root=dir+'/'+arm+'-final';await fs.mkdir(root+'/config',{recursive:true});await fs.mkdir(root+'/worker',{recursive:true});await fs.mkdir(root+'/data',{recursive:true});
  for(const f of ['cutflow-runtime.json','brand-copy-files.json','brand-bgm-directories.json'])await fs.copyFile(production+'/config/'+f,root+'/config/'+f);
  for(const f of ['render-overlays.py','read-hook-workbooks.py'])await fs.copyFile(production+'/worker/'+f,root+'/worker/'+f);
  await fs.copyFile(production+'/data/brand-copy-cache.v1.json',root+'/data/brand-copy-cache.v1.json');
  const config=await read(root+'/config/cutflow-runtime.json');config.workRoot=root+'/work';config.runtimeTempRoot=root+'/temp';config.runtimeCacheRoot=root+'/cache';config.deliveryRoot=root+'/delivery';await fs.writeFile(root+'/config/cutflow-runtime.json',JSON.stringify(config));
  const batchDir=root+'/batch';await fs.mkdir(batchDir,{recursive:true});
  let copy=false;try{await fs.copyFile(work+'/brand-copy-snapshot.v1.json',batchDir+'/brand-copy-snapshot.v1.json');copy=true;}catch{}
  const templates=await read(production+'/data/templates.json'),template=templates.find(t=>t.id==='1527e301-7707-449d-8e7c-d27014080c8d');
  const batch={id:'offline-'+id+'-'+arm,ownerId:record.ownerId,storageVersion:1,status:'editing',files:[],durationMax:18,targetOutputsPerBatch:1,coveragePolicy:'all_products_required',colorStrategy:'none',transitionMode:'standard',templateId:template.id,referenceProfile:template.profile,brandCopyContext:trustedCopyContext({brandId:record.sourceBinding.value},'verified_handoff'),brandCopyEnabled:copy,brandBgmEnabled:true};
  const originalAudio=manifest.files[0].bgm;
  // Pin the same original song for A/B. Normalization and all audio writes stay
  // local; no random brand-track selection or live cache/history write.
  const audioFor=async(products,directory)=>{
   const duration=products[0].scheduleResult.renderPlan.slots.reduce((n,e)=>n+Math.min(e.slot.targetDuration,e.shot.duration),0);
   const audio=await normalizeBrandTrack({file:originalAudio.sourcePath,duration,directory,ffmpeg:config.ffmpegExecutable,ffprobe:config.ffprobeExecutable});
   return {path:audio.path,decision:{...originalAudio,...audio,path:originalAudio.sourcePath,normalizedPath:audio.path}};
  };
  const renderer=async o=>{
   const audio=await audioFor(o.scheduledProducts,batchDir+'/edit/pinned-final-audio');
   return renderBatchFromRenderPlans({...o,preparedBrandAudioByProduct:new Map([[baseline[0].product.id,audio]])});
  };
  const options={root,batch,batchDir,editDir:batchDir+'/edit',outputDir:batchDir+'/output',ffmpeg:config.ffmpegExecutable,scheduledProducts:arm==='A'?baseline:allocated.products,templateFallbackProducts:baseline};
  let result,adopted=arm==='B';
  if(arm==='A'||allocated.audit.state!=='candidate')result=await renderOotdTemplate(options,renderer);
  else try{
   const refined=[];const audits=[];
   for(const p of allocated.products){
    const natural=refineGuidedV22({result:p.scheduleResult,editingEvidence:evidence,naturalOnly:true});
    const audio=await audioFor([{...p,scheduleResult:natural.result}],batchDir+'/edit/pinned-natural-audio');
    const music=await analyseGuidedMusic({ffmpeg:config.ffmpegExecutable,file:audio.path,duration:natural.result.actualCutDuration});
    let final=refineGuidedV22({result:p.scheduleResult,editingEvidence:evidence,peaks:music.peaks,musicReason:music.reason});
    const finalAudio=await audioFor([{...p,scheduleResult:final.result}],batchDir+'/edit/pinned-check-audio');
    const finalMusic=await analyseGuidedMusic({ffmpeg:config.ffmpegExecutable,file:finalAudio.path,duration:final.result.actualCutDuration});
    if(final.audit.cuts?.some(c=>c.adjustment&&!finalMusic.peaks.some(q=>Math.abs(q.time-c.peak)<=.04)))final=natural;
    refined.push({...p,scheduleResult:final.result});audits.push({...final.audit,finalMusic});
   }
   await fs.mkdir(batchDir+'/edit',{recursive:true});await fs.writeFile(batchDir+'/edit/guided-v22-audit.json',JSON.stringify(audits,null,2));
   result=await renderOotdTemplate({...options,scheduledProducts:refined},renderer);
  }
  catch(error){adopted=false;await fs.writeFile(root+'/candidate-fallback.json',JSON.stringify({reason:error.message}));result=await renderOotdTemplate({...options,scheduledProducts:baseline},renderer);}
  let fallback=null;try{fallback=await read(batchDir+'/edit/website-template-render-fallback.json');adopted=false;}catch{}
  const finalEdl=await read(batchDir+'/edit/render-plan-edl.json');
  const audit={arm,adopted:adopted&&allocated.audit.state==='candidate',fallback,retainedOriginalFallback:allocated.audit.reason==='existing_template_fallback_keep_original',sourceTaskId:id,providerCalls:0,allocation:allocated.audit,finalEdl,result};
  // Only the final renderer EDL is authoritative, never the pre-render V2.2 audit.
  await fs.writeFile(root+'/final-adopted.json',JSON.stringify(audit,null,2));
  await fs.copyFile(path.resolve(root,result.files[0].storagePath),dir+'/'+arm+'.mp4');
  console.log(id,arm,'rendered',audit.adopted,finalEdl.products.map(p=>p.segments.map(s=>s.duration)));
 }
}
