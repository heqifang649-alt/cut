import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { scheduleV2Policy } from '../worker/scheduler-v2-policy.mjs';
import { renderPlansToEdl, verifyEncodedSafeDuration } from '../worker/batch-renderer.mjs';
import { classifyRecoveryError } from '../worker/recovery.mjs';
function fixture(n = 2, duration = 3) {
  const shots = Array.from({ length: n }, (_, i) => ({ id: `s${i}`, source: `camera:${i}.mp4`, path: `D:/media/${i}.mp4`, start: 0, end: duration, duration, tags: [], reject: false, origin: "real", productVisibility: 0.9, productCentered: true, motionEnergy: "medium" }));
  return { batchId: "batch", targetDuration: 10, durationCap: 13, allowPartial: true,
    scriptTemplate: { id: "t", name: "t", totalDuration: 10, slots: [{ id: "hook", label: "hook", requireTags: [], targetDuration: 3 }] },
    productView: { product: { id: "p", label: "p", files: shots.map((_, i) => `${i}.mp4`) }, sourceNamesByShotId: Object.fromEntries(shots.map((s, i) => [s.id, `${i}.mp4`])), shots },
    semanticEvidence: { batchId: "batch", complete: true, records: shots.map((s) => ({ shotId: s.id, status: "scored", result: { schema_version: "semantic-shot.v1", shot_id: s.id, shot_type: "other", product_match: 0.9, clothing_visibility: 0.9, visual_quality: 0.8, hook_value: 0.1, usable: true, confidence: 0.9 } })) } };
}

const root=process.cwd();
const config=JSON.parse(await readFile(path.join(root,'config/cutflow-runtime.json'),'utf8'));
const out=path.join(root,'.project-governance/evidence/scheduler-safe8-20261020');await mkdir(out,{recursive:true});
const run=(exe,args)=>new Promise((resolve,reject)=>{const p=spawn(exe,args,{windowsHide:true});let error='';p.stderr.on('data',d=>error+=d);p.on('error',reject);p.on('exit',c=>c===0?resolve():reject(Error(error)));});
const rows=[];
for(const n of [1,2,3,5]){
 const f=fixture(n,n===1?9:4);
 for(const [i,s] of f.productView.shots.entries()){
  s.path=path.join(out,i+'.mp4');
  await run(config.ffmpegExecutable,['-v','error','-y','-f','lavfi','-i','testsrc2=size=180x320:rate=30:duration='+s.duration,'-vf','hue=h='+i*45,'-c:v','libx264','-preset','ultrafast',s.path]);
 }
 const r=scheduleV2Policy(f);if(r.status!=='success')throw Error(JSON.stringify(r));
 const edl=renderPlansToEdl({scheduledProducts:[{...f.productView,scheduleResult:r}],transitionProfile:'fashion',featureEnabled:true});
 const segments=edl.products[0].segments;const args=segments.flatMap(s=>['-ss',String(s.source_in),'-t',String(s.duration),'-i',s.source_original]);
 const graph=segments.map((s,i)=>'['+i+':v]setpts=PTS-STARTPTS[v'+i+']').join(';')+';'+segments.map((_,i)=>'[v'+i+']').join('')+'concat=n='+segments.length+':v=1:a=0[out]';
 const file=path.join(out,'mode-'+n+'.mp4');
 await run(config.ffmpegExecutable,['-v','error','-y',...args,'-filter_complex',graph,'-map','[out]','-c:v','libx264','-preset','ultrafast',file]);
 await run(config.ffmpegExecutable,['-v','error','-i',file,'-f','null','-']);
 const duration=await verifyEncodedSafeDuration(config.ffprobeExecutable,file);
 rows.push({sources:n,mode:r.mode,planned:r.actualCutDuration,encoded:duration,decode:'pass',openingFallback:r.openingFallback,usedShots:r.shotCount});
}
const short=path.join(out,'short.mp4');await run(config.ffmpegExecutable,['-v','error','-y','-f','lavfi','-i','testsrc2=size=180x320:rate=30:duration=7.5','-c:v','libx264','-preset','ultrafast',short]);
let shortage;try{await verifyEncodedSafeDuration(config.ffprobeExecutable,short);throw Error('short video accepted');}catch(e){if(e.code!=='INSUFFICIENT_SAFE_DURATION')throw e;shortage={code:e.code,available:e.availableSafeDuration,gap:e.durationShortfall,recovery:classifyRecoveryError(e,{providerFailures:[{code:'PROVIDER_TIMEOUT'}]})};if(shortage.recovery.recoverable)throw Error('unexpected retry');}
await writeFile(path.join(out,'report.json'),JSON.stringify({kind:'synthetic isolated encoding, not real product/production canary',rows,shortage,productionDefaultChanged:false,historicalBatchResumed:false},null,2));
console.log(JSON.stringify({rows,shortage},null,2));
