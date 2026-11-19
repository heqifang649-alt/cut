import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile),base=path.resolve('.project-governance/evidence/short-residue-20261119');
const manifest=JSON.parse(await fs.readFile(base+'/manifest.json','utf8'));
const installedMode=process.argv.includes('--installed');
if(installedMode)manifest.candidate=manifest.production;
const runDir=await fs.mkdtemp(base+(installedMode?'/installed-':'/run-')),read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
const hash=async p=>createHash('sha256').update(await fs.readFile(p)).digest('hex');
const load=(arm,file)=>import(pathToFileURL(manifest[arm]+'/'+file));
const candidate=await load('candidate','worker/ootd-template-render.mjs'),baseline=await load('baseline','worker/ootd-template-render.mjs');
const rt=await read(manifest.production+'/config/cutflow-runtime.json'),cases=[],protectedMedia=[];
let networkAttempts=0;globalThis.fetch=async()=>{networkAttempts++;throw Error('Network disabled in isolated acceptance');};
delete process.env.CUTFLOW_RUNTIME_CONFIG;delete process.env.ENABLE_BRAND_COPY_LIBRARY;delete process.env.ENABLE_BRAND_BGM;
async function copyEdit(source,target){
 await fs.mkdir(target,{recursive:true});await fs.copyFile(source+'/render-plan-edl.json',target+'/render-plan-edl.json');
 await fs.cp(source+'/clips_graded',target+'/clips_graded',{recursive:true});
}
const verifyOptions=editDir=>({root:manifest.production,editDir,ffmpeg:rt.ffmpegExecutable,batch:{colorStrategy:'none'}});
// Verify existing files without rendering or changing task status.
for(const id of ['e4d39e41-f684-4e64-8dad-0cbaa867d3ca','2863bcc1-ff81-4ed3-ae2f-4ea1c88a09fe']){
 const work='E:/cutflow批量/classic-multisource/'+id,out=await read(work+'/output/render-manifest.json'),file=out.files[0].storagePath,before=await hash(file);
 const edit=runDir+'/historical-'+id;await copyEdit(work+'/edit',edit);
 await candidate.verifyTemplateOutputs(verifyOptions(edit),out);
 const report=(await read(edit+'/ootd-final-shot-check.json')).reports[0];assert.equal(report.pass,true);
 await candidate.verifyTemplateOutputs(verifyOptions(edit),out);
 assert.equal((await read(edit+'/ootd-final-shot-check.json')).reports[0].boundaryVerification.reused,true);
 assert.equal(await hash(file),before);protectedMedia.push({file,sha256:before});
 cases.push({name:'historical-false-refusal-'+id,actualHistoricalMp4:true,pass:true,renderCalls:0,report,sha256:before});
 console.log('historical MP4 verified',id);
}
const history='.project-governance/evidence/allwe-short-shot-20261119/e4d39e41-f684-4e64-8dad-0cbaa867d3ca';
for(const [name,code]of [['internal-flash','FINAL_MP4_SHORT_SHOT_REFUSE'],['internal-drop','FINAL_MP4_BOUNDARY_UNCONFIRMED']]){
 const edit=runDir+'/'+name;await copyEdit(history,edit);
 await assert.rejects(candidate.verifyTemplateOutputs(verifyOptions(edit),{files:[{storagePath:path.resolve('.project-governance/evidence/allwe-short-shot-20261119/'+name+'.mp4'),productId:'nerdywave'}]}),e=>e.code===code);
 cases.push({name,rejected:true,code});
}
const broken=runDir+'/corrupt.mp4';await fs.writeFile(broken,'corrupt');
await assert.rejects(candidate.verifyTemplateOutputs(verifyOptions(runDir),{files:[{storagePath:broken,productId:'fixture'}]}),e=>e.code==='FINAL_MP4_CORRUPT');
cases.push({name:'corrupt-mp4',rejected:true});
for(const name of ['one-frame-flash','two-distinct-transitions','terminal-one-frame-flash']){
 const file=path.resolve('.project-governance/evidence/final-shot-boundary-20261117-r2/installed-regression/'+name+'.mp4');
 const clock=await candidate.probeFrameClock(rt.ffprobeExecutable,file),cuts=await candidate.scanFinalTemplateCuts({ffmpeg:rt.ffmpegExecutable,file,clock});
 const {assertFinalShots}=await load('candidate','worker/ootd-min-shot.mjs');
 assert.throws(()=>assertFinalShots(candidate.finalShotBoundaries({clock,segments:[{output_in:0}],cuts,encodedCounts:[clock.frameCount]}).shots),/FINAL_MP4_SHORT_SHOT_REFUSE/);
 cases.push({name,actualEncodedMp4:true,rejected:true});
}
async function sample(id){
 const work='E:/cutflow批量/classic-multisource/'+id,edl=await read(work+'/edit/render-plan-edl.json');
 const saved=await read(work+'/edit/multisource-schedule-result.json'),quality=await read(work+'/quality/classic-multisource-quality.v1.json');
 const media=await read(base+'/media/manifest.json');
 const pool=[...new Map(saved.scheduledProducts.flatMap(p=>p.scheduleResult?.renderPlan?.slots||[]).map(e=>[e.shot.id,{...e.shot,path:media.find(m=>m.taskId===id&&m.sourceId===e.shot.source).target}])).values()];
 const products=edl.products.map(p=>({product:{id:p.product_id,label:p.display_name,files:pool.map(s=>s.path)},sourceNamesByShotId:Object.fromEntries(pool.map(s=>[s.id,s.path])),scheduleResult:{status:'success',renderPlan:{
  id:'frozen-'+id,batchId:id,createdAt:'2026-11-19T00:00:00Z',minimumSafeDuration:p.minimum_safe_duration,transitionProfile:'hard_cut',
  slots:p.segments.map(s=>({slot:{id:s.slot,label:s.slot,requireTags:[],targetDuration:s.duration},shot:{...pool.find(x=>x.id===s.shot_id),start:s.source_in,end:s.source_out,duration:s.source_out-s.source_in}}))}}}));
 const out=await read(work+'/output/render-manifest.json'),selection=out.files[0]?.brandCopy;
 return {id,work,edl,products,quality,context:{fps:30,shotPool:{shots:pool},qualityReport:quality},out,hook:selection?.actualHook||'',cta:selection?.actualCTA||''};
}
async function rootFor(name){
 const root=runDir+'/'+name;for(const folder of ['config','data','worker'])await fs.mkdir(root+'/'+folder,{recursive:true});
 await fs.copyFile(manifest.production+'/worker/render-overlays.py',root+'/worker/render-overlays.py');
 await fs.writeFile(root+'/config/cutflow-runtime.json',JSON.stringify({...rt,workRoot:root+'/work',runtimeTempRoot:root+'/temp',runtimeCacheRoot:root+'/cache',deliveryRoot:root+'/delivery'}));
 return root;
}
async function render(arm,name,sample){
 const root=await rootFor(name),batchDir=root+'/batch',p=sample.edl.products[0],master=sample.edl.master;
 const {renderBatchFromRenderPlans}=await load(arm,'worker/batch-renderer.mjs');
 const batch={id:sample.id,name,storageVersion:1,status:'editing',files:[],colorStrategy:'none',transitionProfile:'hard_cut',
  transitionMode:'standard',targetOutputsPerBatch:1,coveragePolicy:'all_products_required',durationMax:18,
  brandCopyEnabled:false,brandBgmEnabled:true,referenceProfile:{...master,hook_text:sample.hook,cvr_text:sample.cta},hookText:sample.hook,cvrText:sample.cta};
 const bgm=sample.out?.files?.[0]?.bgm,preparedBrandAudioByProduct=new Map();
 if(bgm)preparedBrandAudioByProduct.set(p.product_id,{path:bgm.normalizedPath,decision:bgm});
 else{batch.brandBgmEnabled=false;}
 const activities=[];
 const options={root,batch,batchDir,ffmpeg:rt.ffmpegExecutable,scheduledProducts:structuredClone(sample.products),shortResidueContext:sample.context,
  preparedBrandAudioByProduct,onActivity:async text=>activities.push(text)};
 let result;
 try{result=await renderBatchFromRenderPlans(options);}catch(error){
  await fs.writeFile(root+'/failure.json',JSON.stringify({message:error.message,code:error.code,reason:error.reason,stack:error.stack},null,2));throw error;
 }
 const output=result.files[0].storagePath,file=path.isAbsolute(output)?output:path.resolve(root,output);
 const edl=await read(batchDir+'/edit/render-plan-edl.json'),repair=await read(batchDir+'/edit/internal-cut-repair.v1.json');
 await exec(rt.ffmpegExecutable,['-nostdin','-v','error','-xerror','-i',file,'-f','null','-'],{windowsHide:true,timeout:60000});
 const record={root,file,sha256:await hash(file),edl,repair,activities,result,normalRenderCalls:activities.filter(x=>String(x).startsWith('合成')).length};
 await fs.writeFile(root+'/acceptance.json',JSON.stringify(record,null,2));return record;
}
const real=await sample('07338b39-3e41-4706-b447-43fd4ab9148e');
const originalFile=real.out.files[0].storagePath,originalHash=await hash(originalFile);protectedMedia.push({file:originalFile,sha256:originalHash});
const originalCheck=runDir+'/real-original-check';await copyEdit(real.work+'/edit',originalCheck);
await assert.rejects(baseline.verifyTemplateOutputs(verifyOptions(originalCheck),real.out),/FINAL_MP4_SHORT_SHOT_REFUSE/);
console.log('render real residue candidate');
const repaired=await render('candidate','real-repaired',real);
assert.equal(repaired.repair.products[0].shortResidue.state,'repaired');
await candidate.verifyTemplateOutputs({root:repaired.root,editDir:repaired.root+'/batch/edit',ffmpeg:rt.ffmpegExecutable,batch:{colorStrategy:'none'}},repaired.result);
const finalCheck=(await read(repaired.root+'/batch/edit/ootd-final-shot-check.json')).reports[0];assert.equal(finalCheck.pass,true);
const changed=repaired.edl.products[0].segments.filter((s,i)=>s.source_in!==real.edl.products[0].segments[i].source_in);
assert.equal(changed.length,1);assert.equal(changed[0].shot_id,'abcb4a1ab8d16c888a2a86c6a3448c71');
assert.ok(changed[0].source_in>=7.75);assert.equal(changed[0].duration,2);
assert.equal(await hash(originalFile),originalHash);
cases.push({name:'real-one-frame-residue',actualHistoricalSources:true,originalFile,originalSha256:originalHash,repairedFile:repaired.file,repairedSha256:repaired.sha256,
 pass:true,changed,repair:repaired.repair.products[0].shortResidue,finalCheck,renderCalls:1});
