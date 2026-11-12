import test from 'node:test';
import assert from 'node:assert/strict';
import {chooseGuidedComposition} from '../worker/guided-composition-v23.mjs';
import {classicGuidedCanaryMode} from '../worker/classic-multisource-executor.mjs';
const entry=(id,source,start,visibility=.6,role)=>({shot:{id,source,path:source+'.mp4',start,end:start+3,duration:3,productVisibility:visibility,tags:role?[role]:[],reject:false},slot:{id:'slot-'+id,targetDuration:3}});
const plan=slots=>({status:'success',renderPlan:{id:'plan',batchId:'test',slots}});
const fixture=()=>{
 const slots=[entry('a','one',0,.4,'overall'),entry('b','two',0,.6,'detail'),entry('c','one',4,.6,'back_full_body')];
 return {baseline:plan(slots),view:{shots:slots.map(e=>e.shot)},record:{sources:[{id:'one',productId:'sku'},{id:'two',productId:'sku'}]},editingEvidence:{shots:{}}};
};
test('single-source route preserves identity',()=>{const x=fixture();x.view.shots.forEach(s=>s.source='one');assert.strictEqual(chooseGuidedComposition(x),x.baseline);});
test('higher visibility can replace weaker source without an early-source bias',()=>{const x=fixture(),e=entry('better','one',0,.95,'overall');x.view.shots.push(e.shot);x.candidates=[{result:plan([e,...x.baseline.renderPlan.slots.slice(1)])}];const r=chooseGuidedComposition(x);assert.equal(r.renderPlan.slots[0].shot.id,'better');assert.deepEqual(r.renderPlan.slots[0],e);});
test('source identity, chronological order and SKU constraints never become optional',()=>{const x=fixture();x.candidates=[{result:plan([...x.baseline.renderPlan.slots].reverse())}];const r=chooseGuidedComposition(x);assert(r.renderPlan.slots.findIndex(e=>e.shot.id==='a')<r.renderPlan.slots.findIndex(e=>e.shot.id==='c'));const y=fixture();y.record.sources[1].productId='other';assert.strictEqual(chooseGuidedComposition(y),y.baseline);});
test('missing semantic tags and similarity does not reject existing success',()=>{const x=fixture();x.baseline.renderPlan.slots.forEach(e=>{e.shot.tags=[];delete e.shot.productVisibility});assert.equal(chooseGuidedComposition(x).status,'success');});
test('known same-angle detail with new information is retained',()=>{const x=fixture();const r=chooseGuidedComposition(x);assert(r.renderPlan.slots.some(e=>e.shot.tags.includes('detail')));assert(r.renderPlan.slots.some(e=>e.shot.tags.includes('back_full_body')));});
test('malformed evidence and oversized optional search retain baseline',()=>{const x=fixture();x.candidates=Array(33).fill(x.baseline);assert.strictEqual(chooseGuidedComposition(x),x.baseline);const y=fixture();y.semanticEvidence={records:{invalid:true}};assert.strictEqual(chooseGuidedComposition(y),y.baseline);});
test('duplicate aliases and expanding source candidates cannot enter',()=>{const x=fixture(),e=structuredClone(x.baseline);e.renderPlan.slots[1].shot.start=-1;x.candidates=[{result:e}];const r=chooseGuidedComposition(x);assert(r.renderPlan.slots.every(e=>e.shot.start>=0));});
test('contiguous same-source entries stay in one ordered block',()=>{const x=fixture();x.baseline.renderPlan.slots[2].shot.start=3;x.baseline.renderPlan.slots[2].shot.end=6;x.baseline.renderPlan.slots=[x.baseline.renderPlan.slots[0],x.baseline.renderPlan.slots[2],x.baseline.renderPlan.slots[1]];const r=chooseGuidedComposition(x);const ids=r.renderPlan.slots.map(e=>e.shot.id);assert.equal(ids.indexOf('c'),ids.indexOf('a')+1);});
test('300 deterministic ordinary pools preserve success, time bounds and exact entries',()=>{
 for(let seed=0;seed<300;seed++){
  const x=fixture();x.baseline.renderPlan.slots.forEach((e,i)=>e.shot.productVisibility=((seed*37+i*13)%100)/100);
  x.candidates=[{result:plan([x.baseline.renderPlan.slots[1],x.baseline.renderPlan.slots[0],x.baseline.renderPlan.slots[2]])}];
  const r=chooseGuidedComposition(x);assert.equal(r.status,'success');
  assert.equal(r.renderPlan.slots.reduce((n,e)=>n+e.slot.targetDuration,0),9);
  for(const e of r.renderPlan.slots)assert(x.baseline.renderPlan.slots.some(b=>JSON.stringify(b)===JSON.stringify(e)));
 }
});
test('v23 cannot activate for single source, wrong task, owner or brand',()=>{
 const id='11111111-1111-4111-8111-111111111111',hash='a'.repeat(64);
 const record={taskId:id,manifestSha256:hash,contractVersion:'libtv-cut-lan-multi/2',sources:[{},{}],attempt:0,userId:'employee',sourceBinding:{kind:'brand',value:'TT'}};
 const env={CUTFLOW_GUIDED_CANARY_ONCE:'true',CUTFLOW_GUIDED_SELECTION_MODE:'fusion-v2.3',CUTFLOW_GUIDED_CANARY_TASK_ID:id,CUTFLOW_GUIDED_CANARY_MANIFEST_SHA256:hash,CUTFLOW_GUIDED_CANARY_OWNER_USER_ID:'employee',CUTFLOW_GUIDED_CANARY_BRAND:'TT'};
 assert.equal(classicGuidedCanaryMode(record,env),'fusion-v2.3');
 for(const change of [{sources:[{}]},{userId:'other'},{taskId:'22222222-2222-4222-8222-222222222222'},{sourceBinding:{kind:'brand',value:'GC'}}])assert.equal(classicGuidedCanaryMode({...record,...change},env),'original');
});
test('a source cut outside the effective opening does not invent an advantage',()=>{
 const x=fixture();x.baseline.renderPlan.slots[0].shot.productVisibility=.95;x.baseline.renderPlan.slots[0].slot.targetDuration=2.7;
 x.editingEvidence.shots.a={internalCuts:[{confidence:'high',time:2.9}]};
 const c=structuredClone(x.baseline);c.renderPlan.slots[0].shot.end=2.7;c.renderPlan.slots[0].shot.duration=2.7;
 x.candidates=[{result:c}];assert.strictEqual(chooseGuidedComposition(x),x.baseline);
});
test('evidenced cross-source repetition is a preference, and new detail survives',()=>{
 const x=fixture(),s=[entry('o1','one',0,.8,'overall'),entry('o2','two',0,.8,'overall'),entry('d','one',4,.8,'detail'),entry('back','two',4,.8,'back_full_body')];
 for(const e of s){e.shot.angle='front';e.shot.action='hold';e.shot.shotScale='medium';}
 x.baseline=plan(s);x.view.shots=s.map(e=>e.shot);x.candidates=[{result:plan([s[0],s[2],s[3]])}];
 const r=chooseGuidedComposition(x);assert(r.selectionAudit.composition.after.metrics.repeat<r.selectionAudit.composition.before.metrics.repeat);
 assert(r.renderPlan.slots.some(e=>e.shot.id==='d'));
});
test('an existing candidate cannot insert another source inside a continuous action',()=>{
 const x=fixture(),a=entry('a','one',0,.9,'overall'),c=entry('c','one',3,.9,'back_full_body'),b=entry('b','two',0,.2,'detail');
 x.baseline=plan([a,c,b]);x.view.shots=[a.shot,c.shot,b.shot];
 x.candidates=[{kind:'split-action',result:plan([a,b,c])}];
 const r=chooseGuidedComposition(x),ids=r.renderPlan.slots.map(e=>e.shot.id);
 assert.equal(ids.indexOf('c'),ids.indexOf('a')+1);
});
test('reordered product information is not new information',()=>{
 const x=fixture(),s=[entry('o1','one',0,.8,'overall'),entry('o2','two',0,.8,'overall'),entry('d','one',4,.8,'detail'),entry('back','two',4,.8,'back_full_body')];
 for(const e of s){e.shot.angle='front';e.shot.action='hold';e.shot.shotScale='medium';}
 s[0].shot.productInformation=['print','fabric'];s[1].shot.productInformation=['fabric','print'];
 x.baseline=plan(s);x.view.shots=s.map(e=>e.shot);x.candidates=[{result:plan([s[0],s[2],s[3]])}];
 const r=chooseGuidedComposition(x);
 assert(r.selectionAudit.composition.before.metrics.repeat>=1/3);
});
