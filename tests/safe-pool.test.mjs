import test from 'node:test';
import assert from 'node:assert/strict';
import {chooseSafePool} from '../worker/guided-safe-pool.mjs';
const shot=(id,source,start,v)=>({id,source,path:source+'.mp4',start,end:start+3,duration:3,tags:[],reject:false,productVisibility:v});
const entry=s=>({shot:s,slot:{id:s.id,targetDuration:3}});
function fixture(){
 const shots=[shot('a','one',0,.4),shot('b','one',4,.4),shot('c','one',8,.4),shot('better','two',0,.95)];
 return {view:{shots},record:{taskId:'safe',sources:[{id:'one',productId:'sku'},{id:'two',productId:'sku'}]},baseline:{status:'success',renderPlan:{id:'base',slots:shots.slice(0,3).map(entry)}}};
}
test('a safe shot outside every old plan remains selectable without template tags',()=>{const x=fixture(),r=chooseSafePool(x);assert.equal(r.status,'success');assert(r.renderPlan.slots.some(e=>e.shot.id==='better'));assert.equal(r.selectionAudit.poolSelection.consideredShotIds.length,4);});
test('single source, unusable evidence, and optional budgets preserve success',()=>{const x=fixture();x.view.shots.forEach(s=>s.source='one');assert.strictEqual(chooseSafePool(x),x.baseline);const y=fixture();y.semanticEvidence={records:[{shotId:'better',wrongSku:true}]};assert(!chooseSafePool(y).renderPlan.slots.some(e=>e.shot.id==='better'));});
test('wrong product is not combined and source ranges do not expand',()=>{const x=fixture();x.record.sources[1].productId='other';assert.strictEqual(chooseSafePool(x),x.baseline);const y=fixture(),r=chooseSafePool(y);for(const e of r.renderPlan.slots){const s=y.view.shots.find(s=>s.id===e.shot.id);assert(e.shot.start>=s.start&&e.shot.end<=s.end);}});
