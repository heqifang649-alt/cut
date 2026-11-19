import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
const production='D:/CUT-Releases/20261030-production-first-r11';
const base=path.resolve('.project-governance/evidence/short-residue-20261119');
const candidate=base+'/candidate',baseline=base+'/baseline',visited=new Set(),manifest=[];
const hash=b=>createHash('sha256').update(b).digest('hex');
async function copy(file){
 if(visited.has(file))return;visited.add(file);
 const bytes=await fs.readFile(production+'/'+file);
 for(const target of [candidate,baseline]){await fs.mkdir(path.dirname(target+'/'+file),{recursive:true});await fs.writeFile(target+'/'+file,bytes);}
 manifest.push({file,sha256:hash(bytes)});
 for(const m of bytes.toString().matchAll(/(?:from\s*|import\s*\()\s*['"](\.[^'"]+)['"]/g)){
  const dep=path.posix.normalize(path.posix.join(path.posix.dirname(file),m[1]));
  if(/\.(mjs|ts|json)$/.test(dep))await copy(dep);
 }
}
await copy('worker/classic-multisource-executor.mjs');
async function patch(file,before,after){
 const target=candidate+'/'+file,s=await fs.readFile(target,'utf8');
 if(!s.includes(before))throw Error('Patch anchor mismatch '+file);
 await fs.writeFile(target,s.replace(before,after));
}
await fs.copyFile('lib/short-residue-repair.mjs',candidate+'/lib/short-residue-repair.mjs');
await patch('lib/internal-cut-repair.mjs',"const execute = promisify(execFile);","import {repairKnownShortResidues} from './short-residue-repair.mjs';\nconst execute = promisify(execFile);");
await patch('lib/internal-cut-repair.mjs','{scheduledProducts,ffmpeg}', '{scheduledProducts,ffmpeg,shortResidueContext}');
await patch('lib/internal-cut-repair.mjs','const plan=p.scheduleResult.renderPlan,result=repairInternalCutEdges(plan.slots,detections);',
 `const plan=p.scheduleResult.renderPlan,legacy=repairInternalCutEdges(plan.slots,detections);
    const result=repairKnownShortResidues({legacy,detections,context:shortResidueContext,product:p});`);
await patch('worker/batch-renderer.mjs','internalCutRepair = true, preparedBrandAudioByProduct','internalCutRepair = true, shortResidueContext, preparedBrandAudioByProduct');
await patch('worker/batch-renderer.mjs','repairScheduledInternalCuts({ scheduledProducts, ffmpeg })','repairScheduledInternalCuts({ scheduledProducts, ffmpeg, shortResidueContext })');
await patch('worker/batch-renderer.mjs','scheduledProducts = repaired.products;',`scheduledProducts = repaired.products;
    const blocked = repaired.evidence.products.filter(p=>p.blocked);
    if(blocked.length)throw Object.assign(new Error('SOURCE_INSUFFICIENT'),{code:'SOURCE_INSUFFICIENT',
      failure_stage:'pre_render_short_residue',reason:'confirmed_short_residue_no_evidence_backed_repair',
      retryable:false,preserveExistingOutput:true,diagnostic_details:blocked});`);
await patch('worker/classic-multisource-executor.mjs','semanticEvidence: quality.semanticEvidence,templateFallbackProducts',
 `semanticEvidence: quality.semanticEvidence,templateFallbackProducts,
        shortResidueContext:{shotPool:quality.shotPool,qualityReport:quality.report,semanticEvidence:quality.semanticEvidence,fps:30,templateFallbackProducts}`);
await patch('lib/classic-multisource.mjs',"    if(status==='failed' && record.error.code==='FINAL_MP4_SHORT_SHOT_REFUSE'){",`    if(status==='failed' && record.error.code==='SOURCE_INSUFFICIENT' && error?.failure_stage==='pre_render_short_residue'){
      record.error.message='已确认素材含异常短残片，现有安全素材不足以自动修复；未继续渲染，已保留证据，请补充同款安全素材。';
    }
    if(status==='failed' && record.error.code==='FINAL_MP4_SHORT_SHOT_REFUSE'){`);
await fs.writeFile(base+'/manifest.json',JSON.stringify({production,candidate,baseline,files:manifest,changedFiles:[
 'lib/short-residue-repair.mjs','lib/internal-cut-repair.mjs','worker/batch-renderer.mjs','worker/classic-multisource-executor.mjs','lib/classic-multisource.mjs']},null,2));
console.log(JSON.stringify({candidate,baseline,copied:manifest.length,productionModified:false}));
