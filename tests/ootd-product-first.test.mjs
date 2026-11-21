import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { scheduleWebsiteTemplatePilot, WEBSITE_TEMPLATES } from '../worker/allwe-website-template-pilot.mjs';

const runtimeRoot = fileURLToPath(new URL('../', import.meta.url));
const sources = ['a', 'b', 'c'].map(id => ({
  id, videoType: 'ootd', bindingKey: 'garment', absolutePath: `fixture/${id}.mp4`,
}));
const record = { taskId: 'product-first', acceptedAt: '2026-11-21T08:00:00Z', sources };
const shotPool = {
  version: 1,
  shots: sources.flatMap(source => [0, 3.42, 6.84].map((start, index) => ({
    id: `${source.id}-${index}`, source: source.id, path: source.absolutePath,
    start, end: start + 3.2, duration: 3.2, tags: [], reject: false, origin: 'real',
    productVisibility: .85, productCentered: true, motionEnergy: 'medium',
  }))),
};
const templates = [{
  id: WEBSITE_TEMPLATES.ootd, name: 'OOTD fixture', status: 'ready',
  profile: { structure: ['0-2.5', '2.5-5', '5-9', '9-12'].map(timeline => ({ timeline })) },
}];
const input = { runtimeRoot, record, shotPool, templates, ootdProductFirst: true };

test('product-first OOTD puts detail second and keeps an available safe back shot',async()=>{
 const types=['front_full_body','detail','front_full_body','overall','front_full_body','overall','back_full_body','front_full_body','detail'];
 const semanticEvidence={records:shotPool.shots.map((shot,i)=>({shotId:shot.id,status:'accept',result:{
  shot_type:types[i],usable:true,product_match:.95,clothing_visibility:i===7?.99:.8,
  visual_quality:.9,hook_value:.85,confidence:.95,
 }}))};
 for(const missing of [null,'back_full_body','detail']){
  const evidence={records:semanticEvidence.records.filter(entry=>entry.result.shot_type!==missing)};
  const result=await scheduleWebsiteTemplatePilot({...input,semanticEvidence:evidence});
  assert.equal(result.fallback,false);
  const slots=result.scheduledProducts[0].scheduleResult.renderPlan.slots;
  assert.equal(slots[0].slot.id,'hook');
  if(missing!=='detail')assert.equal(slots[1].slot.id,'sleeve_fabric_reason');
  else assert(!slots.some(entry=>entry.slot.id==='sleeve_fabric_reason'));
  if(missing!=='back_full_body')assert.equal(slots.at(-1).shot.id,shotPool.shots[6].id);
 }
});
test('OOTD opens on a larger back print only with reliable same-garment evidence', async () => {
 const types=['front_full_body','detail','front_full_body','overall','front_full_body','overall','back_full_body','front_full_body','detail'];
 const largerBack={frontIndex:0,backIndex:1,dominance:'back',confidence:.96};
 for (const [pairedPrint, frontPair, confidence, expected] of [
  [largerBack, undefined, .95, 'back_full_body'],
  [{...largerBack, dominance:'similar'}, undefined, .95, 'front_full_body'],
  [largerBack, {...largerBack, dominance:'front'}, .95, 'front_full_body'],
  [largerBack, undefined, .6, 'front_full_body'],
  [undefined, undefined, .95, 'front_full_body'],
 ]) {
  const shots=shotPool.shots.map((shot,i)=>({...shot,ootdComposition:{
   shotType:types[i],framing:'medium',confidence:i===6?confidence:.95,printProminence:i===6?.92:.35,
   pairedPrint:i===6?pairedPrint:i===0?frontPair:undefined,
  }}));
  const result=await scheduleWebsiteTemplatePilot({...input,shotPool:{...shotPool,shots}});
  const {slots}=result.scheduledProducts[0].scheduleResult.renderPlan;
  assert.equal(slots[0].shot.ootdComposition.shotType,expected);
  assert.equal(slots[1].slot.id,'sleeve_fabric_reason');
  assert(slots[0].slot.targetDuration<3);
  assert(slots.some(({shot})=>shot.ootdComposition.shotType==='back_full_body'));
  assert(slots.some(({shot})=>shot.ootdComposition.shotType==='front_full_body'));
 }
});
