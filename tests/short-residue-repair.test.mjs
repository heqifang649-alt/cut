import test from 'node:test';
import assert from 'node:assert/strict';
import {repairKnownShortResidues,RESIDUE_LIMITS,describeShortResidueFailure} from '../lib/short-residue-repair.mjs';
const entry=(id,start=0,duration=2,end=3,path=id+'.mp4')=>({shot:{id,source:id,path,start,end,duration:end-start,videoType:'ootd',reject:false},slot:{id,targetDuration:duration}});
function fixture(slots=[entry('a')],cuts=[.04]){
 const shots=slots.map(e=>structuredClone(e.shot)),decisions=shots.map(s=>({shotId:s.id,sourceId:s.source,start:s.start,end:s.end,state:'READY',evidenceSha256:'a'.repeat(64),bindingKey:'brand',productId:'sku'}));
 return {legacy:{slots,repairs:[],risks:[]},detections:new Map(shots.map((s,i)=>[s.path,{windows:[[0,20]],candidates:i?[]:cuts.map(time=>({time,confidence:'high',nativeFrameSeconds:1/24}))}])),
  context:{fps:30,shotPool:{shots},qualityReport:{decisions,admittedShotIds:shots.map(s=>s.id),sources:[]}},product:{product:{id:'sku'}}};
}
test('normal and uncertain evidence preserve exact objects even without quality context',()=>{
 const f=fixture(undefined,[]);delete f.context;
 assert.equal(repairKnownShortResidues(f),f.legacy);
 f.detections.get('a.mp4').candidates=[{time:.04,confidence:'uncertain'}];
 assert.equal(repairKnownShortResidues(f),f.legacy);
});
test('same safe window shift keeps slot length, ID and frame budget without mutating input',()=>{
 const f=fixture(),before=structuredClone(f.legacy),r=repairKnownShortResidues(f);
 assert.equal(r.shortResidue.state,'repaired');assert.equal(r.slots[0].shot.start,.066667);
 assert.equal(r.slots[0].slot.targetDuration,2);assert.equal(r.slots[0].shot.id,'a');assert.deepEqual(f.legacy,before);
 assert.equal(r.shortResidue.repairs[0].method,'same_safe_window_shift');
});
test('safe trim compensates another admitted selected interval if same window cannot shift',()=>{
 const f=fixture([entry('a',0,2,2),entry('b',5,2,8)]),r=repairKnownShortResidues(f);
 assert.equal(r.shortResidue.state,'repaired');assert.ok(r.shortResidue.repairs.some(x=>x.method==='compensate_safe_selected_shot'));
 assert.equal(r.slots.reduce((n,e)=>n+Math.round(e.slot.targetDuration*30),0),120);
});
test('replacement requires READY, explicit same SKU and brand, decoded coverage and no overlap',()=>{
 const f=fixture([entry('a',0,2,2)]),b=entry('b',5,2,8).shot;
 f.context.shotPool.shots.push(b);f.context.qualityReport.decisions.push({shotId:'b',sourceId:'b',start:5,end:8,state:'READY',evidenceSha256:'b'.repeat(64),productId:'sku',bindingKey:'brand'});
 f.context.qualityReport.admittedShotIds.push('b');f.detections.set('b.mp4',{candidates:[],windows:[[5,8]]});
 const r=repairKnownShortResidues(f);assert.equal(r.slots[0].shot.id,'b');assert.equal(r.shortResidue.repairs[0].method,'same_sku_brand_replacement');
 for(const change of [r=>r.state='REJECT',r=>r.productId='other-sku',r=>r.bindingKey='other-brand',r=>r.productId=null]){
  const g=structuredClone(f);change(g.context.qualityReport.decisions[1]);assert.equal(repairKnownShortResidues(g).blocked,true);
 }
 f.detections.get('b.mp4').windows=[];assert.equal(repairKnownShortResidues(f).blocked,true);
});
test('known residue cannot render unchanged on material or evidence insufficiency',()=>{
 const f=fixture([entry('a',0,2,2)]),r=repairKnownShortResidues(f);
 assert.equal(r.blocked,true);assert.equal(r.slots,f.legacy.slots);assert.equal(r.shortResidue.reason,'insufficient_evidence_backed_safe_material');
 delete f.context;assert.equal(repairKnownShortResidues(f).shortResidue.reason,'required_quality_interval_evidence_missing');
});
test('REJECT, REVIEW, wrong SKU, missing admission or unexamined extension never rescued',()=>{
 for(const change of [f=>f.context.qualityReport.decisions[0].state='REJECT',f=>f.context.qualityReport.decisions[0].state='REVIEW',
  f=>f.context.shotPool.shots[0].reject=true,f=>f.context.qualityReport.admittedShotIds=[],
  f=>f.context.semanticEvidence={records:[{shotId:'a',wrongSku:true}]},f=>f.detections.get('a.mp4').windows=[]]){
  const f=fixture();change(f);assert.equal(repairKnownShortResidues(f).blocked,true);
 }
});
test('attempt and deadline caps refuse once and do not affect a following normal product',()=>{
 const f=fixture();assert.equal(repairKnownShortResidues({...f,limits:{...RESIDUE_LIMITS,maxAttempts:0}}).shortResidue.reason,'repair_budget_exhausted');
 let t=0;assert.equal(repairKnownShortResidues({...f,now:()=>{t+=101;return t;}}).shortResidue.reason,'repair_budget_exhausted');
 const normal=fixture(undefined,[]);assert.equal(repairKnownShortResidues(normal),normal.legacy);
});
test('two real internal edges one frame apart are never merged or declared safe',()=>{
 const f=fixture([entry('a',0,2,2)],[1,1+1/30]);
 assert.equal(repairKnownShortResidues(f).blocked,true);
});
test('an overlapping REJECT interval vetoes an otherwise admitted larger window',()=>{
 const f=fixture();f.context.qualityReport.decisions.push({sourceId:'a',shotId:'rejected',state:'REJECT',start:.1,end:.3});
 assert.equal(repairKnownShortResidues(f).blocked,true);
});
test('existing template combination is tried once without changing the template skeleton',()=>{
 const f=fixture(),alternate=structuredClone(f.legacy.slots);alternate[0].shot.start=.066667;
 f.context.templateFallbackProducts=[{product:{id:'sku'},scheduleResult:{status:'success',renderPlan:{slots:alternate}}}];
 const r=repairKnownShortResidues({...f,limits:{...RESIDUE_LIMITS,maxShiftSeconds:0}});
 assert.equal(r.shortResidue.state,'repaired');assert.equal(r.shortResidue.repairs[0].method,'existing_legal_template_combination');
 alternate[0].slot.id='different';
 assert.equal(repairKnownShortResidues({...f,limits:{...RESIDUE_LIMITS,maxShiftSeconds:0}}).blocked,true);
});

