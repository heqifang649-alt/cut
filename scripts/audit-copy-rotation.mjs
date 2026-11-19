import fs from 'node:fs';import path from 'node:path';import {matchOutputCopy} from '../lib/brand-copy-match.mjs';
const out='.project-governance/evidence/brand-copy-rotation-20261112';
const records=JSON.parse(fs.readFileSync('data/classic-multisource-records.json'));
const completed=records.filter(r=>r.status==='completed'&&r.outputs?.length).sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt)));
const picked=[...completed.slice(0,8),...completed.filter(r=>r.sourceBinding?.value==='guidingcross').slice(0,2)];
const audit=[];
for(const r of picked){const dir=path.join('E:/cutflow批量/classic-multisource',r.taskId);try{
 const snap=JSON.parse(fs.readFileSync(path.join(dir,'brand-copy-snapshot.v1.json')));
 const copies=path.join(dir,'edit/output-copy');for(const d of fs.readdirSync(copies)){
 const sel=JSON.parse(fs.readFileSync(path.join(copies,d,'selection.json')));audit.push({taskId:r.taskId,batchId:r.batchId,updatedAt:r.updatedAt,brand:sel.brand,product:sel.productId,brandCopyEnabled:'inferred true: snapshot and selection exist',directory:dir,selection:sel,snapshot:snap});}
}catch(e){audit.push({taskId:r.taskId,batchId:r.batchId,error:e.message});}}
fs.writeFileSync(path.join(out,'audit.json'),JSON.stringify(audit,null,2));
console.log(audit.map(a=>({task:a.taskId,brand:a.brand,hook:a.selection?.actualHook,cta:a.selection?.actualCTA,row:a.selection?.hook.origins,warnings:a.selection?.layoutWarnings,error:a.error})));
