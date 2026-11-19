import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import assert from 'node:assert/strict';
const root='D:/CUT-Releases/20261030-production-first-r11';
const evidence=path.resolve('.project-governance/evidence/final-shot-acceptance-20261117');
await fs.mkdir(evidence,{recursive:true});
const read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
const hash=async p=>createHash('sha256').update(await fs.readFile(p)).digest('hex');
const save=async(name,value)=>fs.writeFile(path.join(evidence,name),JSON.stringify(value,null,2)+'\n');
const execute=promisify(execFile),run=(exe,args,extra={})=>execute(exe,args,{windowsHide:true,timeout:60000,maxBuffer:16*1024*1024,...extra});
const runtime=await read(root+'/config/cutflow-runtime.json');
const installed=await import(pathToFileURL(root+'/worker/ootd-template-render.mjs'));
const r1dir=path.resolve('.project-governance/evidence/final-shot-boundary-20261117');
const r2dir=path.resolve('.project-governance/evidence/final-shot-boundary-20261117-r2');
const r1=await import(pathToFileURL(r1dir+'/candidate/worker/ootd-template-render.mjs'));
const r2=await read(r2dir+'/prepared.json');
assert.equal(await hash(root+'/worker/ootd-template-render.mjs'),r2.after);
assert.equal(await hash(r1dir+'/candidate/worker/ootd-template-render.mjs'),r2.before);
const cases=[];
for(const [taskId,oldEdit,boundaries]of [
 ['f920ee53-ef37-4cc2-afb8-2622a34cb628',r1dir+'/offline-regression',[0,74,131,185,230,315]],
 ['6eb65183-823a-4530-b944-4724386ca321',r2dir+'/offline-regression',[0,71,128,184,228,315]]
]){
 const work='E:/cutflow批量/classic-multisource/'+taskId;
 const editDir=path.join(evidence,taskId);await fs.cp(oldEdit,editDir,{recursive:true});
 const manifest=await read(work+'/output/render-manifest.json');
 const originalHash=await hash(work+'/output/tokyotiger.mp4');
 const options={root,editDir,ffmpeg:runtime.ffmpegExecutable,batch:{colorStrategy:'none'}};
 if(taskId.startsWith('6eb')){
  let error;try{await r1.verifyTemplateOutputs(options,manifest);}catch(e){error=e;}
  assert.equal(error?.message,'FINAL_MP4_SHORT_SHOT_REFUSE');await save('r1-exact-reproduction.json',{moduleHash:r2.before,taskId,error:error.message,stack:error.stack});
 }
 await installed.verifyTemplateOutputs(options,manifest);
 const report=(await read(editDir+'/ootd-final-shot-check.json')).reports[0];assert.deepEqual(report.boundaries,boundaries);
 assert.equal(await hash(work+'/output/tokyotiger.mp4'),originalHash);
 await run(runtime.ffmpegExecutable,['-nostdin','-v','error','-xerror','-i',work+'/output/tokyotiger.mp4','-f','null','-']);
 cases.push({name:taskId,actualFailedMp4:true,sha256:originalHash,pass:true,boundaries:report.boundaries,terminalPadding:report.terminalPadding});
 if(taskId.startsWith('6eb')){
  const clipsDir=work+'/edit/clips_graded/tokyotiger';
  const decode=async file=>(await run(runtime.ffmpegExecutable,['-nostdin','-v','error','-i',file,'-vf','scale=96:96,format=gray','-fps_mode','passthrough','-an','-f','rawvideo','pipe:1'],{encoding:'buffer'})).stdout;
  const concat=await fs.readFile(clipsDir+'/concat.txt','utf8'),parts=[];
  for(const match of concat.matchAll(/^file '(.*)'$/gm))parts.push(await decode(match[1]));
  const expectedBase=Buffer.concat(parts);let base;
  for(const name of (await fs.readdir(clipsDir)).filter(n=>n.startsWith('base-')&&n.endsWith('.mp4'))){const file=clipsDir+'/'+name;if((await decode(file)).equals(expectedBase)){base=file;break;}}
  assert.ok(base,'No base decoded identically to exact concat inputs');
  const clock=await installed.probeFrameClock(runtime.ffprobeExecutable,base);assert.equal(clock.frameCount,314);
  const raw=(await run(runtime.ffmpegExecutable,['-nostdin','-v','error','-i',work+'/output/tokyotiger.mp4','-vf','scale=96:96,format=gray','-fps_mode','passthrough','-an','-f','rawvideo','pipe:1'],{encoding:'buffer'})).stdout;
  const differences=[];for(const frame of [184,185,314]){let sum=0,max=0;for(let k=0;k<9216;k++){const delta=Math.abs(raw[(frame-1)*9216+k]-raw[frame*9216+k]);sum+=delta;max=Math.max(max,delta);}differences.push({frame,meanGrayDifference:sum/9216,maxGrayDifference:max});}
  await save('timeline-origin.json',{basePath:base,baseSha256:await hash(base),baseDecodedIdenticalToConcatInputs:true,baseFrames:314,finalFrames:315,segmentFrames:[71,57,56,44,86],plannedBoundarySeconds:6.15,roundedPlanFrame:185,actualBoundaryFrame:184,detections:report.cuts,frameDifferences:differences,originEvidence:'Base decodes identically to concatenated exact EDL-signature-bound clips, with314 frames; unchanged batch-renderer.mjs final composition uses -t10.472 -r30. Final output has315 frames and a near-identical final repeat. No original FFmpeg argv audit log was preserved; origin is established from code, cache and decoded frames.'});
 }
}
// Existing actually encoded safety counterexamples, decoded by current installed code.
for(const name of ['one-frame-flash','two-distinct-transitions','terminal-one-frame-flash']){
 const file=r2dir+'/installed-regression/'+name+'.mp4';const clock=await installed.probeFrameClock(runtime.ffprobeExecutable,file);
 const cuts=await installed.scanFinalTemplateCuts({ffmpeg:runtime.ffmpegExecutable,file,clock});
 const layout=installed.finalShotBoundaries({clock,segments:[{output_in:0}],cuts,encodedCounts:[clock.frameCount]});
 const {assertFinalShots}=await import(pathToFileURL(root+'/worker/ootd-min-shot.mjs'));
 assert.throws(()=>assertFinalShots(layout.shots),/FINAL_MP4_SHORT_SHOT_REFUSE/);
 cases.push({name,actualEncodedMp4:true,rejected:true,boundaries:layout.boundaries});
}
// Exercise the full installed verifier on generated normal/short fixtures,
// including two legitimate native MP4 time bases under the existing30fps contract.
async function fixture(name,counts,timescale){
 const editDir=path.join(evidence,name),clipsDir=path.join(editDir,'clips_graded/fixture');await fs.mkdir(clipsDir,{recursive:true});
 const source=path.join(editDir,'fixture-source.mp4');
 await run(runtime.ffmpegExecutable,['-nostdin','-v','error','-y','-f','lavfi','-i','testsrc2=s=96x96:r=30:d=8','-c:v','libx264','-pix_fmt','yuv420p',source]);
 const segments=[],paths=[];let frame=0;
 for(const [i,count]of counts.entries()){
  const sourceIn=frame/30,duration=count/30;
  const segment={segment_id:'s'+i,source_original:source,source_in:sourceIn,source_out:sourceIn+duration,duration,output_in:frame/30,output_out:(frame+count)/30};
  const signature=createHash('sha256').update(JSON.stringify({source,sourceIn,duration,width:96,height:96,fps:30,colorStrategy:'none'})).digest('hex').slice(0,16);
  const clip=path.join(clipsDir,`${String(i+1).padStart(2,'0')}-none-${signature}.mp4`);
  await run(runtime.ffmpegExecutable,['-nostdin','-v','error','-y','-ss',String(sourceIn),'-i',source,'-an','-frames:v',String(count),'-r','30','-c:v','libx264',clip]);
  paths.push(clip);segments.push(segment);frame+=count;
 }
 const list=path.join(editDir,'concat.txt');await fs.writeFile(list,paths.map(p=>`file '${p.replaceAll('\\','/')}'`).join('\n'));
 const output=path.join(editDir,'final.mp4');await run(runtime.ffmpegExecutable,['-nostdin','-v','error','-y','-f','concat','-safe','0','-i',list,'-c','copy','-video_track_timescale',String(timescale),output]);
 const edl={master:{width:96,height:96,fps:30},transition_profile:'hard_cut',products:[{product_id:'fixture',duration_seconds:frame/30,applied_transition_profile:'hard_cut',segments}]};
 await fs.writeFile(path.join(editDir,'render-plan-edl.json'),JSON.stringify(edl));
 const rendered={files:[{storagePath:output,productId:'fixture',relativePath:'final.mp4'}]};
 const options={root,editDir,ffmpeg:runtime.ffmpegExecutable,batch:{colorStrategy:'none'}};
 if(counts.some(n=>n<30)){await assert.rejects(installed.verifyTemplateOutputs(options,rendered),/FINAL_MP4_SHORT_SHOT_REFUSE/);return {name,actualEncodedMp4:true,rejected:true};}
 await installed.verifyTemplateOutputs(options,rendered);const report=(await read(editDir+'/ootd-final-shot-check.json')).reports[0];assert.equal(report.encodedLayoutProven,true);
 return {name,actualEncodedMp4:true,pass:true,timeBase:report.timeBase,fps:report.fps,boundaries:report.boundaries};
}
cases.push(await fixture('normal-30fps-timescale15360',[60,60,60],15360));
cases.push(await fixture('normal-30fps-timescale90000',[60,60,60],90000));
cases.push(await fixture('real-half-second-shot',[60,15,60],15360));
// 24fps is outside this deployed OOTD contract: do not silently broaden it.
const unsupported=path.join(evidence,'unsupported24fps.mp4');await run(runtime.ffmpegExecutable,['-nostdin','-v','error','-y','-f','lavfi','-i','testsrc2=s=96x96:r=24:d=2','-c:v','libx264',unsupported]);
await assert.rejects(installed.probeFrameClock(runtime.ffprobeExecutable,unsupported),/OOTD_FRAME_BASIS_UNCONFIRMED/);
cases.push({name:'unsupported24fps',refusedAsUnsupported:true});
const rows=await read(root+'/data/classic-multisource-records.json'),config=await read(root+'/data/classic-integration-runtime.json'),deliveries=[];
for(const taskId of ['f920ee53-ef37-4cc2-afb8-2622a34cb628','6eb65183-823a-4530-b944-4724386ca321']){
 const record=rows.find(r=>r.taskId===taskId),nas=await read(path.join(config.nasRoot,'outbox',taskId,'status.json'));assert.equal(record.status,'completed');assert.equal(nas.status,'completed');assert.equal(record.revision,nas.revision);assert.equal(record.outputs.length,1);assert.equal(nas.outputs.length,1);
 assert.equal(await hash(path.join(config.nasRoot,nas.outputs[0].relativePath)),record.outputs[0].sha256);
 deliveries.push({taskId,cutStatus:record.status,nasStatus:nas.status,revision:record.revision,outputId:record.outputs[0].id,sha256:record.outputs[0].sha256,nasHashVerified:true});
}
const log=(await fs.readFile('E:/cutflow批量/worker-scratch/logs/multisource.auxiliary-supervisor.log','utf8')).split(/\r?\n/).filter(s=>s.startsWith('2026-11-17T03:43:')||s.startsWith('2026-11-17T04:22:'));
const failed=await read(root+'/data/classic-multisource-errors/6eb65183-823a-4530-b944-4724386ca321.json');
const firstRuntime=await read(r1dir+'/runtime-verification.json'),secondDeployment=await read(r2dir+'/deployment.json');assert.equal(firstRuntime.classic.pid,secondDeployment.old.pid);assert.equal(firstRuntime.classic.start,secondDeployment.old.start);
const heartbeat=await read(root+'/data/classic-multisource-heartbeat.json');assert.ok(Date.now()-Date.parse(heartbeat.at)<30000);
const processes=JSON.parse((await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',"@(Get-CimInstance Win32_Process -Filter \"name='node.exe'\" | Where-Object {$_.CommandLine -match 'classic-multisource-runner.mjs'} | ForEach-Object {[PSCustomObject]@{pid=$_.ProcessId;parent=$_.ParentProcessId;start=$_.CreationDate.ToUniversalTime().ToString('o');command=$_.CommandLine}})|ConvertTo-Json -Compress"])).stdout);const p=Array.isArray(processes)?processes:[processes];assert.equal(p.length,1);assert.equal(p[0].pid,heartbeat.pid);
for(const [file,h]of Object.entries(r2.protected))assert.equal(await hash(path.join(root,file)),h,file);
const attribution={failureAt:failed.at,modulePathFromHistoricalStack:root+'/worker/ootd-template-render.mjs:101',moduleR1Sha256:r2.before,moduleR2Sha256:r2.after,workerDuringFailure:firstRuntime.classic,supervisorLog:log,classification:'r1 code logic gap after r1 reload; failure before r2 deployment',evidenceLimit:'No per-task resident-code hash or PID was persisted. Attribution uses saved install hashes, startup/import architecture, matching pre/post process identity, supervisor lifecycle log, historical stack line and exact r1 reproduction; it is not a direct memory attestation.',currentWorker:p[0],heartbeat,oldWorkerResidue:false};
await save('runtime-attribution.json',attribution);
const result={at:new Date().toISOString(),root,installedSha256:await hash(root+'/worker/ootd-template-render.mjs'),cases,deliveries,protectedHashesVerified:136,codeReady:true,deployed:true,verified:'runtime_and_fixed_encoded_regression_suite_and_nas_delivery',productionCodeChangesThisAudit:0,productionRestartsThisAudit:0,productionBusinessWritesThisAudit:0,providerCalls:0,allweReception:'unconfirmed; no corresponding receipt found in shared receipts directory',allwePlayback:'unconfirmed; no authenticated ALLWE playback session available'};
await save('acceptance.json',result);console.log(JSON.stringify({cases:cases.length,deliveries,installedSha256:result.installedSha256,currentPid:heartbeat.pid,protectedHashesVerified:136}));
