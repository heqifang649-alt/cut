import path from 'node:path';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {open, mkdir, stat} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {setImmediate as yieldLoop} from 'node:timers/promises';
import {readJson, writeJsonAtomic} from './atomic-json.mjs';

const execute = promisify(execFile);
export const BOUNDARY_POLICY = Object.freeze({version:'final-boundary/1',timeoutMs:20_000,maxClips:16,maxFrames:1080,
 maxDecodedBytes:20*1024*1024,maxFileBytes:128*1024*1024,maxInputBytes:512*1024*1024,meanResidual:1.5,maxResidual:16});
const digest = value => createHash('sha256').update(value).digest('hex');
export function finalOutputError(code, reason) {
 return Object.assign(new Error(code), {code,stage:'render',failure_stage:'final_mp4_boundary_verification',
  retryable:false,preserveExistingOutput:true,boundaryReason:reason});
}
export function boundaryConflict({result, cuts, clock}) {
 if(result.encodedLayoutProven || !result.shots.some(s=>s.duration<.999))return false;
 const detected=[0,...cuts.map(c=>c.frame),clock.frameCount].sort((a,b)=>a-b);
 // Independently detected short intervals are genuine evidence, never merged.
 if(detected.some((f,i)=>i && (f-detected[i-1])/clock.fps<.999))return false;
 return result.plans.some(p=>p.frame>0&&!cuts.some(c=>c.frame===p.frame))
  && cuts.some(c=>!result.plans.some(p=>p.frame===c.frame));
}
export function boundaryCheckpointFile(editDir,output) {
 return path.join(editDir,'final-boundary-checkpoints',digest(path.resolve(output))+'.json');
}
async function fingerprint(files, signal, limits) {
 let total=0;const identities=[];
 for(const file of files){
  signal.throwIfAborted();const info=await stat(file);signal.throwIfAborted();
  total+=info.size;if(!info.isFile()||info.size>limits.maxFileBytes||total>limits.maxInputBytes)throw Error('input_byte_limit');
  const h=createHash('sha256');
  for await(const chunk of createReadStream(file,{signal,highWaterMark:64*1024}))h.update(chunk);
  const after=await stat(file);if(info.size!==after.size||info.mtimeMs!==after.mtimeMs)throw Error('input_changed');
  identities.push({path:path.resolve(file),size:info.size,sha256:h.digest('hex')});
 }
 return identities;
}
async function provePrefix(input, {signal, limits, run=execute, deadline}) {
 const {clock,clips,rawCounts,requestedDuration,output}=input;
 const total=rawCounts.reduce((a,b)=>a+b,0),delta=clock.frameCount-total;
 if(clips.length!==rawCounts.length||!clips.length||clips.length>limits.maxClips||clock.frameCount>limits.maxFrames
  ||rawCounts.some(n=>!Number.isSafeInteger(n)||n<=0)||![0,1,-1].includes(delta)
  ||clock.frameCount!==Math.ceil(requestedDuration*clock.fps))return {state:'unconfirmed',reason:'unsupported_layout'};
 // A valid shorter clip is still subject to the original short-shot gate.
 const counts=[...rawCounts];counts[counts.length-1]+=delta;
 if(counts.at(-1)<=0)return {state:'unconfirmed',reason:'empty_terminal_segment'};
 let decodedBytes=0;
 const decode=async file=>{
  signal.throwIfAborted();
  const budget=limits.maxDecodedBytes-decodedBytes;if(budget<9216)throw Error('decoded_byte_limit');
  const {stdout}=await run(input.ffmpeg,['-nostdin','-v','error','-xerror','-threads','1','-i',file,
   '-filter_threads','1','-vf','scale=96:96,format=gray','-fps_mode','passthrough','-an','-f','rawvideo','pipe:1'],
  {signal,windowsHide:true,encoding:'buffer',maxBuffer:budget,timeout:Math.max(1,deadline-Date.now()),killSignal:'SIGKILL'});
  signal.throwIfAborted();decodedBytes+=stdout.length;if(decodedBytes>limits.maxDecodedBytes)throw Error('decoded_byte_limit');return stdout;
 };
 let actual;
 try{actual=await decode(output);}catch(error){
  if(error.name!=='AbortError'&&typeof error.code==='number')return {state:'corrupt',reason:'final_decode_failed'};
  throw error;
 }
 if(actual.length!==clock.frameCount*9216)return {state:'unconfirmed',reason:'final_frame_basis_changed'};
 let offset=0,maximumMean=0,maximumResidual=0,comparedFrames=0;
 for(const [i,file]of clips.entries()){
  const frames=await decode(file);
  if(frames.length!==rawCounts[i]*9216)return {state:'unconfirmed',reason:'clip_frame_basis_changed'};
  for(let f=0;f<rawCounts[i]&&offset<clock.frameCount;f++,offset++){
   signal.throwIfAborted();let brightness=0;
   for(let k=0;k<9216;k++)brightness+=actual[offset*9216+k]-frames[f*9216+k];brightness/=9216;
   let sum=0;for(let k=0;k<9216;k++){
    const difference=Math.abs(actual[offset*9216+k]-frames[f*9216+k]-brightness);
    sum+=difference;maximumResidual=Math.max(maximumResidual,difference);
   }
   maximumMean=Math.max(maximumMean,sum/9216);comparedFrames++;
   if(maximumMean>limits.meanResidual||maximumResidual>limits.maxResidual)return {state:'unconfirmed',reason:'retained_prefix_mismatch'};
   if(f%16===0)await yieldLoop(undefined,{signal});
  }
 }
 if(delta===1){
  let sum=0,max=0;for(let k=0;k<9216;k++){const d=Math.abs(actual[(clock.frameCount-1)*9216+k]-actual[(clock.frameCount-2)*9216+k]);sum+=d;max=Math.max(max,d);}
  if(sum/9216>.1||max>2)return {state:'unconfirmed',reason:'terminal_frame_not_repeated'};
 }else if(offset!==clock.frameCount)return {state:'unconfirmed',reason:'incomplete_prefix'};
 return {state:'verified',reason:'exact_encoded_prefix',counts,proof:{delta,comparedFrames,maximumMean,maximumResidual,decodedBytes}};
}

