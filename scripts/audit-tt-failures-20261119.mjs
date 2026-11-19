import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const root='D:/CUT-Releases/20261030-production-first-r11';
const out=path.resolve('.project-governance/evidence/tt-failures-20261119');
await fs.mkdir(out,{recursive:true});
const read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
const hash=async p=>createHash('sha256').update(await fs.readFile(p)).digest('hex');
const records=await read(root+'/data/classic-multisource-records.json');
const {repairKnownShortResidues}=await import(pathToFileURL(root+'/lib/short-residue-repair.mjs'));
const modules={};
for(const file of ['lib/short-residue-repair.mjs','lib/internal-cut-repair.mjs','worker/batch-renderer.mjs','worker/ootd-template-render.mjs','worker/classic-multisource-executor.mjs','lib/classic-multisource.mjs'])modules[file]=await hash(root+'/'+file);
const tasks=[];
for(const taskId of ['51508893-98e9-4ab3-bbe0-b654584f7c7a','8cd70d9a-de3c-4e85-b311-ecda64077ec8']){
 const work='E:/cutflow批量/classic-multisource/'+taskId;
 const r=records.find(x=>x.taskId===taskId);assert.ok(r);
 const files={error:root+'/data/classic-multisource-errors/'+taskId+'.json',
  repair:work+'/edit/internal-cut-repair.v1.json',quality:work+'/quality/classic-multisource-quality.v1.json',
  schedule:work+'/edit/multisource-schedule-result.json',template:work+'/edit/ootd-min-shot-repair.json'};
 const data={};for(const [key,file]of Object.entries(files))data[key]=await read(file);
 const product=structuredClone(data.schedule.scheduledProducts[0]);
 for(const slot of product.scheduleResult.renderPlan.slots){
  const change=data.template.changes.find(x=>x.shotId===slot.shot.id);
  if(change&&Number.isFinite(change.start)){slot.shot.start=change.start;slot.slot.targetDuration=change.duration;}
 }
 const detections=new Map(data.repair.diagnostics.map(d=>[d.source,d]));
 // Recorded legacy repair returned the original slots (repairs=[]). Its
 // proposal.before values are the actual pre-render intervals, after wrappers.
 for(const risk of data.repair.products[0].risks)for(const proposal of risk.proposals||[]){
  const slot=product.scheduleResult.renderPlan.slots[proposal.index];
  slot.shot.start=proposal.before.start;slot.slot.targetDuration=proposal.before.end-proposal.before.start;
 }
 const legacy={slots:product.scheduleResult.renderPlan.slots,repairs:[],risks:data.repair.products[0].risks};
 // Reconstruction uses actual selected shots, not a claim of a full ShotPool/
 // executor replay. Reproduces the first admission check before any candidate use.
 const replay=repairKnownShortResidues({legacy,detections,product,context:{fps:30,
  shotPool:{shots:product.scheduleResult.renderPlan.slots.map(s=>s.shot)},qualityReport:data.quality}});
 assert.equal(replay.blocked,true);assert.equal(replay.shortResidue.reason,'selected_interval_not_ready_for_automatic_repair');
 assert.equal(replay.shortResidue.attempts,0);
 const conflicts=await Promise.all(data.repair.products[0].shortResidue.conflicts.map(async c=>{
  const slot=product.scheduleResult.renderPlan.slots[c.index];
  const decision=data.quality.decisions.find(d=>d.shotId===slot.shot.id);
  return {slotIndex:c.index+1,slotId:slot.slot.id,shotId:slot.shot.id,start:slot.shot.start,
   plannedDuration:slot.slot.targetDuration,cuts:c.cuts.map(x=>x.time),
   preCutResidueMs:(c.cuts[0].time-slot.shot.start)*1000,qualityState:decision?.state,qualityReason:decision?.reason,
   qualityEvidenceHashMatches:decision?.evidenceSha256===await hash(work+'/quality/'+decision.evidencePath)};
 }));
 const ready=data.quality.decisions.filter(d=>d.state==='READY');
 const sourceSet=r.sources.map(s=>s.sha256).sort();
 const record={taskId,status:r.status,stage:r.stage,error:r.error,acceptedAt:r.acceptedAt,updatedAt:r.updatedAt,attempt:r.attempt,revision:r.revision};
 const evidence={record,sourceSet,files,hashes:Object.fromEntries(await Promise.all(Object.entries(files).map(async([k,p])=>[k,await hash(p)]))),
  originalError:data.error,conflicts,reportedRepair:data.repair.products[0],
  pureReplay:{blocked:replay.blocked,reason:replay.shortResidue.reason,attempts:replay.shortResidue.attempts,scope:'first admission gate reconstructed from existing selected slots and persisted detections; not full rendering'},
  readyIntervals:ready.map(d=>({shotId:d.shotId,start:d.start,end:d.end,productId:d.productId,bindingKey:d.bindingKey})),
  readyNominalSeconds:ready.reduce((s,d)=>s+d.end-d.start,0),
  hasFinalManifest:await fs.stat(work+'/output/render-manifest.json').then(()=>true,()=>false)};
 await fs.writeFile(out+'/'+taskId+'.json',JSON.stringify(evidence,null,2));tasks.push(evidence);
}
assert.deepEqual(tasks[0].sourceSet,tasks[1].sourceSet);
const result={at:new Date().toISOString(),root,modules,tasks:tasks.map(t=>({taskId:t.record.taskId,error:t.record.error,conflicts:t.conflicts,replay:t.pureReplay,readyNominalSeconds:t.readyNominalSeconds,hasFinalManifest:t.hasFinalManifest})),sameDeclaredSources:true,providerCalls:0,renderCalls:0,productionModified:false};
await fs.writeFile(out+'/result.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