console.log('real residue fixed',changed.map(s=>s.source_in));
// Material insufficiency must fail before overlays, video encoding or any retry.
const insufficient=structuredClone(real);insufficient.context.qualityReport.decisions.find(r=>r.shotId==='abcb4a1ab8d16c888a2a86c6a3448c71').state='REJECT';
const insufficientRoot=await rootFor('insufficient'),activities=[];
const {renderBatchFromRenderPlans}=await load('candidate','worker/batch-renderer.mjs');
await assert.rejects(renderBatchFromRenderPlans({root:insufficientRoot,batch:{},batchDir:insufficientRoot+'/batch',ffmpeg:rt.ffmpegExecutable,
 scheduledProducts:insufficient.products,shortResidueContext:insufficient.context,onActivity:async x=>activities.push(x)}),e=>e.code==='SOURCE_INSUFFICIENT'&&e.retryable===false&&e.preserveExistingOutput===true);
assert.equal(activities.length,0);cases.push({name:'reject-interval-insufficiency-before-render',rejected:true,renderCalls:0});
const normal=await sample('25a88a58-ee85-40fd-9319-4dfef97194fb');
const fixtureSource=runDir+'/unboxing-fixture.mp4';
await exec(rt.ffmpegExecutable,['-nostdin','-v','error','-f','lavfi','-i','testsrc2=s=360x640:r=30:duration=12','-c:v','libx264','-pix_fmt','yuv420p','-y',fixtureSource],{windowsHide:true,timeout:60000});
const slots=['hook','package_open','item_reveal','detail'].map((id,i)=>({slot:{id,label:id,requireTags:[],targetDuration:2},shot:{id:'unbox-'+i,source:'fixture',path:fixtureSource,start:i*2.5,end:i*2.5+2,duration:2,videoType:'unboxing',origin:'real',reject:false,tags:[],productVisibility:1,productCentered:true,motionEnergy:'medium'}}));
const unbox={id:'unboxing-normal-fixture',out:normal.out,edl:{master:{width:360,height:640,fps:30,duration_seconds:8,hook:{text:'UNBOX THE DETAILS'},cvr:{text:'SEE THE FIT'}},products:[{product_id:'unbox'}]},
 products:[{product:{id:'unbox',label:'unbox',files:[fixtureSource]},sourceNamesByShotId:Object.fromEntries(slots.map(e=>[e.shot.id,fixtureSource])),scheduleResult:{status:'success',renderPlan:{id:'unboxing-fixture',batchId:'unboxing-normal-fixture',createdAt:'2026-11-19T00:00:00Z',minimumSafeDuration:8,transitionProfile:'hard_cut',slots}}}],hook:'UNBOX THE DETAILS',cta:'SEE THE FIT'};
