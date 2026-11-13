import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {classifyInternalCuts} from '../lib/internal-cut-repair.mjs';
const exec=promisify(execFile), W=64,H=96,FPS=6,SIZE=W*H*3;
const round=n=>Number(n.toFixed(6));
export function visualDistance(a,b){
  if(!Array.isArray(a)||a.length!==b?.length||!a.length)return 0;
  return a.reduce((sum,n,i)=>sum+Math.abs(n-b[i]),0)/a.length;
}
function vector(frame){
  const values=[];
  for(let gy=0;gy<4;gy++)for(let gx=0;gx<4;gx++){
    const sum=[0,0,0];let count=0;
    for(let y=24+gy*14;y<38+gy*14;y++)for(let x=8+gx*12;x<20+gx*12;x++){
      const index=(y*W+x)*3;for(let c=0;c<3;c++)sum[c]+=frame[index+c];count++;
    }
    values.push(...sum.map(n=>round(n/count/255)));
  }
  return values;
}
function motion(a,b){let total=0,count=0;if(!a)return 0;for(let y=24;y<80;y++)for(let x=8;x<56;x++)for(let c=0;c<3;c++){const index=(y*W+x)*3+c;total+=Math.abs(a[index]-b[index]);count++;}return total/count/255;}
// Optional, bounded local observation. This is not product/pose recognition and
// does not change admission, Quality Gate, or existing semantic evidence.
export async function collectGuidedEditingEvidence({shots,ffmpeg,budgetMs=15000,maxShots=64,probe=exec,includeInternalCuts=false}={}){
  const output={version:'guided-editing-local.v1',method:'central_rgb_grid_and_frame_difference',providerCalls:0,shots:{},warnings:[]};
  if(!ffmpeg||!Array.isArray(shots))return {...output,warnings:['local_probe_unavailable']};
  const deadline=Date.now()+budgetMs;
  for(const shot of shots.slice(0,maxShots)){
    const available=Math.min(18,shot.end-shot.start);
    if(deadline-Date.now()<200){output.warnings.push('local_probe_budget_exhausted');break;}
    if(!(available>0))continue;
    try{
      const {stdout}=await probe(ffmpeg,['-nostdin','-v','error','-ss',String(shot.start),'-i',shot.path,'-t',String(available),'-vf',`fps=${FPS},scale=${W}:${H},format=rgb24`,'-f','rawvideo','pipe:1'],{windowsHide:true,encoding:'buffer',timeout:Math.min(4000,deadline-Date.now()),maxBuffer:SIZE*FPS*19});
      const frames=[];for(let n=0;n+SIZE<=stdout.length;n+=SIZE)frames.push(stdout.subarray(n,n+SIZE));
      if(frames.length<2){output.warnings.push('insufficient_samples:'+shot.id);continue;}
      const vectors=frames.map(vector),samples=frames.map((f,i)=>({at:round(i/FPS),motion:round(motion(frames[i-1],f)),change:i?round(visualDistance(vectors[i-1],vectors[i])):0}));
      const moves=samples.slice(1).map(s=>s.motion),sorted=[...moves].sort((a,b)=>a-b),median=sorted[Math.floor(sorted.length/2)]||0;
      const steady=samples.slice(1).filter(s=>s.change<.12);
      const lastActive=[...samples].reverse().find(s=>s.motion>.03||s.change>.01)?.at??0;
      const quietTail=round(samples.at(-1).at-lastActive);
      const sustained=samples.slice(1).filter(s=>s.motion>Math.max(.008,median*.55)&&s.change<.12).length/moves.length;
      output.shots[shot.id]={start:shot.start,end:shot.end,sampleFps:FPS,samples,visualVector:vectors[0].map((_,i)=>round(vectors.reduce((sum,v)=>sum+v[i],0)/vectors.length)),startVector:vectors[0],endVector:vectors.at(-1),sampleVectors:vectors,
        quietTailSeconds:quietTail,continuousMotion:round(steady.reduce((sum,s)=>sum+s.motion,0)/Math.max(1,steady.length)),
        meanMotion:round(moves.reduce((s,n)=>s+n,0)/moves.length),medianMotion:round(median),peakMotion:Math.max(...moves),sustainedMotion:round(sustained),visualChange:round(visualDistance(vectors[0],vectors.at(-1))),
        sampleFingerprint:createHash('sha256').update(stdout).digest('hex')};
      // V2.1 only: reuse the renderer's existing deterministic scene classifier.
      // Missing optional observations leave the V2 profile usable and unchanged.
      if(includeInternalCuts && deadline-Date.now()>=200){
        try{
          // Context is observed only, never added to an admitted interval.
          const sceneStart=Math.max(0,shot.start-.25),sceneDuration=available+(shot.start-sceneStart)+.25;
          const decoded=await probe(ffmpeg,['-nostdin','-hide_banner','-ss',String(sceneStart),'-i',shot.path,'-t',String(sceneDuration),'-vf',`trim=start=0:end=${sceneDuration},scale=96:96,format=gray,showinfo`,'-fps_mode','passthrough','-an','-f','rawvideo','pipe:1'],{windowsHide:true,encoding:'buffer',timeout:Math.min(4000,deadline-Date.now()),maxBuffer:32*1024*1024});
          const times=[...decoded.stderr.toString().matchAll(/\bn:\s*\d+.*?pts_time:([\d.e+-]+)/g)].map(m=>Number(m[1]));
          const gray=Array.from({length:Math.floor(decoded.stdout.length/9216)},(_,i)=>decoded.stdout.subarray(i*9216,(i+1)*9216));
          if(gray.length!==times.length||times.some((t,i)=>!Number.isFinite(t)||i>0&&t<=times[i-1]))throw Error('scene_timestamp_mismatch');
          output.shots[shot.id].internalCuts=classifyInternalCuts(gray,times).map(c=>({...c,time:round(sceneStart+c.time)}));
        }catch(error){output.warnings.push('optional_scene_probe_failed:'+shot.id+':'+(error.code||error.message));}
      }
    }catch(error){output.warnings.push('local_probe_failed:'+shot.id+':'+(error.code||'error'));}
  }
  if(shots.length>maxShots)output.warnings.push('local_probe_shot_budget');
  return output;
}
