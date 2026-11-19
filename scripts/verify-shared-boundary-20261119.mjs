import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile),prod='D:/CUT-Releases/20261030-production-first-r11';
const base=path.resolve('.project-governance/evidence/shared-boundary-20261119');
const installedMode=process.argv.includes('--installed');
const runDir=await fs.mkdtemp(base+(installedMode?'/installed-':'/run-')),candidate=installedMode?prod:base+'/candidate';
const mod=await import(pathToFileURL(candidate+'/worker/ootd-template-render.mjs'));
const shared=await import(pathToFileURL(candidate+'/lib/final-mp4-boundary.mjs'));
const installed=await import(pathToFileURL(prod+'/worker/ootd-template-render.mjs'));
const {renderGuidedV22}=await import(pathToFileURL(candidate+'/worker/guided-render-v22.mjs'));
const {renderWithGuidedFallback}=await import(pathToFileURL(candidate+'/worker/guided-production-policy.mjs'));
const {updateMultisourceStatus,multisourceStatus,assertMultisourceStatusV2}=await import(pathToFileURL(candidate+'/lib/classic-multisource.mjs'));
const read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
const hash=async p=>createHash('sha256').update(await fs.readFile(p)).digest('hex');
const rt=await read(prod+'/config/cutflow-runtime.json'),cases=[];
async function copyEdit(source,name){
 const editDir=runDir+'/'+name;await fs.mkdir(editDir,{recursive:true});
 await fs.copyFile(source+'/render-plan-edl.json',editDir+'/render-plan-edl.json');
 await fs.cp(source+'/clips_graded',editDir+'/clips_graded',{recursive:true});return editDir;
}
const options=editDir=>({root:prod,editDir,ffmpeg:rt.ffmpegExecutable,batch:{colorStrategy:'none'}});
for(const [id,old]of [
 ['e4d39e41-f684-4e64-8dad-0cbaa867d3ca','allwe-short-shot-20261119/e4d39e41-f684-4e64-8dad-0cbaa867d3ca'],
 ['2863bcc1-ff81-4ed3-ae2f-4ea1c88a09fe','allwe-short-shot-20261119/2863bcc1-ff81-4ed3-ae2f-4ea1c88a09fe'],
 ['f920ee53-ef37-4cc2-afb8-2622a34cb628','final-shot-boundary-20261117/offline-regression'],
 ['6eb65183-823a-4530-b944-4724386ca321','final-shot-boundary-20261117-r2/offline-regression'],
]){
 const editDir=await copyEdit('.project-governance/evidence/'+old,id),work='E:/cutflow批量/classic-multisource/'+id;
 const manifest=await read(work+'/output/render-manifest.json'),output=manifest.files[0].storagePath,before=await hash(output);
 let additionalCalls=0;
 const verifyConflict=async input=>{additionalCalls++;return shared.verifyBoundaryConflict(input);};
 if(!installedMode&&(id.startsWith('e4')||id.startsWith('286'))){
  const original=runDir+'/original-'+id;await fs.mkdir(original,{recursive:true});
  await fs.copyFile(editDir+'/render-plan-edl.json',original+'/render-plan-edl.json');
  await fs.cp(editDir+'/clips_graded',original+'/clips_graded',{recursive:true});
  await assert.rejects(installed.verifyTemplateOutputs(options(original),manifest),/FINAL_MP4_SHORT_SHOT_REFUSE/);
 }
 await mod.verifyTemplateOutputs(options(editDir),manifest,{verifyConflict});
 const first=(await read(editDir+'/ootd-final-shot-check.json')).reports[0];
 assert.equal(first.pass,true);assert.equal(before,await hash(output));
 if(id.startsWith('e4')||id.startsWith('286')){
  assert.equal(additionalCalls,1);assert.equal(first.boundaryVerification.state,'verified');
  assert.deepEqual(first.boundaries,[0,73,130,185,230,313]);
  await mod.verifyTemplateOutputs(options(editDir),manifest,{verifyConflict});
  assert.equal((await read(editDir+'/ootd-final-shot-check.json')).reports[0].boundaryVerification.reused,true);
 }else assert.equal(additionalCalls,0);
 await exec(rt.ffmpegExecutable,['-nostdin','-v','error','-xerror','-i',output,'-f','null','-'],{windowsHide:true});
 cases.push({name:id,actualHistoricalMp4:true,pass:true,sha256:before,boundaries:first.boundaries,additionalVerification:first.boundaryVerification||null});
}
// A normal final verifier call must never invoke the extra verifier.
const normalSource='.project-governance/evidence/final-shot-acceptance-20261117/normal-30fps-timescale15360';
const normal=await copyEdit(normalSource,'normal-path'),normalFile=path.resolve(normalSource+'/final.mp4');
const normalManifest={files:[{storagePath:normalFile,productId:'fixture',relativePath:'final.mp4'}]};
const oldNormal=await copyEdit(normalSource,'normal-installed');
if(!installedMode)await installed.verifyTemplateOutputs(options(oldNormal),normalManifest);
else{
 const isolation=await read(base+'/latest-verification.json');
 await fs.copyFile(isolation.runDir+'/normal-installed/ootd-final-shot-check.json',oldNormal+'/ootd-final-shot-check.json');
}
await mod.verifyTemplateOutputs(options(normal),normalManifest,{verifyConflict:()=>{throw Error('normal path triggered extra verification');}});
assert.deepEqual(await read(normal+'/ootd-final-shot-check.json'),await read(oldNormal+'/ootd-final-shot-check.json'));
cases.push({name:'normal-entry-output-and-report-unchanged',pass:true,additionalVerification:0});

