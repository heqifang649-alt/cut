import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
const base=path.resolve('.project-governance/evidence/tt-admission-20261119');
const production=JSON.parse(await fs.readFile(base+'/manifest.json','utf8')).production;
const read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
const hash=b=>createHash('sha256').update(b).digest('hex');
const rows=await read(production+'/data/classic-multisource-records.json'),tasks=[],media=[];
for(const taskId of ['51508893-98e9-4ab3-bbe0-b654584f7c7a','8cd70d9a-de3c-4e85-b311-ecda64077ec8']){
 const work='E:/cutflow批量/classic-multisource/'+taskId,row=rows.find(r=>r.taskId===taskId);
 const quality=await read(work+'/quality/classic-multisource-quality.v1.json'),evidence=[];
 for(const d of quality.decisions){
  const file=work+'/quality/'+d.evidencePath,bytes=await fs.readFile(file);
  if(hash(bytes)!==d.evidenceSha256)throw Error('Quality evidence hash mismatch');
  const s=JSON.parse(bytes).sources.find(s=>s.sourceId===d.shotId);
  const source=row.sources.find(x=>x.id===d.sourceId);
  if(s.sourceHash!==source.sha256)throw Error('Quality source mismatch');
  evidence.push({decision:d,sourceInterval:s.sourceInterval,referenceKey:s.referenceKey,
   references:s.referenceCoverage?.references?.map(r=>({sha256:r.sha256,type:r.referenceType})),
   sampledFrames:s.sampledFrames.map(f=>({index:f.index,time:f.time,hash:f.hash})),
   providerEvidence:s.providerEvidence,technical:s.technical,hashVerified:true});
  if(media.some(m=>m.taskId===taskId&&m.sourceId===source.id))continue;
  const original=s.source.videoPath,target=base+'/media/'+taskId+'/'+path.win32.basename(original);
  let b=await fs.readFile(target).catch(()=>null);
  if(!b||hash(b)!==source.sha256)b=await fs.readFile(original);
  if(hash(b)!==source.sha256||b.length!==source.sizeBytes)throw Error('Source integrity mismatch');
  await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,b);
  media.push({taskId,sourceId:source.id,original,target,sha256:hash(b),size:b.length});
 }
 const nasRoot=media.find(m=>m.taskId===taskId).original.split('\\inbox\\')[0];
 const receipt=await read(nasRoot+'/outbox/'+taskId+'/status.json');
 await fs.writeFile(base+'/'+taskId+'-nas-status.json',JSON.stringify(receipt,null,2));
 tasks.push({taskId,work,record:{taskId,status:row.status,revision:row.revision,attempt:row.attempt,error:row.error},
  sourceBindings:row.sources.map(s=>({id:s.id,productId:s.productId,bindingKey:s.bindingKey})),
  evidence,nasReceipt:{status:receipt.status,error:receipt.error,revision:receipt.revision},
  uniqueReferenceKeys:[...new Set(evidence.map(e=>e.referenceKey))]});
}
await fs.writeFile(base+'/media/manifest.json',JSON.stringify(media,null,2));
await fs.writeFile(base+'/historical-evidence.json',JSON.stringify(tasks,null,2));
console.log(JSON.stringify({media:media.length,tasks:tasks.map(t=>({taskId:t.taskId,sourceBindings:t.sourceBindings,nasReceipt:t.nasReceipt,
 review:t.evidence.filter(e=>e.decision.state==='REVIEW').map(e=>({shotId:e.decision.shotId,face:e.providerEvidence.artifacts.face,frames:e.sampledFrames})),uniqueReferenceKeys:t.uniqueReferenceKeys})),productionWrites:0},null,2));
