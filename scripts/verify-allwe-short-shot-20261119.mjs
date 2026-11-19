import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {verifyTemplateOutputs,probeFrameClock,scanFinalTemplateCuts,finalShotBoundaries} from '../worker/ootd-template-render.mjs';
import {assertFinalShots} from '../worker/ootd-min-shot.mjs';
const run=promisify(execFile),root='D:/CUT-Releases/20261030-production-first-r11',dest=path.resolve('.project-governance/evidence/allwe-short-shot-20261119');
const read=async p=>JSON.parse(await fs.readFile(p,'utf8')),hash=async p=>createHash('sha256').update(await fs.readFile(p)).digest('hex');
const runtime=await read(root+'/config/cutflow-runtime.json'),cases=[];
for(const id of ['e4d39e41-f684-4e64-8dad-0cbaa867d3ca','2863bcc1-ff81-4ed3-ae2f-4ea1c88a09fe']){
 const editDir=dest+'/'+id,a=await read(editDir+'/audit.json'),manifest=await read('E:/cutflow批量/classic-multisource/'+id+'/output/render-manifest.json');
 await verifyTemplateOutputs({root,editDir,ffmpeg:runtime.ffmpegExecutable,batch:{colorStrategy:'none'}},manifest);
 const r=(await read(editDir+'/ootd-final-shot-check.json')).reports[0];assert.deepEqual(r.boundaries,[0,73,130,185,230,313]);assert.equal(r.encodedLayoutProven,true);
 assert.equal(await hash(a.output),a.outputSha256);
 await run(runtime.ffmpegExecutable,['-nostdin','-v','error','-xerror','-i',a.output,'-f','null','-'],{windowsHide:true});
 // Deliver locally only, never publish to the real NAS or update a real task.
 const delivery=editDir+'/isolated-delivery.mp4';await fs.copyFile(a.output,delivery);assert.equal(await hash(delivery),a.outputSha256);
 cases.push({name:id,originalReproduced:a.failure.message==='FINAL_MP4_SHORT_SHOT_REFUSE',pass:true,boundaries:r.boundaries,durations:r.shots.map(s=>s.duration),proof:r.terminalPadding,isolatedDeliverySha256:await hash(delivery)});
}
for(const name of ['one-frame-flash','two-distinct-transitions','terminal-one-frame-flash']){
 const file=path.resolve('.project-governance/evidence/final-shot-boundary-20261117-r2/installed-regression/'+name+'.mp4');
 const clock=await probeFrameClock(runtime.ffprobeExecutable,file),cuts=await scanFinalTemplateCuts({ffmpeg:runtime.ffmpegExecutable,file,clock});
 const r=finalShotBoundaries({clock,segments:[{output_in:0}],cuts,encodedCounts:[clock.frameCount]});assert.throws(()=>assertFinalShots(r.shots),/FINAL_MP4_SHORT_SHOT_REFUSE/);
 cases.push({name,actualEncodedMp4:true,rejected:true});
}
// Same frame-count discrepancy but an INTERNAL dropped frame must not acquire
// trusted layout. The complete retained-prefix comparison must fail.
const id='e4d39e41-f684-4e64-8dad-0cbaa867d3ca',a=await read(dest+'/'+id+'/audit.json'),editDir=dest+'/'+id;
const list=dest+'/counterexample-concat.txt';await fs.writeFile(list,a.clips.map(c=>`file '${c.path.replaceAll('\\','/')}'`).join('\n'));
for(const [name,filter]of [['internal-drop',"select=not(eq(n\\,100)),setpts=N/30/TB"],['internal-flash',"drawbox=enable=eq(n\\,100):color=white:t=fill,trim=end_frame=313,setpts=N/30/TB"]]){
 const file=dest+'/'+name+'.mp4';await run(runtime.ffmpegExecutable,['-nostdin','-v','error','-y','-f','concat','-safe','0','-i',list,'-vf',filter,'-an','-c:v','libx264','-crf','18',file],{windowsHide:true});
 await assert.rejects(verifyTemplateOutputs({root,editDir,ffmpeg:runtime.ffmpegExecutable,batch:{colorStrategy:'none'}},{files:[{storagePath:file,relativePath:name+'.mp4',productId:'nerdywave'}]}),/FINAL_MP4_SHORT_SHOT_REFUSE/);
 const r=(await read(editDir+'/ootd-final-shot-check.json')).reports[0];assert.equal(r.encodedLayoutProven,false);
 await fs.copyFile(editDir+'/ootd-final-shot-check.json',dest+'/'+name+'-rejection.json');
 cases.push({name,actualEncodedMp4:true,rejected:true,prefixProofRefused:true});
}
// Restore the real successful report after counterexample inspection.
await verifyTemplateOutputs({root,editDir,ffmpeg:runtime.ffmpegExecutable,batch:{colorStrategy:'none'}},await read('E:/cutflow批量/classic-multisource/'+id+'/output/render-manifest.json'));
await fs.writeFile(dest+'/verification.json',JSON.stringify({cases,productionModified:false,paidCalls:0,realAllweConsumption:'unconfirmed'},null,2));console.log(JSON.stringify(cases,null,2));
