import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fixtures,allocateAutoOotdDuration} from './ootd-repeat-allocation.mjs';
const read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
const base='artifacts/ootd-repeat-20261114',results=[];
for(const [id,fixture] of Object.entries(fixtures)){
 const work='E:/cutflow批量/classic-multisource/'+id,quality=await read(work+'/quality/classic-multisource-quality.v1.json');
 const arms=await Promise.all(['A','B'].map(arm=>read(base+'/'+id+'/'+arm+'-final/final-adopted.json')));
 const edls=arms.map(a=>a.finalEdl.products[0].segments);
 for(const segments of edls)for(const s of segments){
  const d=quality.decisions.find(d=>d.shotId===s.shot_id);
  assert(d&&d.state!=='REJECT'&&quality.admittedShotIds.includes(d.shotId));
  assert(s.source_in>=d.start-1e-6&&s.source_out<=d.end+1e-6);
  assert(!quality.decisions.some(x=>x.sourceId===d.sourceId&&x.state==='REJECT'&&s.source_in<x.end&&s.source_out>x.start));
  assert.equal(s.speed,1);
 }
 const identity=s=>[s.shot_id,s.source_original,s.source_in,s.source_out];
 assert.deepEqual(edls[1].map(identity),edls[0].filter((s,i)=>i!==fixture.omit).map(identity));
 assert(arms[1].adopted&&!arms[1].fallback);
 const manifests=await Promise.all(['A','B'].map(arm=>read(base+'/'+id+'/'+arm+'-final/batch/output/render-manifest.json')));
 assert.equal(manifests[0].files[0].bgm.sourcePath,manifests[1].files[0].bgm.sourcePath);
 for(const key of ['actualHook','actualCTA']){
  assert.equal(manifests[0].files[0].brandCopy[key],manifests[1].files[0].brandCopy[key]);
 }
 assert(manifests[0].files[0].brandCopy.actualHook);
 for(const m of manifests)assert(m.files[0].bgm.audioValidation.meanDb>-60);
 const snapshots=await Promise.all(['A','B'].map(arm=>fs.readFile(base+'/'+id+'/'+arm+'-final/batch/brand-copy-snapshot.v1.json')));
 assert(snapshots[0].equals(snapshots[1]));
 const record={id,pass:true,omittedOriginalIndex:fixture.omit+1,reason:fixture.reason,newProductInformation:'none; retained distinct information becomes less diluted',final:edls.map((segments,i)=>({arm:['A','B'][i],segments})),copySnapshotSha256:createHash('sha256').update(snapshots[0]).digest('hex'),bgm:manifests[0].files[0].bgm.sourcePath};
 results.push(record);
}
// Exercise the optional fixture's duration fallback without writing business state.
const tiny={scheduleResult:{renderPlan:{slots:Array.from({length:5},()=>({slot:{targetDuration:1},shot:{duration:1,reject:false}}))}}};
const baseline=[tiny];assert.strictEqual(allocateAutoOotdDuration({baselineProducts:baseline,context:{taskId:Object.keys(fixtures)[0]}}).products,baseline);
await fs.writeFile(base+'/safety-check.json',JSON.stringify({results,tooShortFallbackPassed:true},null,2));
const media=await read(base+'/verification.json');
const lines=['# 最终实际选镜与时间区间','', '以下由最终渲染EDL与分段帧数生成；源区间为秒，原速1×。编码尾帧可能有一帧量化差异。',''];
for(const r of results){
 lines.push('## '+r.id,'');
 const sources=[...new Set(r.final.flatMap(a=>a.segments.map(s=>s.source_original)))];
 sources.forEach((source,i)=>lines.push('S'+(i+1)+': `'+source+'`',''));
 for(const a of r.final){
  const v=media.find(v=>v.task===r.id&&v.arm===a.arm);
  lines.push('### '+a.arm+' / '+v.probe.streams.find(s=>s.codec_type==='video').duration+'秒','',`[实际MP4](D:/自动剪辑网站/${base}/${r.id}/${a.arm}.mp4)`,'','|镜头|来源|源入点|源出点|实际编码时长|','|---|---|---:|---:|---:|');
  a.segments.forEach((s,i)=>lines.push(`|${i+1}|S${sources.indexOf(s.source_original)+1}|${s.source_in}|${s.source_out}|${v.actualDurations[i]}|`));
  lines.push('');
 }
}
await fs.writeFile(base+'/SHOT-LISTS.md',lines.join('\n'));
console.log('PASS 4 final EDLs: admission, REJECT exclusion, unchanged retained endpoints, original speed, same brand snapshot/BGM; short candidate retains A');