function reviewReplacement(){
 const f=fixture([entry('a',0,2,2)]),b=entry('b',5,2,8).shot;
 f.context.qualityReport.decisions[0].state='REVIEW';f.context.qualityReport.decisions[0].reason='artifact:face';
 f.context.shotPool.shots[0].tags=['quality:review'];
 f.context.shotPool.shots.push(b);f.context.qualityReport.decisions.push({shotId:'b',sourceId:'b',start:5,end:8,state:'READY',evidenceSha256:'b'.repeat(64),productId:'sku',bindingKey:'brand'});
 f.context.qualityReport.admittedShotIds.push('b');f.detections.set('b.mp4',{candidates:[],windows:[[5,8]]});return f;
}
test('REVIEW conflict tries same-SKU READY replacement before refusing, without upgrading REVIEW',()=>{
 const f=reviewReplacement(),before=structuredClone(f),r=repairKnownShortResidues(f);
 assert.equal(r.shortResidue.state,'repaired');assert.equal(r.slots[0].shot.id,'b');
 assert.equal(r.slots[0].slot.targetDuration,2);assert.equal(r.slots[0].slot.id,'a');assert.deepEqual(f,before);
 assert.equal(f.context.qualityReport.decisions[0].state,'REVIEW');
});
test('missing SKU and unresolved REVIEW remain specific blocking reasons, never restore residue for render',()=>{
 const f=reviewReplacement();f.context.qualityReport.decisions[0].productId=null;
 const r=repairKnownShortResidues(f);assert.equal(r.blocked,true);assert.equal(r.slots,f.legacy.slots);
 assert.equal(r.shortResidue.reason,'review_risk_unresolved_no_safe_ready_replacement');
 assert.ok(r.shortResidue.attempted.some(a=>a.reason==='same_sku_binding_missing'));
 const d=describeShortResidueFailure([{shortResidue:r.shortResidue}]);
 assert.equal(d.detailCode,'SOURCE_REVIEW_UNRESOLVED_SKU_BINDING_MISSING');assert.match(d.message,/第 1 段/);assert.match(d.message,/不建议原样重试/);
});
test('replacement preserves slot constraints and refuses incomplete candidate decoding',()=>{
 for(const change of [f=>f.legacy.slots[0].slot.requireTags=['detail'],f=>f.legacy.slots[0].slot.requireProductCentered=true,
  f=>f.legacy.slots[0].slot.minProductVisibility=.8,f=>f.legacy.slots[0].slot.requireMotionEnergy='low',
  f=>f.detections.get('b.mp4').windows=[],f=>f.context.qualityReport.decisions[1].state='REVIEW',
  f=>f.context.semanticEvidence={records:[{shotId:'b',wrongSku:true}]}]){
  const f=reviewReplacement();change(f);assert.equal(repairKnownShortResidues(f).blocked,true);
 }
});
test('REJECT, quarantine, or confirmed wrong SKU selected intervals still cannot enter REVIEW rescue',()=>{
 for(const change of [f=>f.context.qualityReport.decisions[0].state='REJECT',
  f=>f.context.qualityReport.sources=[{sourceId:'a',state:'REJECT'}],
  f=>f.context.semanticEvidence={records:[{shotId:'a',wrongSku:true}]}]){
  const f=reviewReplacement();change(f);assert.equal(repairKnownShortResidues(f).shortResidue.reason,'selected_interval_not_ready_for_automatic_repair');
 }
});
test('exceptional repair cannot deliver a remaining unresolved REVIEW in another slot',()=>{
 const f=fixture([entry('a'),entry('b',5,2,8)]);f.context.qualityReport.decisions[1].state='REVIEW';
 assert.equal(repairKnownShortResidues(f).shortResidue.reason,'review_risk_unresolved_in_output');
});
test('a second conflicted REVIEW slot cannot reuse the first replacement or leak partial repair',()=>{
 const f=reviewReplacement(),other=entry('c',10,2,12);f.legacy.slots.push(other);
 f.context.shotPool.shots.push(other.shot);f.context.qualityReport.decisions.push({shotId:'c',sourceId:'c',state:'REVIEW',start:10,end:12,productId:'sku',bindingKey:'brand',evidenceSha256:'c'.repeat(64)});
 f.context.qualityReport.admittedShotIds.push('c');f.detections.set('c.mp4',{windows:[[10,12]],candidates:[{time:10.04,confidence:'high'}]});
 const r=repairKnownShortResidues(f);assert.equal(r.blocked,true);assert.equal(r.slots,f.legacy.slots);assert.deepEqual(r.repairs,[]);
});