// This function is called only after the adapter has established a conflict.
// An exclusive durable claim is never automatically reclaimed: a crash, timeout
// or parallel caller cannot start another expensive verification for this output.
export async function verifyBoundaryConflict(input, {timeoutMs=BOUNDARY_POLICY.timeoutMs,run}={}) {
 const limits={...BOUNDARY_POLICY,timeoutMs:Math.min(BOUNDARY_POLICY.timeoutMs,Math.max(1,timeoutMs))};
 const checkpoint=boundaryCheckpointFile(input.editDir,input.output);
 await mkdir(path.dirname(checkpoint),{recursive:true});
 let claimed=false;
 try{
  const handle=await open(checkpoint,'wx');
  try{await handle.writeFile(JSON.stringify({version:limits.version,state:'started',at:new Date().toISOString()}));await handle.sync();claimed=true;}finally{await handle.close();}
 }catch(error){if(error.code!=='EEXIST')throw finalOutputError('FINAL_MP4_BOUNDARY_UNCONFIRMED','checkpoint_unavailable');}
 const controller=new AbortController(),deadline=Date.now()+limits.timeoutMs;
 let expire;
 const expired=new Promise(resolve=>{expire=resolve;});
 const timer=setTimeout(()=>{controller.abort(Error('verification_timeout'));expire({state:'unconfirmed',reason:'verification_timeout'});},limits.timeoutMs);
 const binding=digest(JSON.stringify({clock:{fps:input.clock.fps,frameCount:input.clock.frameCount,width:input.clock.width,height:input.clock.height},
  edl:input.edl,product:input.product,rawCounts:input.rawCounts,limits}));
 let result,identities;
 const operation=async()=>{
  const old=claimed?null:await readJson(checkpoint,null).catch(()=>null);
  if(!claimed&&(!old||old.state==='started'))return {state:'unconfirmed',reason:'checkpoint_in_progress_or_interrupted',reused:true};
  if(!claimed&&old.state!=='verified')return {state:'unconfirmed',reason:'checkpoint_previous_failure_requires_review',reused:true};
  // Hash checks reuse evidence but cannot invoke a second media verification.
  identities=await fingerprint([input.output,...input.clips],controller.signal,limits);
  if(!claimed){
   if(old.binding!==binding||JSON.stringify(old.identities)!==JSON.stringify(identities))return {state:'unconfirmed',reason:'checkpoint_input_changed',reused:true};
   return {...old.result,reused:true};
  }
  const checked=await provePrefix(input,{signal:controller.signal,limits,run,deadline});
  controller.signal.throwIfAborted();
  const after=await fingerprint([input.output,...input.clips],controller.signal,limits);
  if(JSON.stringify(after)!==JSON.stringify(identities))return {state:'unconfirmed',reason:'input_changed_during_verification'};
  return checked;
 };
 try{
  result=await Promise.race([operation(),expired]);
  if(claimed)await writeJsonAtomic(checkpoint,{version:limits.version,state:result.state,at:new Date().toISOString(),binding,identities,limits,result});
  return result;
 }catch{
  result={state:'unconfirmed',reason:controller.signal.aborted?'verification_timeout':'verification_unavailable'};
  if(claimed)await writeJsonAtomic(checkpoint,{version:limits.version,state:result.state,at:new Date().toISOString(),binding,limits,result}).catch(()=>undefined);
  return result;
 }finally{clearTimeout(timer);}
}
