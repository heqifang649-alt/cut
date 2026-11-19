import test from 'node:test';import assert from 'node:assert/strict';import {scheduleWebsiteTemplatePilot,WEBSITE_TEMPLATES} from '../worker/allwe-website-template-pilot.mjs';
const runtimeRoot='D:/CUT-Releases/20261030-production-first-r11';
const source=(id,videoType)=>({id,videoType,bindingKey:'p',absolutePath:'D:/'+id+'.mp4'});
const sources=[source('a','ootd'),source('b','ootd')];
const pool={version:1,shots:sources.flatMap(s=>Array.from({length:5},(_,i)=>({id:s.id+i,source:s.id,path:s.absolutePath,start:i*4,end:i*4+4,duration:4,tags:[],reject:false,origin:'real',productVisibility:.9,productCentered:true,motionEnergy:'medium'})))};
for(const type of ['ootd','unboxing',undefined,'unknown'])test('fixed website ID via existing scheduler: '+type,async()=>{
 const record={taskId:'test',acceptedAt:'2026-11-13T00:00:00Z',sources:sources.map(s=>({...s,videoType:type}))};
 const before=structuredClone(record);const out=await scheduleWebsiteTemplatePilot({runtimeRoot,record,shotPool:pool});
 assert.equal(out.templateId,WEBSITE_TEMPLATES[type==='unboxing'?'unboxing':'ootd']);assert.equal(out.fallback,false);assert(out.scheduledProducts.every(p=>p.scheduleResult.status==='success'));
 assert.equal(out.batch.referenceProfile.hook_text,'');assert.equal(out.batch.files,undefined);assert.equal(out.batch.musicSource,undefined);assert.deepEqual(record,before);
 const duration=out.scheduledProducts[0].scheduleResult.renderPlan.slots.reduce((n,s)=>n+s.slot.targetDuration,0);assert(duration>=8&&duration<=18);
});
test('single source and mixed types do not enter unified template',async()=>{
 assert.equal((await scheduleWebsiteTemplatePilot({runtimeRoot,record:{sources:[sources[0]]},shotPool:pool})).state,'unchanged_single_source');
 const mixed=[sources[0],source('b','unboxing')];const out=await scheduleWebsiteTemplatePilot({runtimeRoot,record:{sources:mixed},shotPool:pool});assert.equal(out.state,'unchanged_mixed_unverified');assert.deepEqual(out.types.map(s=>s.videoType),['ootd','unboxing']);
});
test('unready exact ID cannot match another ready display name',async()=>{
 await assert.rejects(scheduleWebsiteTemplatePilot({runtimeRoot,record:{sources},shotPool:pool,templates:[{id:'wrong-id',name:'AI ootd',status:'ready',profile:{structure:[1,2,3,4]}}]}),/DESIGNATED_TEMPLATE_NOT_READY/);
});

test('incomplete structure falls back through existing guided',async()=>{
 const short={version:1,shots:[pool.shots[0],pool.shots[5]]};
 const result=await scheduleWebsiteTemplatePilot({runtimeRoot,record:{taskId:'partial',sources},shotPool:short});
 assert.equal(result.fallback,true);assert.equal(result.scheduledProducts[0].scheduleResult.status,'success');
});