// Exercise the public render wrapper twice: second call must skip renderer and
// reuse the original artifact's persisted verification, not produce another MP4.
const realId='e4d39e41-f684-4e64-8dad-0cbaa867d3ca';
const resumeDir=await copyEdit('.project-governance/evidence/allwe-short-shot-20261119/'+realId,'resume-entry');
const realManifest=await read('E:/cutflow批量/classic-multisource/'+realId+'/output/render-manifest.json');
const resumeOptions={...options(resumeDir),scheduledProducts:[]};let renderCalls=0;
const renderer=async()=>{renderCalls++;return realManifest;};
await mod.renderOotdTemplate(resumeOptions,renderer);await mod.renderOotdTemplate(resumeOptions,renderer);
assert.equal(renderCalls,1);assert.equal((await read(resumeDir+'/ootd-final-shot-check.json')).reports[0].boundaryVerification.reused,true);
await assert.rejects(mod.renderOotdTemplate({...resumeOptions,batch:{colorStrategy:'different'}},renderer),/FINAL_MP4_BOUNDARY_UNCONFIRMED/);assert.equal(renderCalls,1);
cases.push({name:'ootd-wrapper-checkpoint-resume',pass:true,renderCalls,providerCalls:0});

for(const [name,expected]of [['internal-drop','FINAL_MP4_BOUNDARY_UNCONFIRMED'],['internal-flash','FINAL_MP4_SHORT_SHOT_REFUSE']]){
 const editDir=await copyEdit('.project-governance/evidence/allwe-short-shot-20261119/'+realId,name);
 const file=path.resolve('.project-governance/evidence/allwe-short-shot-20261119/'+name+'.mp4');
 await assert.rejects(mod.verifyTemplateOutputs(options(editDir),{files:[{storagePath:file,productId:'nerdywave',relativePath:name+'.mp4'}]}),e=>e.code===expected&&e.preserveExistingOutput===true);
 cases.push({name,actualEncodedMp4:true,rejected:true,errorCode:expected});
}
for(const name of ['one-frame-flash','two-distinct-transitions','terminal-one-frame-flash']){
 const {assertFinalShots}=await import(pathToFileURL(candidate+'/worker/ootd-min-shot.mjs'));
 const file=path.resolve('.project-governance/evidence/final-shot-boundary-20261117-r2/installed-regression/'+name+'.mp4');
 const clock=await mod.probeFrameClock(rt.ffprobeExecutable,file),cuts=await mod.scanFinalTemplateCuts({ffmpeg:rt.ffmpegExecutable,file,clock});
 assert.throws(()=>assertFinalShots(mod.finalShotBoundaries({clock,segments:[{output_in:0}],cuts,encodedCounts:[clock.frameCount]}).shots),/FINAL_MP4_SHORT_SHOT_REFUSE/);
 cases.push({name,actualEncodedMp4:true,rejected:true});
}
const shortSource='.project-governance/evidence/final-shot-acceptance-20261117/real-half-second-shot';
const short=await copyEdit(shortSource,'half-second');await assert.rejects(mod.verifyTemplateOutputs(options(short),{files:[{storagePath:path.resolve(shortSource+'/final.mp4'),productId:'fixture',relativePath:'short.mp4'}]}),/FINAL_MP4_SHORT_SHOT_REFUSE/);
cases.push({name:'real-half-second-shot',rejected:true});
const damaged=runDir+'/damaged.mp4';await fs.writeFile(damaged,'invalid-mp4');
await assert.rejects(mod.verifyTemplateOutputs(options(normal),{files:[{storagePath:damaged,productId:'fixture'}]}),e=>e.code==='FINAL_MP4_CORRUPT');
cases.push({name:'damaged-mp4',rejected:true,errorCode:'FINAL_MP4_CORRUPT'});

