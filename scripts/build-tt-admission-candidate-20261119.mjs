import fs from 'node:fs/promises';
const base='.project-governance/evidence/tt-admission-20261119';
const manifest=JSON.parse(await fs.readFile(base+'/manifest.json','utf8'));
const changed=['lib/short-residue-repair.mjs','worker/batch-renderer.mjs','lib/classic-multisource.mjs'];
await fs.copyFile('lib/short-residue-repair.mjs',manifest.candidate+'/'+changed[0]);
async function patch(file,before,after){
 const source=await fs.readFile(manifest.baseline+'/'+file,'utf8');
 if(!source.includes(before))throw Error('Anchor mismatch '+file);
 await fs.writeFile(manifest.candidate+'/'+file,after(source));
}
await patch(changed[1],"reason:'confirmed_short_residue_no_evidence_backed_repair'",source=>{
 source="import {describeShortResidueFailure} from '../lib/short-residue-repair.mjs';\n"+source;
 return source.replace("if(blocked.length)throw Object.assign(new Error('SOURCE_INSUFFICIENT'),{code:'SOURCE_INSUFFICIENT',", "if(blocked.length)throw Object.assign(new Error(describeShortResidueFailure(blocked).message),{code:'SOURCE_INSUFFICIENT',\n      ...describeShortResidueFailure(blocked),");
});
await patch(changed[2],"record.error.message='已确认素材含异常短残片",source=>{
 source="import {describeShortResidueFailure} from './short-residue-repair.mjs';\n"+source;
 source=source.replace("record.error.message='已确认素材含异常短残片，现有安全素材不足以自动修复；未继续渲染，已保留证据，请补充同款安全素材。';", "Object.assign(record.error,describeShortResidueFailure(error.diagnostic_details));");
 return source.replace('name: error.name, code: error.code || null, message: error.message, stack: error.stack,',
  `name: error.name, code: error.code || null, message: error.message, stack: error.stack,
        ...(error.failure_stage==='pre_render_short_residue'?{failure_stage:error.failure_stage,
          detailCode:record.error.detailCode,reason:error.reason,retryable:false,diagnostic_details:error.diagnostic_details||null}:{}),`);
});
manifest.changedFiles=changed;
await fs.writeFile(base+'/manifest.json',JSON.stringify(manifest,null,2));
console.log(JSON.stringify({changed,candidate:manifest.candidate,productionWrites:0}));
