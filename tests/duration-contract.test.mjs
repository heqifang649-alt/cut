import test from 'node:test';
import assert from 'node:assert/strict';
import {assertOutputDuration,capRenderPlanDuration,verifyEncodedSafeDuration} from '../lib/output-duration.mjs';
import {enforceMinimumSafeDuration} from '../worker/shot-scheduler.mjs';
import {scheduleGuided,guidedIntervals} from '../worker/libtv-guided-auto.mjs';
import {GUIDED_POLICY} from '../lib/libtv-guided-policy.mjs';
import {renderPlansToEdl} from '../worker/batch-renderer.mjs';
import {isRenderPlan} from '../lib/types.ts';
import {bridgePublicFailure} from '../lib/libtv-auto-policy.mjs';
import {classifyRecoveryError} from '../worker/recovery.mjs';
import {deriveScriptTemplate} from '../worker/ai-ingest.mjs';
const shot=(id,start,duration)=>({id,source:'source',path:'D:/input.mp4',start,end:start+duration,duration,tags:[],reject:false,origin:'real',productVisibility:.9,productCentered:true,motionEnergy:'medium'});
const plan=durations=>({id:'plan',batchId:'b',createdAt:'fixed',slots:durations.map((duration,i)=>({shot:shot('s'+i,i*20,duration),slot:{id:'segment_'+i,label:'display',requireTags:[],targetDuration:duration}}))});
for(const [referenceSeconds,expected] of [[5,8],[30,18]])test('template rhythm scales within the shared range: '+referenceSeconds,()=>{
 const structure=Array.from({length:5},(_,i)=>({timeline:`${i*referenceSeconds/5}-${(i+1)*referenceSeconds/5}`,purpose:'display'}));
 const t=deriveScriptTemplate({id:'b',durationMax:3,referenceProfile:{duration_seconds:referenceSeconds,structure}});
 assert.equal(t.totalDuration,expected);
});
for(const code of ['INSUFFICIENT_SAFE_DURATION','OUTPUT_DURATION_EXCEEDED','RENDER_PLAN_DURATION_INVALID'])test('guided duration code survives public status without pointless retries: '+code,()=>{
 assert.equal(bridgePublicFailure({status:'failed',bridgeErrorCode:code}),code);
 assert.equal(classifyRecoveryError(Object.assign(new Error(code),{code})).recoverable,false);
});
for(const duration of [8,8.001,12.8,17.999,18])test('inclusive final contract accepts '+duration,()=>assert.equal(assertOutputDuration(duration),duration));
for(const [duration,code] of [[7.999,'INSUFFICIENT_SAFE_DURATION'],[7.9999999,'INSUFFICIENT_SAFE_DURATION'],[18.000001,'OUTPUT_DURATION_EXCEEDED'],[18.001,'OUTPUT_DURATION_EXCEEDED'],[30,'OUTPUT_DURATION_EXCEEDED']])test('final contract rejects '+duration,()=>assert.throws(()=>assertOutputDuration(duration),e=>e.code===code&&e.retryable===false));
test('scheduler crops selected safe intervals without extending, slowing or repeating sources',()=>{
 const input=plan([7,7,7,7]),result=enforceMinimumSafeDuration({status:'success',renderPlan:input});
 assert.equal(result.actualCutDuration,18);assert.ok(isRenderPlan(result.renderPlan));
 assert.deepEqual(result.renderPlan.slots.map(e=>e.slot.targetDuration),[7,7,4]);
 assert.equal(input.slots.length,4);assert.equal(new Set(result.renderPlan.slots.map(e=>e.shot.id)).size,3);
 for(const e of result.renderPlan.slots)assert.ok(e.slot.targetDuration<=e.shot.end-e.shot.start);
 const edl=renderPlansToEdl({scheduledProducts:[{product:{id:'p',label:'p',files:['input.mp4']},sourceNamesByShotId:{s0:'input.mp4',s1:'input.mp4',s2:'input.mp4'},scheduleResult:result}]});
 assert.equal(edl.products[0].duration_seconds,18);assert.ok(edl.products[0].segments.every(s=>s.speed===1));
});
test('12.8-second plan remains unchanged despite a short template rhythm',()=>{
 const p=capRenderPlanDuration(plan([3.2,3.2,3.2,3.2]));assert.equal(p.slots.reduce((s,e)=>s+e.slot.targetDuration,0),12.8);
});
test('guided accepts a 40-second original but selects at most 18 actual seconds',()=>{
 assert.equal(guidedIntervals(40,[],30).length,40);
 const shots=Array.from({length:40},(_,i)=>shot('s'+i,i,1));
 const batch={id:'b',libtvSource:{handoffId:'handoff',manifestSha256:'hash',editPolicyReceipt:{state:'accepted',strategy:'guided_auto',policyVersion:GUIDED_POLICY.version,manifestSha256:'hash',policy:GUIDED_POLICY}},requirements:'guided_auto',files:[{id:'source',kind:'products',relativePath:'input.mp4'}],productDetection:{sourcePolicy:{version:GUIDED_POLICY.version,manifestSha256:'hash',handoffId:'handoff'},groups:[{id:'p',label:'p',files:['input.mp4']}]}};
 const prepared={sidecars:[{fileId:'source',videoPath:'D:/input.mp4',segments:shots.map(s=>({...s,fingerprint:s.id}))}]};
 const result=scheduleGuided({batch,shots,prepared});
 assert.equal(result.products[0].scheduleResult.actualCutDuration,18);assert.equal(result.used.length,18);assert.equal(result.excluded.length,22);
});
test('both video and muxed duration must satisfy the final contract',async()=>{
 const probe=(v,f)=>verifyEncodedSafeDuration('ffprobe','output',8,async()=>JSON.stringify({streams:[{duration:v}],format:{duration:f}}));
 assert.equal(await probe(18,18),18);
 await assert.rejects(probe(18,18.001),e=>e.code==='OUTPUT_DURATION_EXCEEDED');
 await assert.rejects(probe(7.999,8),e=>e.code==='INSUFFICIENT_SAFE_DURATION');
});
