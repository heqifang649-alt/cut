import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { validateWithQualityGateV2 } from '../worker/quality-gate-v2.mjs';
import { runSemanticShadow } from '../worker/semantic-shadow.mjs';
import { createProductViews } from '../worker/shot-scheduler.mjs';
import { scheduleV2Policy } from '../worker/scheduler-v2-policy.mjs';
import { eligibleShots } from '../lib/scheduler-policy-v2.mjs';
import { renderBatchFromRenderPlans, verifyEncodedSafeDuration } from '../worker/batch-renderer.mjs';
import { loadRenderRuntimeConfig } from '../worker/runtime-config.mjs';

const root=process.cwd(), out=path.join(root,'.project-governance/evidence/safe8-real-canary-20261020');
const json=async p=>JSON.parse(await readFile(p,'utf8'));
const hash=b=>createHash('sha256').update(b).digest('hex');
const save=async(p,v)=>writeFile(p,JSON.stringify(v,null,2));
await mkdir(out,{recursive:true});
const runtime=await loadRenderRuntimeConfig(root);
const batches=await json(path.join(root,'data/batches.json'));
const inventory=await json(path.join(root,'.tmp/safe8-real-inventory.json'));
const protectedPaths=['data/production-path.json','config/cutflow-runtime.json','.env.local','standards/quality-gate-v2-policy.json'];
const protection=await Promise.all(protectedPaths.map(async file=>({file,sha256:hash(await readFile(path.join(root,file)))})));
const run=(exe,args)=>new Promise((resolve,reject)=>{const p=spawn(exe,args,{windowsHide:true});let err='';p.stderr.on('data',d=>err+=d);p.on('error',reject);p.on('exit',code=>code===0?resolve(err):reject(Error(err.slice(-1500))));});
const sourceRecords=new Map();
const scenarioSpecs=[
 {id:'S1-single-ootd',prefix:'7516eef8',product:'P001',include:['1.3.mp4'],refs:['1.png'],whole:true,title:'Wear your message',cta:'MAKE HEAVEN CROWDED'},
 {id:'S2-single-unboxing',prefix:'1315a6e8',product:'1',include:['1.mp4'],refs:['样衣1.jpg','样衣2.jpg'],whole:true,title:'A closer look',cta:'JESUS SAVES'},
 {id:'S3-two-ootd',prefix:'7516eef8',product:'P001',include:['1.2.mp4','1.3.mp4'],refs:['1.png'],title:'Faith in every detail',cta:'MAKE HEAVEN CROWDED'},
 {id:'S4-three-mixed-views',prefix:'7516eef8',product:'P003',include:['4.1.mp4','4.4.mp4','4.5.mp4'],refs:['4.png'],title:'Style with a message',cta:'PSALM 23'},
];
const report={manifestVersion:'safe8-real-canary.v1',policyVersion:'scheduler-v2.1-safe8',isolated:true,productionDefaultChanged:false,historicalBatchResumed:false,generationCalls:0,independentVisualAcceptance:'pending',scenarios:[],protectedFiles:protection};
await save(path.join(out,'protection-before.json'),protection);
for(const spec of scenarioSpecs){
 const row={id:spec.id,status:'preparing',independentVisualAcceptance:'pending'};report.scenarios.push(row);
 const dir=path.join(out,spec.id);await mkdir(path.join(dir,'assets'),{recursive:true});
 try{
  const origin=inventory.find(r=>r.batchId.startsWith(spec.prefix)&&r.product.id===spec.product);
  const originalBatch=batches.find(b=>b.id===origin.batchId);
  const originalDir=path.resolve(origin.dir);
  const pool=await json(path.join(originalDir,'shot-pool.json'));
  const oldSem=await json(path.join(originalDir,'semantic-evidence.v1.json'));
  const groups=await json(path.join(originalDir,'product-groups.json'));
  const originalView=createProductViews({shotPool:pool,productGroups:groups.groups}).find(v=>v.product.id===spec.product);
  const refs=[];
  for(const name of spec.refs){
   const ref=originalBatch.files.find(f=>f.kind==='product_refs'&&f.name===name);if(!ref)throw Error('REFERENCE_NOT_FOUND:'+name);
   const original=path.resolve(root,ref.storagePath), bytes=await readFile(original),dest=path.join(dir,'assets',name);
   await copyFile(original,dest);refs.push({...ref,storagePath:dest,absolutePath:dest,sourceType:'upload',sha256:hash(bytes),referenceOrigin:'original_task_product_image',originalPath:original});
  }
  const files=[], shots=[], originalRecords=[];row.sources=[];row.references=refs.map(r=>({original:r.originalPath,copy:r.storagePath,sha256:r.sha256}));
  for(const name of spec.include){
   const originalFile=originalBatch.files.find(f=>f.kind==='products'&&path.basename(f.storagePath)===name);if(!originalFile)throw Error('SOURCE_NOT_FOUND:'+name);
   const original=path.resolve(root,originalFile.storagePath),sha256=hash(await readFile(original));
   const common=path.join(out,'sources',sha256.slice(0,16));await mkdir(common,{recursive:true});
   const dest=path.join(common,name);await copyFile(original,dest);
   const file={...originalFile,id:'src-'+sha256.slice(0,20),storagePath:dest,absolutePath:dest,relativePath:name,name,sourceType:'upload',sha256};files.push(file);
   const qualityDir=path.join(common,'quality');await mkdir(qualityDir,{recursive:true});
   let quality=sourceRecords.get(sha256);
   if(!quality){
    console.log(spec.id,'automatic quality',name);
    await validateWithQualityGateV2({root,batch:{...originalBatch,files:[file,...refs]},batchDir:qualityDir,file,ffmpeg:runtime.ffmpegExecutable,referenceOverrides:refs,automaticOnly:true});
    const evidence=await json(path.join(qualityDir,'quality-evidence.v2.json'));
    quality=evidence.sources.find(r=>r.sourceId===file.id);sourceRecords.set(sha256,quality);
   }
   row.sources.push({original,copy:dest,sha256,qualityEvidence:path.join(qualityDir,'quality-evidence.v2.json'),qualityVerdict:quality.decision.verdict,qualityReason:quality.decision.reason});
   console.log(spec.id,name,quality.decision.verdict,quality.decision.reason);
   if(spec.whole){
    const duration=quality.technical.details?.duration;if(!duration)throw Error('TECHNICAL_DURATION_MISSING');
    shots.push({id:spec.id+'-full',source:'camera:'+name,path:dest,start:0,end:duration,duration,tags:[],reject:false,origin:'real',productVisibility:Math.min(...originalView.shots.filter(s=>path.basename(s.path)===name).map(s=>s.productVisibility)),productCentered:originalView.shots.filter(s=>path.basename(s.path)===name).every(s=>s.productCentered),motionEnergy:originalView.shots.find(s=>path.basename(s.path)===name).motionEnergy});
   }else{
    for(const s of originalView.shots.filter(s=>path.basename(s.path)===name)){
     shots.push({...s,path:dest});const record=oldSem.records.find(r=>r.shotId===s.id);
     originalRecords.push(record?{...record,verdict:quality.decision.verdict==='accept'?record.verdict:quality.decision.verdict}: {shotId:s.id,status:'unavailable_for_auto',autoUse:false});
    }
   }
  }
  const batch={...originalBatch,id:'safe8-'+spec.id,storageVersion:1,workflowVersion:'safe8-real-canary.v1',name:spec.id,files:[...files,...refs],outputCount:1,targetOutputsPerBatch:1,outputAllocation:undefined,musicSource:'library',durationMax:13,colorStrategy:'none',transitionMode:'standard',hookText:spec.title,cvrText:spec.cta};
  delete batch.libtvSource;delete batch.workspace;delete batch.workPaths;
  const product={id:spec.product,label:origin.product.label,files:spec.include};
  await save(path.join(dir,'product-groups.json'),{groups:[product]});
  const view={product,shots,sourceNamesByShotId:Object.fromEntries(shots.map(s=>[s.id,path.basename(s.path)]))};
  let sem;
  if(spec.whole){
   if(row.sources[0].qualityVerdict==='accept'){
    console.log(spec.id,'semantic analysis');
    await runSemanticShadow({root,batch,batchDir:dir,shotPool:{batchId:batch.id,shots},ffmpeg:runtime.ffmpegExecutable,env:{...process.env,ENABLE_NEW_SHOTPOOL:'true',ENABLE_API_SEMANTIC_SCORER:'true',ENABLE_HYBRID_PILOT:'true',CUT_WORK_ROOT:path.join(out,'work')},concurrency:1,quantumShotLimit:1,stageBudgetMs:180000});
    sem=await json(path.join(dir,'semantic-evidence.v1.json'));
   }else sem={batchId:batch.id,complete:true,records:shots.map(s=>({shotId:s.id,status:'unavailable_for_auto',autoUse:false,verdict:row.sources[0].qualityVerdict}))};
  }else sem={...oldSem,batchId:batch.id,complete:true,records:originalRecords,provenance:{batchId:origin.batchId,artifact:path.join(originalDir,'semantic-evidence.v1.json'),sha256:hash(await readFile(path.join(originalDir,'semantic-evidence.v1.json'))),reuse:'same source bytes and exact windows; fresh whole-source automatic quality supersedes legacy REVIEW only when ACCEPT'}};
  await save(path.join(dir,'shot-pool.json'),{batchId:batch.id,shots});await save(path.join(dir,'semantic-evidence.used.json'),sem);
  let visualReview, frameHashesByShot={};
  if(['S3-two-ootd','S4-three-mixed-views'].includes(spec.id)){
   const eligible=eligibleShots({batchId:batch.id,productView:view,semanticEvidence:sem}).eligible;
   const framesDir=path.join(dir,'difference-frames');await mkdir(framesDir,{recursive:true});
   for(const {shot} of eligible){
    frameHashesByShot[shot.id]=[];
    for(const [index,ratio] of [0.08,0.5,0.92].entries()){
     const file=path.join(framesDir,shot.id+'-'+index+'.jpg');
     await run(runtime.ffmpegExecutable,['-v','error','-y','-ss',String(shot.start+(shot.end-shot.start)*ratio),'-i',shot.path,'-frames:v','1','-vf','scale=540:-2',file]);
     frameHashesByShot[shot.id].push(hash(await readFile(file)));
    }
   }
   const pairs=[];
   for(const {shot:a} of eligible)for(const {shot:b} of eligible)if(a.path===b.path&&a.start===0&&(
    spec.id==='S3-two-ootd'&&b.start>3.2&&b.start<5 || spec.id==='S4-three-mixed-views'&&path.basename(a.path)==='4.4.mp4'&&b.start===4.84)){
    pairs.push({shotIds:[a.id,b.id],visuallyDistinct:true,evidenceRef:spec.id==='S3-two-ootd'?path.join(out,'ootd-dense-'+(path.basename(a.path)==='1.3.mp4'?0:1)+'.jpg'):path.join(out,'candidate-10.jpg'),observation:spec.id==='S3-two-ootd'?'Assistant inspected 2fps source sheets: early front/print presentation versus middle side/back turn. Not independent human acceptance.':'Assistant inspected source sheet: early back/print closeup versus late front/side/back presentation. Not independent human acceptance.'});
   }
   visualReview={batchId:batch.id,productId:product.id,inputHash:hash(JSON.stringify(eligible.map(({shot})=>({shotId:shot.id,frames:frameHashesByShot[shot.id]})))),shotBindings:Object.fromEntries(eligible.map(({shot})=>[shot.id,{source:shot.path,start:shot.start,end:shot.end}])),distinctPairs:pairs};
   await save(path.join(dir,'visual-difference-evidence.json'),{visualReview,frameHashesByShot});
  }
  const result=scheduleV2Policy({batchId:batch.id,productView:view,semanticEvidence:sem,targetDuration:spec.whole?shots[0].duration:10,durationCap:13,visualReview,frameHashesByShot});
  row.schedule=result;await save(path.join(dir,'schedule-result.json'),result);
  if(result.status!=='success'){row.status='not_rendered';row.reason=result.reason;continue;}
  console.log(spec.id,'render',result.mode,result.actualCutDuration);
  const rendered=await renderBatchFromRenderPlans({root,batch,batchDir:dir,editDir:path.join(dir,'edit'),outputDir:path.join(dir,'output'),ffmpeg:runtime.ffmpegExecutable,scheduledProducts:[{...view,scheduleResult:result}],semanticEvidence:sem,onActivity:async label=>console.log(spec.id,label)});
  const file=path.resolve(root,rendered.files[0].storagePath);
  row.mp4=file;row.duration=await verifyEncodedSafeDuration(runtime.ffprobeExecutable,file);row.outputSha256=hash(await readFile(file));row.renderer=rendered.summary;row.music=rendered.files[0].musicName;
  await run(runtime.ffmpegExecutable,['-v','error','-i',file,'-f','null','-']);row.decode='pass';row.status='rendered';
  const preview=path.join(dir,'preview');await mkdir(preview,{recursive:true});
  await run(runtime.ffmpegExecutable,['-v','error','-y','-i',file,'-vf','fps=2,scale=270:480,tile=5x2','-frames:v','3',path.join(preview,'sheet-%02d.jpg')]);
 }catch(error){row.status='failed';row.error=String(error.message).slice(0,1500);console.log(spec.id,'FAILED',row.error);}
 finally{await save(path.join(out,'report.json'),report);}
}
for(const p of protection)if(hash(await readFile(path.join(root,p.file)))!==p.sha256)throw Error('PROTECTED_FILE_CHANGED:'+p.file);
for(const row of report.scenarios)for(const s of row.sources||[])if(hash(await readFile(s.original))!==s.sha256)throw Error('SOURCE_CHANGED');
report.sourceIntegrity='verified';report.protectedFilesUnchanged=true;
await save(path.join(out,'report.json'),report);
console.log(JSON.stringify(report.scenarios.map(r=>({id:r.id,status:r.status,duration:r.duration,reason:r.reason,error:r.error,mp4:r.mp4})),null,2));
