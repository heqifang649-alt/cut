import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {classifyInternalCuts} from '../lib/internal-cut-repair.mjs';
import {oneSecondWindow,assertFinalShots} from './ootd-min-shot.mjs';
import {enforceMinimumSafeDuration} from './shot-scheduler.mjs';
import {loadRuntimeConfig} from './runtime-config.mjs';
import {writeJsonAtomic,readJson} from '../lib/atomic-json.mjs';
import {boundaryConflict,verifyBoundaryConflict,finalOutputError} from '../lib/final-mp4-boundary.mjs';
const exec=promisify(execFile);
export async function scanTemplateCuts({ffmpeg,file,start=0,duration}){
 const {stdout}=await exec(ffmpeg,['-nostdin','-v','error','-ss',String(start),'-i',file,'-t',String(duration),'-vf','fps=30,scale=96:96,format=gray','-f','rawvideo','pipe:1'],{windowsHide:true,encoding:'buffer',maxBuffer:32*1024*1024,timeout:60000});
 const count=Math.floor(stdout.length/9216);if(count<2)throw Error('OOTD_CUT_EVIDENCE_UNAVAILABLE');
 const frames=Array.from({length:count},(_,i)=>stdout.subarray(i*9216,(i+1)*9216));return classifyInternalCuts(frames,frames.map((_,i)=>i/30)).filter(c=>c.confidence==='high');
}
export async function repairTemplateWindows(options,{scan=scanTemplateCuts}={}){
 const products=structuredClone(options.scheduledProducts),changes=[];
 for(const product of products){
  const kept=[];
  for(const entry of product.scheduleResult.renderPlan.slots){
   const start=entry.shot.start,end=entry.shot.end;
   const cuts=await scan({ffmpeg:options.ffmpeg,file:entry.shot.path,start,duration:end-start});
   try{const window=oneSecondWindow(start,end,Math.max(1,entry.slot.targetDuration),cuts);entry.shot.start=window.start;entry.slot.targetDuration=window.duration;kept.push(entry);changes.push({shotId:entry.shot.id,source:entry.shot.path,oldStart:start,start:window.start,duration:window.duration,cuts});}
   catch{changes.push({shotId:entry.shot.id,reason:'no_one_second_safe_window_skip_optional_slot'});}
  }
  product.scheduleResult.renderPlan.slots=kept;
  product.scheduleResult=enforceMinimumSafeDuration(product.scheduleResult);
  if(product.scheduleResult.status!=='success')throw Object.assign(Error('INSUFFICIENT_SAFE_DURATION'),{code:'INSUFFICIENT_SAFE_DURATION',retryable:false});
 }
 await writeJsonAtomic(path.join(options.editDir||path.join(options.batchDir,'edit'),'ootd-min-shot-repair.json'),{changes});
 return {...options,scheduledProducts:products};
}
// Use native decoded timestamps for final verification; source-window scanning stays unchanged.
export async function probeFrameClock(ffprobe,file){
 const {stdout}=await exec(ffprobe,['-v','error','-select_streams','v:0','-show_streams','-show_frames','-show_entries','stream=avg_frame_rate,time_base,width,height:frame=best_effort_timestamp','-of','json',file],{windowsHide:true,maxBuffer:16*1024*1024,timeout:60000});
 const data=JSON.parse(stdout),stream=data.streams?.[0];
 const ratio=value=>{const [n,d]=String(value).split('/').map(Number);return n/d;};
 const fps=ratio(stream?.avg_frame_rate),timeBase=ratio(stream?.time_base);
 const pts=(data.frames||[]).map(f=>Number(f.best_effort_timestamp));
 if(!pts.length||!Number.isFinite(fps)||!Number.isFinite(timeBase)||timeBase<=0||pts.some((p,i)=>!Number.isSafeInteger(p)||(i&&p<=pts[i-1])))throw Error('OOTD_FRAME_BASIS_UNCONFIRMED');
 const times=pts.map(p=>(p-pts[0])*timeBase);
 // Preserve the existing 30fps contract and refuse an unconfirmed/VFR clock.
 if(Math.abs(fps-30)>.01||times.some((t,i)=>Math.abs(t-i/fps)>timeBase*1.1))throw Error('OOTD_FRAME_BASIS_UNCONFIRMED');
 return {fps,timeBase,pts,times,frameCount:pts.length,duration:times.at(-1)+1/fps,width:stream.width,height:stream.height};
}
export async function scanFinalTemplateCuts({ffmpeg,file,clock}){
 const {stdout}=await exec(ffmpeg,['-nostdin','-v','error','-xerror','-i',file,'-vf','scale=96:96,format=gray','-fps_mode','passthrough','-an','-f','rawvideo','pipe:1'],{windowsHide:true,encoding:'buffer',maxBuffer:32*1024*1024,timeout:60000});
 if(stdout.length!==clock.frameCount*9216)throw Error('OOTD_FRAME_BASIS_UNCONFIRMED');
 const frames=Array.from({length:clock.frameCount},(_,i)=>stdout.subarray(i*9216,(i+1)*9216));
 const candidates=classifyInternalCuts(frames,clock.times);
 // Persistence rejects flashes in source analysis. In final analysis retain
 // both sharp adjacent edges even without persistence; never merge detections.
 const sharp=c=>c.evidence.normalizedDifference>=.12&&c.evidence.spatialCoverage>=.5&&c.evidence.localMotionRatio>=3.2;
 const kept=candidates.filter((c,i)=>c.confidence==='high'||(sharp(c)&&[candidates[i-1],candidates[i+1]].some(n=>n&&sharp(n)&&Math.abs(Math.abs(n.time-c.time)-1/clock.fps)<clock.timeBase*2))).map(c=>({...c,frame:Math.round(c.time*clock.fps)}));
 // Also retain the two edges of a full-frame luminance flash. The source
 // classifier intentionally removes brightness offsets and cannot prove it safe.
 const raw=frames.map((f,i)=>{if(!i)return 0;let sum=0;for(let k=0;k<f.length;k++)sum+=Math.abs(f[k]-frames[i-1][k]);return sum/f.length/255;});
 const abrupt=i=>{const neighbors=raw.slice(Math.max(1,i-3),i+4).filter((_,j)=>Math.max(1,i-3)+j!==i).sort((a,b)=>a-b);return raw[i]>=.25&&raw[i]>=3.2*Math.max(.001,neighbors[Math.floor(neighbors.length/2)]||0);};
 for(let i=1;i<raw.length-1;i++)if(abrupt(i)&&abrupt(i+1))for(const frame of [i,i+1])if(!kept.some(c=>c.frame===frame))kept.push({time:clock.times[frame],frame,confidence:'high',evidence:{adjacentFlashEdges:true,rawDifference:raw[frame]}});
 // A flash at either endpoint has only one in-file edge. Keep it as a real
 // boundary rather than treating a terminal anomaly as duration padding.
 for(const frame of [1,raw.length-1])if(abrupt(frame)&&!kept.some(c=>c.frame===frame))kept.push({time:clock.times[frame],frame,confidence:'high',evidence:{endpointFlashEdge:true,rawDifference:raw[frame]}});
 return kept.sort((a,b)=>a.frame-b.frame);
}
export function finalShotBoundaries({clock,segments,cuts,encodedCounts}){
 const nearest=time=>{let best=0;for(let i=1;i<clock.times.length;i++)if(Math.abs(clock.times[i]-time)<Math.abs(clock.times[best]-time))best=i;return best;};
 const proven=Array.isArray(encodedCounts)&&encodedCounts.length===segments.length&&encodedCounts.every(n=>Number.isSafeInteger(n)&&n>0)&&encodedCounts.reduce((a,b)=>a+b,0)===clock.frameCount;
 let cumulative=0;
 const plans=segments.map((s,i)=>{const frame=proven?cumulative:nearest(Number(s.output_in));if(proven)cumulative+=encodedCounts[i];return {segmentId:s.segment_id,plannedTime:s.output_in,frame,encodedCount:proven?encodedCounts[i]:null};});
 const detections=cuts.map(c=>Number.isInteger(c.frame)?c.frame:nearest(c.time));
 if(detections.some(f=>f<1||f>=clock.frameCount))throw Error('OOTD_FRAME_BASIS_UNCONFIRMED');
 // Only identical native frame indices coalesce. Two detected transitions one
 // frame apart remain two boundaries, including next to a planned cut.
 const boundaries=[...new Set([0,...plans.map(p=>p.frame),...detections,clock.frameCount])].sort((a,b)=>a-b);
 const at=f=>f===clock.frameCount?clock.duration:clock.times[f];
 return {plans,encodedLayoutProven:proven,boundaries,shots:boundaries.slice(0,-1).map((frame,i)=>({startFrame:frame,endFrame:boundaries[i+1],start:at(frame),end:at(boundaries[i+1]),duration:at(boundaries[i+1])-at(frame),source:segments[plans.findLastIndex(p=>p.frame<=frame)]?.source_original}))};
}
async function encodedSegmentCounts(options,product,edl,clock,ffprobe,evidence){
 // Match exact EDL cache signatures, not similarly named clips from old attempts.
 if(edl.transition_profile!=='hard_cut'||product.applied_transition_profile!=='hard_cut')return null;
 try{
  const counts=[],clipFiles=[];
  for(const [i,s]of product.segments.entries()){
   const duration=Number(s.duration||(s.source_out-s.source_in)),colorStrategy=options.batch?.colorStrategy||'none';
   const signature=createHash('sha256').update(JSON.stringify({source:s.source_original,sourceIn:s.source_in,duration,width:edl.master.width,height:edl.master.height,fps:edl.master.fps,colorStrategy})).digest('hex').slice(0,16);
   const file=path.join(options.editDir||path.join(options.batchDir,'edit'),'clips_graded',product.product_id,`${String(i+1).padStart(2,'0')}-${colorStrategy}-${signature}.mp4`);
   const clip=await probeFrameClock(ffprobe,file);
   if(clip.fps!==clock.fps||clip.frameCount!==Math.round(duration*clock.fps)||clip.width!==clock.width||clip.height!==clock.height)return null;
   counts.push(clip.frameCount);
   clipFiles.push(file);
  }
  Object.assign(evidence,{clips:clipFiles,rawCounts:[...counts]});
  const total=counts.reduce((a,b)=>a+b,0);
  if(total===clock.frameCount)return counts;
  // The existing final CFR encode may ceil the requested duration after the
  // individual clips rounded their lengths. Prove a single repeated tail frame;
  // never tolerate a discrepancy at an internal cut or merge detected edges.
  if(clock.frameCount-total!==1||clock.frameCount!==Math.ceil(Number(product.duration_seconds)*clock.fps))return null;
  const file=options.finalVerificationOutput;
  if(!file)return null;
  const {stdout}=await exec(options.ffmpeg,['-nostdin','-v','error','-i',file,'-vf',`select=gte(n\\,${clock.frameCount-2}),scale=96:96,format=gray`,'-fps_mode','passthrough','-an','-f','rawvideo','pipe:1'],{windowsHide:true,encoding:'buffer',maxBuffer:9216*3,timeout:60000});
  if(stdout.length!==9216*2)return null;
  let totalDifference=0,maxDifference=0;
  for(let i=0;i<9216;i++){const delta=Math.abs(stdout[i]-stdout[9216+i]);totalDifference+=delta;maxDifference=Math.max(maxDifference,delta);}
  if(maxDifference>2||totalDifference/9216>.1)return null;
  counts[counts.length-1]+=1;
  counts.terminalPadding={frames:1,meanDifference:totalDifference/9216,maxDifference,reason:'verified_repeated_final_frame_after_cfr_duration_rounding'};
  return counts;
 }catch{return null;}
}
export async function verifyTemplateOutputs(options,rendered,{scan=scanFinalTemplateCuts,verifyConflict=verifyBoundaryConflict}={}){
 const runtime=await loadRuntimeConfig(options.root),reports=[];
 const edl=await readJson(path.join(options.editDir||path.join(options.batchDir,'edit'),'render-plan-edl.json'),null);
 for(const file of rendered.files||[]){
  const output=path.isAbsolute(file.storagePath)?file.storagePath:path.resolve(options.root,file.storagePath);
  let clock,cuts;
  try{
   clock=await probeFrameClock(runtime.ffprobeExecutable,output);
   cuts=await scan({ffmpeg:options.ffmpeg,file:output,duration:clock.duration,clock});
  }catch(error){
   const code=typeof error.code==='number'?'FINAL_MP4_CORRUPT':'FINAL_MP4_BOUNDARY_UNCONFIRMED';
   throw finalOutputError(code,'final_media_probe_or_decode_failed');
  }
  const product=edl?.products?.find(p=>p.product_id===file.productId);if(!product)throw Error('OOTD_TIMELINE_MISSING');
  const evidence={clips:[],rawCounts:[]},editDir=options.editDir||path.join(options.batchDir,'edit');
  let encodedCounts=await encodedSegmentCounts({...options,finalVerificationOutput:output},product,edl,clock,runtime.ffprobeExecutable,evidence);
  let result=finalShotBoundaries({clock,segments:product.segments,cuts,encodedCounts}),boundaryVerification;
  if(boundaryConflict({result,cuts,clock})){
   if(options.boundaryResumeSignature)await writeJsonAtomic(path.join(editDir,'ootd-boundary-resume.json'),{signature:options.boundaryResumeSignature,rendered});
   boundaryVerification=await verifyConflict({editDir,output,ffmpeg:options.ffmpeg,clock,edl,product,
    requestedDuration:Number(product.duration_seconds),...evidence});
   if(boundaryVerification.state!=='verified'){
    const report={output:file.relativePath,...result,cuts,pass:false,boundaryVerification};
    await writeJsonAtomic(path.join(editDir,'ootd-final-shot-check.json'),{reports:[...reports,report]});
    throw finalOutputError(boundaryVerification.state==='corrupt'?'FINAL_MP4_CORRUPT':'FINAL_MP4_BOUNDARY_UNCONFIRMED',boundaryVerification.reason);
   }
   encodedCounts=boundaryVerification.counts;
   result=finalShotBoundaries({clock,segments:product.segments,cuts,encodedCounts});
  }
  const report={output:file.relativePath,duration:clock.duration,fps:clock.fps,timeBase:clock.timeBase,...result,terminalPadding:encodedCounts?.terminalPadding||null,cuts,pass:true,
   ...(boundaryVerification?{boundaryVerification}:{})};
  try{assertFinalShots(result.shots);}catch(error){
   error.preserveExistingOutput=true;
   report.pass=false;
   await writeJsonAtomic(path.join(options.editDir||path.join(options.batchDir,'edit'),'ootd-final-shot-check.json'),{reports:[...reports,report]});
   error.diagnostic_details={index_basis:'one_based',fps:clock.fps,frame_count:clock.frameCount,encoded_layout_proven:result.encodedLayoutProven,
    failed_intervals:result.shots.flatMap((s,i)=>s.duration<.999?[{shot_index:i+1,start_frame:s.startFrame,end_frame:s.endFrame,duration_ms:s.duration*1000}]:[])};
   throw error;
  }
  reports.push(report);
 }
 if(!reports.length)throw Error('RENDER_OUTPUT_INVALID');
 await writeJsonAtomic(path.join(options.editDir||path.join(options.batchDir,'edit'),'ootd-final-shot-check.json'),{reports});return rendered;
}
export async function renderOotdTemplate(options,renderer){
 const editDir=options.editDir||path.join(options.batchDir,'edit');
 const signature=createHash('sha256').update(JSON.stringify({batch:options.batch,scheduledProducts:options.scheduledProducts,
  templateFallbackProducts:options.templateFallbackProducts,semanticEvidence:options.semanticEvidence})).digest('hex');
 const resume=await readJson(path.join(editDir,'ootd-boundary-resume.json'),null);
 if(resume){
  if(resume.signature!==signature)throw finalOutputError('FINAL_MP4_BOUNDARY_UNCONFIRMED','resume_input_changed');
  return verifyTemplateOutputs({...options,boundaryResumeSignature:signature},resume.rendered);
 }
 let repaired;
 try{repaired=await repairTemplateWindows(options);}catch(error){
  if(!options.templateFallbackProducts)throw error;
  repaired=await repairTemplateWindows({...options,scheduledProducts:options.templateFallbackProducts});
  await writeJsonAtomic(path.join(options.editDir||path.join(options.batchDir,'edit'),'website-template-render-fallback.json'),{reason:error.code||error.message,to:'existing_guided_safe_windows'});
 }
 const rendered=await renderer(repaired);return verifyTemplateOutputs({...repaired,boundaryResumeSignature:signature},rendered);
}
