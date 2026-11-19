import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {publishMultisourceResults,multisourceStatus,assertMultisourceStatusV2} from '../lib/classic-multisource.mjs';
const prod='D:/CUT-Releases/20261030-production-first-r11',base=path.resolve('.project-governance/evidence/allwe-short-shot-20261119');
const read=async p=>JSON.parse(await fs.readFile(p,'utf8')),hash=async p=>createHash('sha256').update(await fs.readFile(p)).digest('hex');
const rt=await read(prod+'/config/cutflow-runtime.json'),rows=await read(prod+'/data/classic-multisource-records.json'),results=[];
for(const id of ['e4d39e41-f684-4e64-8dad-0cbaa867d3ca','2863bcc1-ff81-4ed3-ae2f-4ea1c88a09fe']){
 const root=base+'/'+id+'/delivery-sandbox',nasRoot=root+'/nas';await fs.mkdir(root+'/data',{recursive:true});
 const record=structuredClone(rows.find(r=>r.taskId===id));record.status='editing';delete record.error;delete record.lease;record.outputs=[];
 await fs.writeFile(root+'/data/classic-multisource-records.json',JSON.stringify([record]));
 const audit=await read(base+'/'+id+'/audit.json'),sourcePath=audit.output,sha256=await hash(sourcePath),size=(await fs.stat(sourcePath)).size;
 const config={ready:true,nasRoot},output={id:randomUUID(),sourcePath,sha256,size,durationSeconds:313/30};
 const receipt=await publishMultisourceResults(root,config,id,[output],'completed',{ffmpeg:rt.ffmpegExecutable,ffprobe:rt.ffprobeExecutable});
 assertMultisourceStatusV2(receipt);assert.equal(receipt.status,'completed');assert.equal(receipt.outputs.length,1);
 assert.deepEqual(await multisourceStatus(root,id),receipt);assert.deepEqual(await read(nasRoot+'/outbox/'+id+'/status.json'),receipt);
 assert.equal(await hash(path.join(nasRoot,receipt.outputs[0].relativePath)),sha256);
 results.push({taskId:id,status:receipt.status,outputCount:receipt.outputs.length,nasSandboxHashVerified:true,oldV2ContractAccepted:true,actualAllweClient:'unconfirmed'});
}
await fs.writeFile(base+'/isolated-publication.json',JSON.stringify(results,null,2));console.log(JSON.stringify(results));
