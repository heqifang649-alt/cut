import {readFile,writeFile,copyFile,mkdir,access} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
const out=path.resolve(process.argv[2] || 'E:/cutflow-duration-8-18-20261102');
const candidate=path.join(out,'candidate'),root=path.resolve(process.env.DURATION_RENDER_ROOT || path.join(out,'ffmpeg'));
const {renderBatchFromEdl,renderPlansToEdl}=await import(pathToFileURL(path.join(candidate,'worker/batch-renderer.mjs')));
const {verifyEncodedSafeDuration}=await import(pathToFileURL(path.join(candidate,'lib/output-duration.mjs')));
const {publishMultisourceOutput}=await import(pathToFileURL(path.join(candidate,'lib/classic-multisource.mjs')));
const {scheduleClassicMultisource}=await import(pathToFileURL(path.join(candidate,'worker/classic-multisource-executor.mjs')));
const {scheduleGuided}=await import(pathToFileURL(path.join(candidate,'worker/libtv-guided-auto.mjs')));
const {GUIDED_POLICY}=await import(pathToFileURL(path.join(candidate,'lib/libtv-guided-policy.mjs')));
const {probeTechnical}=await import(pathToFileURL(path.join(candidate,'worker/ai-video-validator.mjs')));
const run=promisify(execFile),json=async f=>JSON.parse(await readFile(f,'utf8'));
const save=async(f,v)=>{await mkdir(path.dirname(f),{recursive:true});await writeFile(f,JSON.stringify(v,null,2));};
const sha=b=>createHash('sha256').update(b).digest('hex');
const runtime=await json(path.join(process.cwd(),'config/cutflow-runtime.json'));
Object.assign(runtime,{workRoot:path.join(root,'work'),deliveryRoot:path.join(root,'delivery'),runtimeCacheRoot:path.join(root,'cache'),runtimeTempRoot:path.join(root,'temp')});
await save(path.join(root,'config/cutflow-runtime.json'),runtime);
await mkdir(path.join(root,'worker'),{recursive:true});await copyFile(path.join(candidate,'worker/render-overlays.py'),path.join(root,'worker/render-overlays.py'));
process.env.ENABLE_BRAND_BGM='false';process.env.ENABLE_BRAND_COPY_LIBRARY='false';
const ffmpeg=async args=>run(runtime.ffmpegExecutable,['-v','error','-nostdin',...args],{windowsHide:true,timeout:120000,maxBuffer:4e6});
const music=path.join(root,'fixture-music.wav');await ffmpeg(['-y','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=20','-c:a','pcm_s16le',music]);
const report={at:new Date().toISOString(),deployed:false,historicalTaskRetried:false,providerCalls:0,renders:[],publication:[]};
async function renderCase(name,edl,extraBatch={}){
 const dir=path.join(root,name),edit=path.join(dir,'edit'),edlPath=path.join(edit,'render-plan-edl.json');await save(edlPath,edl);
 const batch={id:randomUUID(),name,files:[{kind:'bgm',sourceType:'template',storagePath:music}],musicSource:'template',durationMax:10.47,colorStrategy:'none',transitionMode:'standard',targetOutputsPerBatch:edl.products.length,...extraBatch};
 const result=await renderBatchFromEdl({root,batch,batchDir:dir,editDir:edit,edlPath,ffmpeg:runtime.ffmpegExecutable,validateLegacyProductConsistency:false,onActivity:async label=>console.log(name,label)});
 for(const record of result.files){const file=path.resolve(root,record.storagePath);await ffmpeg(['-xerror','-i',file,'-f','null','-']);
  const duration=await verifyEncodedSafeDuration(runtime.ffprobeExecutable,file);const probe=JSON.parse((await run(runtime.ffprobeExecutable,['-v','error','-show_entries','stream=codec_type,duration:format=duration','-of','json',file],{windowsHide:true})).stdout);
  if(!(duration>=8&&duration<=18))throw Error('Unexpected final duration');
  report.renders.push({name,file,duration,probe,sha256:sha(await readFile(file)),speed:1,decode:'pass',plan:edl.products,sourceValidation:'Controlled quality-accepted fixtures; no new Provider/Quality Gate invocation'});
 }
 await save(path.join(out,'ffmpeg-report.json'),report);
}
// Historical inputs are copied into a new isolated regression workspace. No
// production task ID, queue, status, record, or output is reused or changed.
const failedDir='E:/cutflow批量/classic-multisource/7f2dfc47-e24d-46b6-81c6-6cc1a6d15291';
const gc=await json(path.join(failedDir,'edit/render-plan-edl.json')),copies=new Map();
for(const s of gc.products.flatMap(p=>p.segments)){
 if(!copies.has(s.source_original)){const local=path.join(root,'sources',path.basename(s.source_original));await mkdir(path.dirname(local),{recursive:true});await copyFile(s.source_original,local);if(sha(await readFile(local))!==sha(await readFile(s.source_original)))throw Error('Source integrity mismatch');copies.set(s.source_original,local);}
 s.source_original=copies.get(s.source_original);s.source_name=path.basename(s.source_original);
}
await renderCase('gc-dual-12_8',gc);
const longSource=path.join(root,'sources','continuous-40s.mp4');
await ffmpeg(['-y','-f','lavfi','-i','testsrc2=s=360x640:r=30:duration=40','-c:v','libx264','-preset','ultrafast','-crf','22','-pix_fmt','yuv420p',longSource]);
const sourceTechnical=await probeTechnical(longSource,{ffmpeg:runtime.ffmpegExecutable});report.longOriginal={file:longSource,duration:sourceTechnical.duration};
if(sourceTechnical.duration<39)throw Error('Long original fixture missing');
const shots=Array.from({length:40},(_,i)=>({id:'s'+i,source:'source',path:longSource,start:i,end:i+1,duration:1,tags:['scene:'+i],reject:false,origin:'real',productVisibility:.9,productCentered:true,motionEnergy:'medium'}));
const batchId=randomUUID(),guidedBatch={id:batchId,files:[{id:'source',kind:'products',relativePath:'continuous-40s.mp4'}],libtvSource:{handoffId:'fixture',manifestSha256:'fixture',editPolicyReceipt:{state:'accepted',strategy:'guided_auto',policyVersion:GUIDED_POLICY.version,manifestSha256:'fixture',policy:GUIDED_POLICY}},productDetection:{sourcePolicy:{version:GUIDED_POLICY.version,manifestSha256:'fixture',handoffId:'fixture'},groups:[{id:'guided',label:'guided 40s to 18s',files:['continuous-40s.mp4']} ]}};
const guided=scheduleGuided({batch:guidedBatch,shots,prepared:{sidecars:[{fileId:'source',videoPath:longSource,segments:shots.map(s=>({...s,fingerprint:s.id}))}]}});
await renderCase('guided-40-to-18',renderPlansToEdl({scheduledProducts:guided.products}));
// Force the classic scheduler's safe continuous fallback, then verify its cap.
const classicShots=[{...shots[0],duration:20,end:20},{...shots[20],duration:20,end:40}];
const scheduled=scheduleClassicMultisource({record:{taskId:randomUUID(),acceptedAt:'fixed',sources:[{id:'source',bindingKey:'classic',absolutePath:longSource}]},shotPool:{shots:classicShots},scriptTemplate:{id:'short-rhythm',name:'short-rhythm',totalDuration:10.47,slots:[{id:'hook',label:'hook',targetDuration:10.47,requireTags:['absent']}]}});
await renderCase('classic-40-to-18',renderPlansToEdl({scheduledProducts:scheduled}));
// Probe actual millisecond-boundary MP4s and call the real atomic publication
// boundary. These are independent from the renderer's preflight checks.
for(const [seconds,expectedCode] of [[7.999,'INSUFFICIENT_SAFE_DURATION'],[8,null],[18,null],[18.001,'OUTPUT_DURATION_EXCEEDED']]){
 const file=path.join(root,'boundary-'+seconds+'.mp4');
 await ffmpeg(['-y','-f','lavfi','-i','color=c=navy:s=64x64:r=1000','-frames:v',String(Math.round(seconds*1000)),'-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-video_track_timescale','1000000',file]);
 const destination=path.join(root,'published',path.basename(file)),bytes=await readFile(file);let actualCode=null;
 try{await publishMultisourceOutput(file,destination,{sha256:sha(bytes),size:bytes.length},runtime.ffmpegExecutable,runtime.ffprobeExecutable);}catch(e){actualCode=e.code||e.message;}
 if(actualCode!==expectedCode)throw Error('Publication boundary '+seconds+' expected '+expectedCode+' got '+actualCode);
 const exists=await access(destination).then(()=>true,()=>false);if(exists!==!expectedCode)throw Error('Invalid output published');
 await ffmpeg(['-xerror','-i',file,'-f','null','-']);
 report.publication.push({seconds,file,code:actualCode,published:exists,decode:'pass'});await save(path.join(out,'ffmpeg-report.json'),report);
}
console.log('DURATION FFMPEG PASS',path.join(out,'ffmpeg-report.json'));
