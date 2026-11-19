import test from 'node:test';
import assert from 'node:assert/strict';
import { scheduleClassicMultisource } from '../worker/classic-multisource-executor.mjs';

test('unmatched template fallback preserves a viable take rather than concatenating alternatives', () => {
  const sources=['A','B'].map((id,i)=>({id,order:i+1,bindingKey:'p',absolutePath:`D:/${id}.mp4`}));
  const shots=sources.flatMap(s=>[0,3,6].map(start=>({id:`${s.id}${start}`,source:s.id,path:s.absolutePath,
    start,end:start+3,duration:3,tags:s.id==='A'?['quality:review']:[],reject:false,origin:'real',
    productVisibility:.8,productCentered:true,motionEnergy:'medium'})));
  const schedule=pool=>scheduleClassicMultisource({record:{taskId:'offline',sources},shotPool:{version:1,shots:pool},
    scriptTemplate:{id:'template',name:'missing-role',totalDuration:10,slots:[{id:'hook',label:'hook',requireTags:['absent'],targetDuration:10}]}})[0].scheduleResult;
  const result=schedule(shots);
  assert.equal(result.status,'success');
  assert.deepEqual(result.renderPlan.slots.map(s=>s.shot.source),['B','B','B']);
  assert.equal(result.renderPlan.slots.reduce((sum,s)=>sum+s.slot.targetDuration,0),9);
  // No viable source: retain the existing partial-material fallback.
  assert.equal(schedule(shots.filter(s=>s.start<6)).status,'success');
  // Single-source path remains usable.
  assert.equal(schedule(shots.filter(s=>s.source==='A')).status,'success');
});

test('unboxing uses bounded confirmed narrative while preserving mixed source metadata',()=>{
 const sources=[{id:'A',order:1,bindingKey:'p',absolutePath:'D:/A.mp4',videoType:'unboxing'}, {id:'B',order:2,bindingKey:'p',absolutePath:'D:/B.mp4',videoType:'ootd'}];
 const shots=Array.from({length:12},(_,i)=>({id:'x'+i,source:'A',path:'D:/A.mp4',start:i,end:i+1,duration:1,tags:[],reject:false,origin:'real',productVisibility:i<4?.1:.9,productCentered:true,motionEnergy:'medium',...(i<3?{unboxingAction:{action:'opening',confidence:.95,evidence_frames:[0,2]}}:{})}));
 const result=scheduleClassicMultisource({record:{taskId:'offline',sources},shotPool:{version:1,shots},scriptTemplate:{id:'t',name:'t',totalDuration:10,slots:[{id:'hook',label:'hook',requireTags:['absent'],targetDuration:10}]}})[0].scheduleResult;
 assert.equal(result.status,'success');const selected=result.renderPlan.slots.map(s=>s.shot.id);
 assert(selected.includes('x0'));assert(!selected.includes('x3'));assert(!selected.includes('x2'));
 assert.deepEqual(sources.map(s=>s.videoType),['unboxing','ootd']);
});