// Invoke both deployed fallback helpers, not reimplementations of their catch.
for(const code of ['FINAL_MP4_BOUNDARY_UNCONFIRMED','FINAL_MP4_CORRUPT','FINAL_MP4_SHORT_SHOT_REFUSE']){
 const error=shared.finalOutputError(code,'test');let calls=0;
 const reject=async()=>{calls++;throw error;};
 const entries=[{product:{id:'test'},scheduleResult:{renderPlan:{slots:[{shot:{source:'one'}}]}}}];
 await assert.rejects(renderGuidedV22({root:prod,batch:{},batchDir:runDir+'/fallback-'+code,scheduledProducts:entries},reject),e=>e===error);assert.equal(calls,1);
 let fallback=0;await assert.rejects(renderWithGuidedFallback({options:{},refined:entries,legacy:entries,renderGuided:reject,renderer:async()=>{fallback++;}}),e=>e===error);assert.equal(fallback,0);
 cases.push({name:'preserve-output-fallback-'+code,pass:true,extraRenders:0});
}
let ordinaryFallback=0;await renderWithGuidedFallback({options:{},refined:[],legacy:[],renderGuided:async()=>{throw Error('ordinary optimisation failure');},renderer:async()=>{ordinaryFallback++;}});assert.equal(ordinaryFallback,1);
cases.push({name:'ordinary-fallback-retained',pass:true});
const rows=await read(prod+'/data/classic-multisource-records.json');
for(const code of ['FINAL_MP4_BOUNDARY_UNCONFIRMED','FINAL_MP4_CORRUPT','FINAL_MP4_SHORT_SHOT_REFUSE']){
 const root=runDir+'/receipt-'+code,nasRoot=root+'/nas';await fs.mkdir(root+'/data',{recursive:true});
 await fs.mkdir(root+'/config',{recursive:true});
 await fs.copyFile(prod+'/config/classic-task-isolation.json',root+'/config/classic-task-isolation.json');
 const record=structuredClone(rows.find(r=>r.taskId===realId));delete record.lease;
 await fs.writeFile(root+'/data/classic-multisource-records.json',JSON.stringify([record]));
 const previousCwd=process.cwd();let receipt;
 try{
  process.chdir(root);
  await updateMultisourceStatus(root,realId,'failed',shared.finalOutputError(code,'test'),{ready:true,nasRoot});
  receipt=await multisourceStatus(root,realId);
 }finally{process.chdir(previousCwd);}
 assertMultisourceStatusV2(receipt);
 assert.deepEqual(receipt,await read(nasRoot+'/outbox/'+realId+'/status.json'));
 assert.equal(receipt.error.code,code);assert.equal(receipt.status,'failed');assert.match(receipt.error.message,/不建议/);
 assert.deepEqual(Object.keys(receipt.error).sort(),['code','detailCode','message','stage']);
 cases.push({name:'production-derived-receipt-'+code,pass:true,newProtocolFields:0});
}
const result={runDir,candidate,installedMode,cases,paidProviderCalls:0,productionModified:false,coverage:'Classic direct-template OOTD adapter; helpers exercised separately; no full production executor run'};
await fs.writeFile(runDir+'/result.json',JSON.stringify(result,null,2));await fs.writeFile(base+(installedMode?'/latest-installed-verification.json':'/latest-verification.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify({runDir,cases:cases.map(c=>({name:c.name,pass:c.pass,rejected:c.rejected,errorCode:c.errorCode}))},null,2));