for(const [name,input]of [['normal-ootd',normal],['normal-unboxing',unbox]]){
 console.log('normal A/B rendering',name);
 const a=await render('baseline',name+'-baseline',input),b=await render('candidate',name+'-candidate',input);
 assert.deepEqual(b.edl,a.edl);assert.deepEqual(b.repair,a.repair);assert.equal(b.sha256,a.sha256);
 assert.equal(b.result.files[0].bgm?.bgmFile,a.result.files[0].bgm?.bgmFile);
 assert.deepEqual(b.edl.master.hook,a.edl.master.hook);assert.deepEqual(b.edl.master.cvr,a.edl.master.cvr);
 assert.equal(b.activities.length,a.activities.length);
 cases.push({name,actualHistoricalSources:name==='normal-ootd',syntheticFixture:name==='normal-unboxing',pass:true,edlIdentical:true,repairIdentical:true,
  mp4ByteIdentical:true,sha256:a.sha256,beforeFile:a.file,afterFile:b.file,hook:a.edl.master.hook,cta:a.edl.master.cvr,bgm:a.result.files[0].bgm?.bgmFile||null,
  activityCountBefore:a.activities.length,activityCountAfter:b.activities.length});
}
// Exercise failure propagation and the unchanged receipt schema in isolated
// stores: known insufficient material cannot fall back into a second render.
const insufficientError=Object.assign(Error('SOURCE_INSUFFICIENT'),{code:'SOURCE_INSUFFICIENT',failure_stage:'pre_render_short_residue',retryable:false,preserveExistingOutput:true});
const {renderWithGuidedFallback}=await load('candidate','worker/guided-production-policy.mjs');
const {renderGuidedV22}=await load('candidate','worker/guided-render-v22.mjs');
const failureRoot=await rootFor('bounded-fallback');let renderCalls=0,fallbackCalls=0;
await assert.rejects(renderGuidedV22({root:failureRoot,batch:{},batchDir:failureRoot+'/batch',scheduledProducts:unbox.products},async()=>{renderCalls++;throw insufficientError;}),e=>e===insufficientError);
assert.equal(renderCalls,1);
await assert.rejects(renderWithGuidedFallback({options:{},refined:real.products,legacy:normal.products,renderGuided:async()=>{throw insufficientError;},renderer:async()=>{fallbackCalls++;}}),e=>e===insufficientError);
assert.equal(fallbackCalls,0);cases.push({name:'insufficient-material-fallback-bounded',pass:true,renderCalls,fallbackCalls});
const receiptRoot=await rootFor('receipt'),rows=await read(manifest.production+'/data/classic-multisource-records.json');
const record=structuredClone(rows.find(r=>r.taskId===real.id));delete record.lease;
await fs.writeFile(receiptRoot+'/data/classic-multisource-records.json',JSON.stringify([record]));
await fs.copyFile(manifest.production+'/config/classic-task-isolation.json',receiptRoot+'/config/classic-task-isolation.json');
const {updateMultisourceStatus,multisourceStatus,assertMultisourceStatusV2}=await load('candidate','lib/classic-multisource.mjs');
const previousCwd=process.cwd();let receipt;
try{
 process.chdir(receiptRoot);
 await updateMultisourceStatus(receiptRoot,real.id,'failed',insufficientError,{ready:true,nasRoot:receiptRoot+'/nas'});
 receipt=await multisourceStatus(receiptRoot,real.id);
}finally{process.chdir(previousCwd);}
assertMultisourceStatusV2(receipt);assert.equal(receipt.error.code,'SOURCE_INSUFFICIENT');assert.match(receipt.error.message,/安全素材不足/);
assert.deepEqual(Object.keys(receipt.error).sort(),['code','detailCode','message','stage']);
cases.push({name:'explicit-material-insufficiency-existing-receipt-schema',pass:true,newProtocolFields:0,message:receipt.error.message});
for(const p of protectedMedia)assert.equal(await hash(p.file),p.sha256);
const productionHashes=[];
const delivered=await read(base+'/delivery.json');
for(const f of manifest.files){
 const expected=installedMode?(delivered.files.find(d=>d.file===f.file)?.candidateSha256||f.sha256):f.sha256;
 const current=await hash(manifest.production+'/'+f.file);assert.equal(current,expected);productionHashes.push({...f,current,expected});
}
if(installedMode)for(const f of delivered.files)assert.equal(await hash(manifest.production+'/'+f.file),f.candidateSha256);
assert.equal(networkAttempts,0);
const result={runDir,cases,networkAttempts,providerCalls:0,installedMode,productionCodeUnchanged:!installedMode,productionHashes,protectedMedia,
 scope:'Isolated production-derived render and media verification; frozen recorded Hook/BGM for real-source A/B; unboxing is a synthetic deterministic fixture; no production task state or publication'};
await fs.writeFile(runDir+'/result.json',JSON.stringify(result,null,2));await fs.writeFile(base+(installedMode?'/latest-installed-verification.json':'/latest-verification.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify({runDir,cases:cases.map(c=>({name:c.name,pass:c.pass,rejected:c.rejected})),networkAttempts}));
