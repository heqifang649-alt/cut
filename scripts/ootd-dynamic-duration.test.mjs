import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {allocateOotdDuration} from '../worker/ootd-dynamic-duration.mjs';
const read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
const id='2a4ec2a9-436e-4f46-a490-ab99035e3a83';
const products=(await read(`E:/cutflow批量/classic-multisource/${id}/edit/multisource-schedule-result.json`)).scheduledProducts;
const final=(await read(`artifacts/ootd-dynamic-duration-20261113/edit/${id}/A-final/final-adopted.json`)).finalEdl.products[0].segments;
const baselineProducts=structuredClone(products);
baselineProducts[0].scheduleResult.renderPlan.slots.forEach((e,i)=>{
 e.shot={...e.shot,start:final[i].source_in,end:final[i].source_out,duration:final[i].duration};e.slot.targetDuration=final[i].duration;
});
const evidence=await read(`artifacts/ootd-dynamic-duration-20261113/edit/${id}/local-evidence.json`);
const context={templateId:'1527e301-7707-449d-8e7c-d27014080c8d',postDeployment:true,types:['ootd','ootd']};
const call=(extra={})=>allocateOotdDuration({products,baselineProducts,evidence,context,...extra});
test('only reviewed endpoints change; input, five identities and order preserved',()=>{
 const before=JSON.stringify({products,baselineProducts,evidence});const r=call();
 assert.equal(r.audit.state,'candidate');assert.equal(JSON.stringify({products,baselineProducts,evidence}),before);
 assert.deepEqual(r.products[0].scheduleResult.renderPlan.slots.map(e=>e.shot.id),products[0].scheduleResult.renderPlan.slots.map(e=>e.shot.id));
 assert.deepEqual(r.audit.changes.filter(e=>e.proof).map(e=>e.index),[0,4]);
 for(let i of [1,2,3])assert.deepEqual(r.products[0].scheduleResult.renderPlan.slots[i],baselineProducts[0].scheduleResult.renderPlan.slots[i]);
});
test('missing evidence and stale fingerprints keep original',()=>{
 assert.strictEqual(call({evidence:{}}).products,baselineProducts);
 const stale=structuredClone(evidence);for(const e of Object.values(stale.shots))e.sampleFingerprint='changed';
 assert.strictEqual(call({evidence:stale}).products,baselineProducts);
});
test('single, mixed, unboxing, other template, predeployment remain unchanged',()=>{
 for(const c of [{...context,types:['ootd']},{...context,types:['ootd','unboxing']},{...context,types:['unboxing','unboxing']},{...context,templateId:'other'},{...context,postDeployment:false}])assert.strictEqual(call({context:c}).products,baselineProducts);
});
test('existing guided fallback is never replaced by a resurrected five-slot plan',()=>{
 const b=structuredClone(baselineProducts);b[0].scheduleResult.renderPlan.slots.splice(3);
 assert.equal(call({baselineProducts:b}).audit.reason,'existing_template_fallback_keep_original');
});
test('known internal cut prevents extension',()=>{
 const e=structuredClone(evidence);e.shots[products[0].scheduleResult.renderPlan.slots[4].shot.id].internalCuts=[{confidence:'high',time:9.8}];
 assert.equal(call({evidence:e}).audit.reason,'source_cut_guard');
});
test('less than eight seconds falls back without throwing',()=>{
 const b=structuredClone(baselineProducts);for(let i of [1,2,3])b[0].scheduleResult.renderPlan.slots[i].slot.targetDuration=1;
 assert.equal(call({baselineProducts:b}).audit.reason,'duration_guard');
});
test('selection identity mismatch keeps original',()=>{
 const b=structuredClone(baselineProducts);b[0].scheduleResult.renderPlan.slots[0].shot.source='other';
 assert.equal(call({baselineProducts:b}).audit.reason,'selection_identity_guard');
});
