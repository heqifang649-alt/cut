import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
const production='D:/CUT-Releases/20261030-production-first-r11';
const evidence=path.resolve('.project-governance/evidence/shared-boundary-20261119'),candidate=evidence+'/candidate';
await fs.mkdir(candidate,{recursive:true});
const visited=new Set(),manifest=[];
async function copy(file){
 if(visited.has(file))return;visited.add(file);
 const bytes=await fs.readFile(production+'/'+file),source=bytes.toString('utf8');
 await fs.mkdir(path.dirname(candidate+'/'+file),{recursive:true});await fs.writeFile(candidate+'/'+file,bytes);
 manifest.push({file,productionSha256:createHash('sha256').update(bytes).digest('hex')});
 for(const m of source.matchAll(/(?:from\s*|import\s*\()\s*['"](\.[^'"]+)['"]/g)){
  const dependency=path.posix.normalize(path.posix.join(path.posix.dirname(file),m[1]));
  if(/\.(mjs|ts|json)$/.test(dependency))await copy(dependency);
 }
}
for(const file of ['worker/classic-multisource-executor.mjs','worker/guided-production-policy.mjs','worker/guided-render-v22.mjs'])await copy(file);
for(const file of ['worker/ootd-template-render.mjs','worker/ootd-min-shot.mjs','lib/final-mp4-boundary.mjs']){
 await fs.mkdir(path.dirname(candidate+'/'+file),{recursive:true});await fs.copyFile(file,candidate+'/'+file);
}
// Only transplant the new error mapping, retaining deployed receipt behavior.
const receipt=candidate+'/lib/classic-multisource.mjs';let receiptSource=await fs.readFile(receipt,'utf8');
const local=await fs.readFile('lib/classic-multisource.mjs','utf8');
const start=local.indexOf("    if(status==='failed' && ['FINAL_MP4_BOUNDARY_UNCONFIRMED'");
const end=local.indexOf("    if (status === 'failed' && record.error.code",start);
const insertion=local.slice(start,end)+`    if(status==='failed' && record.error.code==='FINAL_MP4_SHORT_SHOT_REFUSE'){
      record.error.message='成片存在未通过原最短时长规则的镜头，已保留产物和证据；不建议直接重复送剪，请先复核镜头。';
    }
`;
const marker='    if (status === "failed" && error?.code === "MULTISOURCE_SCHEDULING_FAILED"';
if(!receiptSource.includes(marker)||!insertion.includes('FINAL_MP4_CORRUPT'))throw Error('receipt patch anchor mismatch');
receiptSource=receiptSource.replace(marker,insertion+marker);await fs.writeFile(receipt,receiptSource);
const guards=[
 ['worker/classic-multisource-executor.mjs',"if(error.message==='任务已取消'||", "if(error.preserveExistingOutput===true||error.message==='任务已取消'||"],
 ['worker/guided-production-policy.mjs',"if(error.message==='任务已取消'||", "if(error.preserveExistingOutput===true||error.message==='任务已取消'||"],
 ['worker/guided-render-v22.mjs',"if(products===scheduledProducts ||", "if(error.preserveExistingOutput===true || products===scheduledProducts ||"],
];
for(const [file,before,after]of guards){let source=await fs.readFile(candidate+'/'+file,'utf8');if(!source.includes(before))throw Error('guard anchor mismatch: '+file);source=source.replace(before,after);await fs.writeFile(candidate+'/'+file,source);}
await fs.writeFile(evidence+'/candidate-manifest.json',JSON.stringify({production,candidate,baseline:manifest,guards:guards.map(([file])=>file)},null,2));
console.log(JSON.stringify({copiedDependencies:manifest.length,candidate,productionModified:false}));
