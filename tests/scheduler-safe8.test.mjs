import test from 'node:test';
import assert from 'node:assert/strict';
import { scheduleV2Policy, SCHEDULER_V2_POLICY } from '../worker/scheduler-v2-policy.mjs';
import { routeProductSchedule } from '../worker/scheduler-policy-router.mjs';
import { renderPlansToEdl, verifyEncodedSafeDuration } from '../worker/batch-renderer.mjs';
import { enforceMinimumSafeDuration, scheduleProductView } from '../worker/shot-scheduler.mjs';
import { assertMultisourceOutputDuration, scheduleClassicMultisource } from '../worker/classic-multisource-executor.mjs';
function fixture(n = 2, duration = 3) {
  const shots = Array.from({ length: n }, (_, i) => ({ id: `s${i}`, source: `camera:${i}.mp4`, path: `D:/media/${i}.mp4`, start: 0, end: duration, duration, tags: [], reject: false, origin: "real", productVisibility: 0.9, productCentered: true, motionEnergy: "medium" }));
  return { batchId: "batch", targetDuration: 10, durationCap: 13, allowPartial: true,
    scriptTemplate: { id: "t", name: "t", totalDuration: 10, slots: [{ id: "hook", label: "hook", requireTags: [], targetDuration: 3 }] },
    productView: { product: { id: "p", label: "p", files: shots.map((_, i) => `${i}.mp4`) }, sourceNamesByShotId: Object.fromEntries(shots.map((s, i) => [s.id, `${i}.mp4`])), shots },
    semanticEvidence: { batchId: "batch", complete: true, records: shots.map((s) => ({ shotId: s.id, status: "scored", result: { schema_version: "semantic-shot.v1", shot_id: s.id, shot_type: "other", product_match: 0.9, clothing_visibility: 0.9, visual_quality: 0.8, hook_value: 0.1, usable: true, confidence: 0.9 } })) } };
}

for (const n of [1,2,3,5,30]) test('safe8 source count '+n,()=>{
 const f=fixture(n, n===1?9:4); const r=scheduleV2Policy(f);
 assert.equal(r.status,'success'); assert.equal(r.mode,n===1?'single':'multi'); assert.equal(r.safeSourceCount,n);
 assert.ok(r.actualCutDuration>=8); assert.ok(r.actualCutDuration<=13);
 const edl=renderPlansToEdl({scheduledProducts:[{...f.productView,scheduleResult:r}],transitionProfile:'fashion',featureEnabled:true});
 assert.equal(edl.products[0].duration_seconds,r.actualCutDuration); assert.ok(edl.products[0].segments.every(s=>s.speed===1));
 assert.ok(r.shotCount<=3); assert.equal(r.openingFallback,true);
 assert.deepEqual(scheduleV2Policy(f),r);
});
test('partial failure downgrades to one source without waiting',()=>{
 const f=fixture(3,9); f.semanticEvidence.records[1].verdict='REJECT'; f.semanticEvidence.records.pop();
 const r=scheduleV2Policy(f); assert.equal(r.status,'success'); assert.equal(r.mode,'single'); assert.equal(r.safeSourceCount,1); assert.equal(r.degradation,'partial_safe_sources');
});
test('shortfall is terminal, final minimum is not per shot',()=>{
 for(const n of [1,2,3,5]){ const r=scheduleV2Policy(fixture(n,7.5/n)); assert.equal(r.reason,'INSUFFICIENT_SAFE_DURATION'); assert.equal(r.availableSafeDuration,7.5); assert.equal(r.durationShortfall,.5); assert.equal(r.retryable,false); }
 assert.equal(scheduleV2Policy(fixture(5,1.6)).actualCutDuration,8);
 assert.equal(scheduleV2Policy({...fixture(2,5),targetDuration:3}).actualCutDuration,8);
 assert.equal(scheduleV2Policy({...fixture(2,5),durationCap:7}).durationShortfall,1);
});
test('reject review wrong sku stay excluded',()=>{
 for(const change of [r=>r.verdict='REJECT',r=>r.verdict='REVIEW',r=>r.wrongSku=true,r=>r.autoUse=false]){
 const f=fixture(2,9);change(f.semanticEvidence.records[1]);const r=scheduleV2Policy(f);assert.equal(r.mode,'single');assert.deepEqual(r.selections.map(s=>s.shotId),['s0']); }
});
test('hook preferred but never mandatory; unused sources allowed',()=>{
 const f=fixture(5,4);f.semanticEvidence.records[3].result.hook_value=.9;const r=scheduleV2Policy(f);assert.equal(r.selections[0].shotId,'s3');assert.equal(r.openingFallback,false);assert.ok(r.shotCount<5);
});
test('new policy requires explicit pin, historical pin stays readable',()=>{
 const f=fixture(1,9);assert.notEqual(routeProductSchedule(f).selected.policyVersion,SCHEDULER_V2_POLICY);
 assert.equal(routeProductSchedule(f,{mode:'enabled',policyPin:{version:SCHEDULER_V2_POLICY,revision:'isolated'}}).selected.mode,'single');
 assert.equal(routeProductSchedule(f,{mode:'enabled',policyPin:{version:'scheduler-v2.0-mva5',revision:'old'}}).selected.policyVersion,'scheduler-v2.0-mva5');
});

