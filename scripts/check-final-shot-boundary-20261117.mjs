import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const run=promisify(execFile),dir=path.resolve('.project-governance/evidence/final-shot-boundary-20261117');
const root=process.argv[2]||path.join(dir,'candidate');
const mod=await import(pathToFileURL(path.join(root,'worker/ootd-template-render.mjs')));
const real='E:/cutflow批量/classic-multisource/f920ee53-ef37-4cc2-afb8-2622a34cb628';
const runtime=JSON.parse(await fs.readFile(path.join(root,'config/cutflow-runtime.json'),'utf8'));
const hash=async p=>createHash('sha256').update(await fs.readFile(p)).digest('hex');
const read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
const out=path.join(dir,process.argv[2]?'installed-regression':'offline-regression');
await fs.mkdir(out,{recursive:true});
const edl=await read(real+'/edit/render-plan-edl.json');
await fs.writeFile(path.join(out,'render-plan-edl.json'),JSON.stringify(edl));
await fs.cp(real+'/edit/clips_graded',path.join(out,'clips_graded'),{recursive:true});
const file=real+'/output/tokyotiger.mp4',before=await hash(file);
const manifest=await read(real+'/output/render-manifest.json');
await mod.verifyTemplateOutputs({root,editDir:out,ffmpeg:runtime.ffmpegExecutable,batch:{colorStrategy:'none'}},manifest);
const report=await read(path.join(out,'ootd-final-shot-check.json'));
assert.equal(report.reports[0].encodedLayoutProven,true);assert.deepEqual(report.reports[0].boundaries,[0,74,131,185,230,315]);
// Check all encoded frames against the exact concat inputs in an overlay-free
// central region. This is a local correspondence check, not a creative verdict.
const decode=async file=>(await run(runtime.ffmpegExecutable,['-nostdin','-v','error','-i',file,'-vf','crop=iw*.4:ih*.4:iw*.3:ih*.25,scale=64:64,format=gray','-fps_mode','passthrough','-an','-f','rawvideo','pipe:1'],{windowsHide:true,encoding:'buffer',maxBuffer:8*1024*1024})).stdout;
const finalFrames=await decode(file),concat=await fs.readFile(real+'/edit/clips_graded/tokyotiger/concat.txt','utf8');
const clips=[...concat.matchAll(/^file '(.*)'$/gm)].map(m=>m[1]);assert.equal(clips.length,5);
const correspondence=[];let offset=0;
for(const [i,clip]of clips.entries()){
 const frames=await decode(clip);assert.equal(frames.length,report.reports[0].plans[i].encodedCount*4096);
 let sum=0,maxFrameMae=0;for(let f=0;f<frames.length/4096;f++){let error=0;for(let p=0;p<4096;p++)error+=Math.abs(frames[f*4096+p]-finalFrames[offset+f*4096+p])/255;const mae=error/4096;sum+=mae;maxFrameMae=Math.max(maxFrameMae,mae);}
 assert.ok(maxFrameMae<.08,'Encoded content mismatch: segment '+(i+1));correspondence.push({segment:i+1,frames:frames.length/4096,startFrame:offset/4096,meanMae:sum/(frames.length/4096),maxFrameMae});offset+=frames.length;
}assert.equal(offset,finalFrames.length);
// Render deterministic native-frame counterexamples. No provider or production task.
const fixtures=[];
for(const [name,filter]of [
 ['one-frame-flash',"if(eq(N,60),255,0)"],
 ['two-distinct-transitions',"if(lt(N,60),0,if(lt(N,61),255,100))"]
]){
 const target=path.join(out,name+'.mp4');
 await run(runtime.ffmpegExecutable,['-nostdin','-v','error','-y','-f','lavfi','-i',`nullsrc=s=96x96:r=30:d=4,format=gray,geq=lum='${filter}'`,'-c:v','libx264','-pix_fmt','yuv420p',target],{windowsHide:true});
 const clock=await mod.probeFrameClock(runtime.ffprobeExecutable,target);
 const cuts=await mod.scanFinalTemplateCuts({ffmpeg:runtime.ffmpegExecutable,file:target,clock});
 assert.ok(cuts.some(c=>c.frame===60),name+': missing first cut');assert.ok(cuts.some(c=>c.frame===61),name+': missing second cut');
 const r=mod.finalShotBoundaries({clock,segments:[{output_in:0}],cuts,encodedCounts:[120]});
 const {assertFinalShots}=await import(pathToFileURL(path.join(root,'worker/ootd-min-shot.mjs')));
 assert.throws(()=>assertFinalShots(r.shots),/FINAL_MP4_SHORT_SHOT_REFUSE/);fixtures.push({name,cuts,boundaries:r.boundaries,refused:true});
}
const quality=await read(real+'/quality/classic-multisource-quality.v1.json');
const overlaps=[];for(const s of edl.products[0].segments){const d=quality.decisions.find(d=>d.shotId===s.shot_id);assert.ok(d);assert.ok(s.source_in>=d.start-.000001&&s.source_out<=d.end+.000001);for(const reject of quality.decisions.filter(item=>item.state==='REJECT'&&item.sourceId===d.sourceId)){if(Math.max(s.source_in,reject.start)<Math.min(s.source_out,reject.end))overlaps.push({segment:s.segment_id,reject});}}
assert.equal(overlaps.length,0);assert.equal(await hash(file),before);
const result={at:new Date().toISOString(),root,realMp4Sha256:before,real:report.reports[0],correspondence,fixtures,rejectCount:quality.decisions.filter(d=>d.state==='REJECT').length,rejectOverlap:overlaps,reviewSegments:edl.products[0].segments.filter(s=>quality.decisions.find(d=>d.shotId===s.shot_id)?.state==='REVIEW').map(s=>s.segment_id),providerCalls:0,productionBusinessWrites:0};
await fs.writeFile(path.join(out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({realPassed:true,boundaries:result.real.boundaries,fixtures:fixtures.map(f=>({name:f.name,refused:f.refused})),rejectCount:result.rejectCount,reviewSegments:result.reviewSegments}));
