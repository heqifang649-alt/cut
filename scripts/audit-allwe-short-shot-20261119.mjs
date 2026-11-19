import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const root='D:/CUT-Releases/20261030-production-first-r11';
const dest=path.resolve('.project-governance/evidence/allwe-short-shot-20261119');
await fs.mkdir(dest,{recursive:true});
const read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
const hash=async p=>createHash('sha256').update(await fs.readFile(p)).digest('hex');
const runtime=await read(root+'/config/cutflow-runtime.json');
const mod=await import(pathToFileURL(root+'/worker/ootd-template-render.mjs'));
const rows=await read(root+'/data/classic-multisource-records.json');
const config=await read(root+'/data/classic-integration-runtime.json');
for(const id of ['e4d39e41-f684-4e64-8dad-0cbaa867d3ca','2863bcc1-ff81-4ed3-ae2f-4ea1c88a09fe']){
 const work='E:/cutflow批量/classic-multisource/'+id, edit=work+'/edit';
 const row=rows.find(r=>r.taskId===id),edl=await read(edit+'/render-plan-edl.json'),manifest=await read(work+'/output/render-manifest.json');
 const file=manifest.files[0],output=path.isAbsolute(file.storagePath)?file.storagePath:path.resolve(root,file.storagePath);
 const clock=await mod.probeFrameClock(runtime.ffprobeExecutable,output);
 const cuts=await mod.scanFinalTemplateCuts({ffmpeg:runtime.ffmpegExecutable,file:output,clock});
 const product=edl.products.find(p=>p.product_id===file.productId),counts=[],clips=[];
 for(const [i,s] of product.segments.entries()){
  const duration=Number(s.duration||(s.source_out-s.source_in)),colorStrategy='none';
  const signature=createHash('sha256').update(JSON.stringify({source:s.source_original,sourceIn:s.source_in,duration,width:edl.master.width,height:edl.master.height,fps:edl.master.fps,colorStrategy})).digest('hex').slice(0,16);
  const p=path.join(edit,'clips_graded',product.product_id,`${String(i+1).padStart(2,'0')}-none-${signature}.mp4`);
  try{const c=await mod.probeFrameClock(runtime.ffprobeExecutable,p);counts.push(c.frameCount);clips.push({path:p,frames:c.frameCount,expected:Math.round(duration*30),fps:c.fps,width:c.width,height:c.height});}catch(e){clips.push({path:p,error:e.message});}
 }
 const local=path.join(dest,id);await fs.mkdir(local,{recursive:true});await fs.copyFile(edit+'/render-plan-edl.json',local+'/render-plan-edl.json');
 // Isolated exact-cache links are copies; original historical directories remain read-only.
 for(const c of clips)if(!c.error){const target=path.join(local,'clips_graded',product.product_id,path.basename(c.path));await fs.mkdir(path.dirname(target),{recursive:true});await fs.copyFile(c.path,target);}
 let failure=null;try{await mod.verifyTemplateOutputs({root,editDir:local,ffmpeg:runtime.ffmpegExecutable,batch:{colorStrategy:'none'}},manifest);}catch(e){failure={message:e.message,stack:e.stack};}
 const layout=mod.finalShotBoundaries({clock,segments:product.segments,cuts,encodedCounts:counts});
 const nas=await read(path.join(config.nasRoot,'outbox',id,'status.json'));
 const sources=[];for(const s of row.sources){const p=path.join(config.nasRoot,path.dirname(row.manifestRelativePath),s.relativePath);sources.push({clipId:s.clipId,path:p,expected:s.sha256,actual:await hash(p)});}
 const result={taskId:id,productionModuleHash:await hash(root+'/worker/ootd-template-render.mjs'),record:{status:row.status,stage:row.stage,attempt:row.attempt,acceptedAt:row.acceptedAt,updatedAt:row.updatedAt,error:row.error,idempotencyKey:row.idempotencyKey},originalError:await read(root+'/data/classic-multisource-errors/'+id+'.json'),nas,sources,output,outputSha256:await hash(output),clock:{...clock,pts:undefined,times:undefined},product,cuts,clips,counts,layout,failure};
 await fs.writeFile(local+'/audit.json',JSON.stringify(result,null,2));
 console.log(JSON.stringify({id,counts,total:counts.reduce((a,b)=>a+b,0),frames:clock.frameCount,cuts,shots:layout.shots,proven:layout.encodedLayoutProven,failure}));
}
