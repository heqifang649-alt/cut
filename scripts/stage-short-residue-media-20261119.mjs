// Read only the four identified historical source files, hash them and copy
// into the isolated evidence directory. No production configuration or state.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
const dest=path.resolve('.project-governance/evidence/short-residue-20261119/media');
const rows=JSON.parse(await fs.readFile('data/classic-multisource-records.json','utf8'));
const staged=[];
for(const id of ['07338b39-3e41-4706-b447-43fd4ab9148e','25a88a58-ee85-40fd-9319-4dfef97194fb']){
 const row=rows.find(r=>r.taskId===id);
 const edl=JSON.parse(await fs.readFile('E:/cutflow批量/classic-multisource/'+id+'/edit/render-plan-edl.json','utf8'));
 for(const source of row.sources){
  const original=edl.products.flatMap(p=>p.segments).find(s=>s.source_original.endsWith(path.win32.basename(source.relativePath)))?.source_original;
  if(!original)throw Error('Missing exact source binding');
  const target=path.join(dest,id,path.win32.basename(source.relativePath));
  let bytes=await fs.readFile(target).catch(()=>null);
  if(!bytes||createHash('sha256').update(bytes).digest('hex')!==source.sha256)bytes=await fs.readFile(original);
  const actual=createHash('sha256').update(bytes).digest('hex');
  if(actual!==source.sha256||bytes.length!==source.sizeBytes)throw Error('Historical source integrity mismatch');
  await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,bytes);
  staged.push({taskId:id,sourceId:source.id,original,target,sha256:actual,size:bytes.length});
 }
}
await fs.writeFile(dest+'/manifest.json',JSON.stringify(staged,null,2));
console.log(JSON.stringify({copied:staged.length,dest,hashesVerified:true,productionWrites:0}));
