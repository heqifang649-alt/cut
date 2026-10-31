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