test('split shots from one file count as a single source; unverified repeats cannot pad',()=>{
 const f=fixture(2,4);f.productView.shots[1].path=f.productView.shots[0].path;f.productView.shots[1].start=5;f.productView.shots[1].end=9;f.productView.sourceNamesByShotId.s1='0.mp4';
 f.frameHashesByShot={s0:['same-a','same-b','same-c'],s1:['same-a','same-b','same-c']};
 const r=scheduleV2Policy(f);assert.equal(r.safeSourceCount,1);assert.equal(r.mode,'single');assert.equal(r.reason,'INSUFFICIENT_SAFE_DURATION');assert.equal(r.availableSafeDuration,4);
});
test('single OOTD preserves chronological accepted action and renderer removes artificial adjacent cuts',()=>{
 const f=fixture(3,3);f.productView.product.files=['ootd.mp4'];for(const [i,shot] of f.productView.shots.entries()){shot.path='D:/media/ootd.mp4';shot.start=i*3;shot.end=(i+1)*3;f.productView.sourceNamesByShotId[shot.id]='ootd.mp4';}
 const r=scheduleV2Policy(f);assert.equal(r.status,'success');assert.equal(r.mode,'single');assert.deepEqual(r.selections.map(s=>s.shotId),['s0','s1','s2']);
 const edl=renderPlansToEdl({scheduledProducts:[{...f.productView,scheduleResult:r}]});assert.equal(edl.products[0].segments.length,1);assert.equal(edl.products[0].duration_seconds,9);
});
test('single unboxing keeps safe source order while removing only rejected intervals',()=>{
 const f=fixture(4,3);f.productView.product.files=['unboxing.mp4'];for(const [i,shot] of f.productView.shots.entries()){shot.path='D:/media/unboxing.mp4';shot.start=i*3;shot.end=(i+1)*3;f.productView.sourceNamesByShotId[shot.id]='unboxing.mp4';}
 f.semanticEvidence.records[1].verdict='REJECT';const r=scheduleV2Policy(f);assert.equal(r.status,'success');assert.deepEqual(r.selections.map(s=>s.shotId),['s0','s2','s3']);
 assert.equal(r.actualCutDuration,9);
});
test('single source keeps accepted action beyond the minimum up to the requested duration',()=>{
 const f=fixture(4,3);f.targetDuration=12;f.productView.product.files=['action.mp4'];
 for(const [i,s] of f.productView.shots.entries()){s.path='D:/media/action.mp4';s.start=i*3;s.end=(i+1)*3;f.productView.sourceNamesByShotId[s.id]='action.mp4';}
 const r=scheduleV2Policy(f);assert.equal(r.actualCutDuration,12);assert.equal(r.shotCount,4);
 const edl=renderPlansToEdl({scheduledProducts:[{...f.productView,scheduleResult:r}]});assert.equal(edl.products[0].segments.length,1);
});
test('two accepted single-source intervals survive removal of a rejected middle interval without pair evidence',()=>{
 const f=fixture(3,4);f.productView.product.files=['action.mp4'];
 for(const [i,s] of f.productView.shots.entries()){s.path='D:/media/action.mp4';s.start=i*4;s.end=(i+1)*4;f.productView.sourceNamesByShotId[s.id]='action.mp4';}
 f.semanticEvidence.records[1].verdict='REJECT';const r=scheduleV2Policy(f);
 assert.equal(r.status,'success');assert.equal(r.actualCutDuration,8);assert.deepEqual(r.selections.map(s=>s.shotId),['s0','s2']);
});
test('multi OOTD keeps ad ranking and may use fewer safe sources',()=>{
 const f=fixture(4,4);f.semanticEvidence.records[2].result.hook_value=.95;f.semanticEvidence.records[3].verdict='REVIEW';
 const r=scheduleV2Policy(f);assert.equal(r.status,'success');assert.equal(r.mode,'multi');assert.equal(r.selections[0].shotId,'s2');assert.ok(r.shotCount<4);
});
test('legacy automatic and classic multisource routes cannot bypass safe8',()=>{
 const shots=[0,1].map(i=>({id:'l'+i,source:'s'+i,path:'D:/media/'+i+'.mp4',start:0,end:3.5,duration:3.5,tags:['full_body'],reject:false,origin:'real',productVisibility:.9,productCentered:true,motionEnergy:'medium'}));
 const template={id:'t',name:'t',totalDuration:7,slots:shots.map((_,i)=>({id:i?'body':'hook',label:'x',requireTags:['full_body'],targetDuration:3.5}))};
 const view={product:{id:'p',label:'p',files:['0.mp4','1.mp4']},sourceNamesByShotId:{l0:'0.mp4',l1:'1.mp4'},shots};
 const legacy=enforceMinimumSafeDuration(scheduleProductView({batchId:'b',productView:view,scriptTemplate:template,allowPartial:true}));assert.equal(legacy.reason,'INSUFFICIENT_SAFE_DURATION');
 const record={taskId:'b',acceptedAt:'fixed',sources:shots.map(s=>({bindingKey:'p',absolutePath:s.path}))};
 const multi=scheduleClassicMultisource({record,shotPool:{shots},scriptTemplate:template});assert.equal(multi[0].scheduleResult.reason,'INSUFFICIENT_SAFE_DURATION');
});
test('renderer refuses a tampered final duration instead of padding',()=>{
 const f=fixture(1,9);const r=scheduleV2Policy(f);r.renderPlan.slots[0].slot.targetDuration=7;
 assert.throws(()=>renderPlansToEdl({scheduledProducts:[{...f.productView,scheduleResult:r}]}),e=>e.code==='INSUFFICIENT_SAFE_DURATION'&&e.retryable===false&&e.durationShortfall===1);
});
test('actual encoded video duration gates Review publication at 8 seconds',async()=>{
 const fixture=duration=>verifyEncodedSafeDuration('ffprobe','output.mp4',8,async()=>
  Buffer.from(JSON.stringify({streams:[{duration}]})));
 await assert.rejects(fixture(7.999),error=>error.code==='INSUFFICIENT_SAFE_DURATION'&&error.availableSafeDuration===7.999);
 assert.equal(await fixture(8),8);
});
test('classic multisource publication independently rejects a short probed output',()=>{
 assert.throws(()=>assertMultisourceOutputDuration(7.999),error=>error.code==='INSUFFICIENT_SAFE_DURATION'&&error.retryable===false&&error.durationShortfall>0);
 assert.equal(assertMultisourceOutputDuration(8),8);
});
