// Read-only historical evidence audit; writes only to this experiment directory.
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile),read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
const root='D:/自动剪辑网站/artifacts/ootd-structure-20261114';
await fs.mkdir(root,{recursive:true});
const runtime='D:/CUT-Releases/20261030-production-first-r11';
const config=await read(runtime+'/config/cutflow-runtime.json');
const records=await read(runtime+'/data/classic-multisource-records.json');
const ids=['2a4ec2a9-436e-4f46-a490-ab99035e3a83','336ab52a-ef45-4039-9ff4-794018b5bade',...records.filter(r=>r.sources?.length>=2&&r.sources.every(s=>s.videoType==='ootd')).slice(-8).map(r=>r.taskId)];
const sharp=createRequire(import.meta.resolve('next/package.json'))('sharp');
const results=[];
for(const id of [...new Set(ids)].slice(0,10)){
 const work='E:/cutflow批量/classic-multisource/'+id,r=records.find(r=>r.taskId===id);
 try{
 const q=await read(work+'/quality/classic-multisource-quality.v1.json'),edl=await read(work+'/edit/render-plan-edl.json'),inputs=await read(work+'/analyze/deterministic-inputs.v1.json');
 const schedule=await read(work+'/edit/multisource-schedule-result.json');
 const segments=edl.products.flatMap(p=>p.segments);
 const pool=q.decisions.map(d=>({...d,path:inputs.sidecars.find(s=>s.fileId===d.sourceId)?.videoPath,admitted:q.admittedShotIds.includes(d.shotId)}));
 const hashes=[];for(const d of pool){hashes.push(createHash('sha256').update(await fs.readFile(work+'/quality/'+d.evidencePath)).digest('hex')===d.evidenceSha256);}
 const sourceHashes=[];for(const s of inputs.sidecars)sourceHashes.push(createHash('sha256').update(await fs.readFile(s.videoPath)).digest('hex')===r.sources.find(x=>x.id===s.fileId)?.sha256);
 const rows=segments.map((s,i)=>({label:'A'+(i+1)+' '+s.slot+' '+s.source_in.toFixed(2)+'-'+s.source_out.toFixed(2),start:s.source_in,end:s.source_out,path:s.source_original}));
 const unused=pool.filter(d=>d.admitted&&d.state!=='REJECT'&&!segments.some(s=>s.shot_id===d.shotId));
 rows.push(...unused.map((d,i)=>({...d,label:'ALT'+(i+1)+' '+d.state+' '+d.start.toFixed(2)+'-'+d.end.toFixed(2)})));
 const images=[];for(let j=0;j<rows.length;j++){const row=rows[j];
  const label=Buffer.from('<svg width="720" height="24"><rect width="100%" height="100%" fill="white"/><text x="5" y="18" font-size="16">'+row.label+'</text></svg>');images.push({input:label,left:0,top:j*204});
  for(let k=0;k<3;k++){const at=row.start+(row.end-row.start)*[.05,.5,.95][k];const {stdout}=await exec(config.ffmpegExecutable,['-v','error','-ss',String(at),'-i',row.path,'-frames:v','1','-vf','scale=180:180:force_original_aspect_ratio=decrease,pad=240:180:(ow-iw)/2:(oh-ih)/2','-f','image2pipe','-vcodec','mjpeg','pipe:1'],{encoding:'buffer',windowsHide:true,maxBuffer:2000000});images.push({input:stdout,left:k*240,top:j*204+24});}
 }
 await sharp({create:{width:720,height:rows.length*204,channels:3,background:'white'}}).composite(images).jpeg().toFile(root+'/'+id+'.jpg');
 const result={id,sourceHashes: r.sources.map(s=>s.sha256),hashesVerified:hashes.every(Boolean)&&sourceHashes.every(Boolean),sources:r.sources.length,segments:segments.map(s=>({slot:s.slot,id:s.shot_id,start:s.source_in,end:s.source_out,duration:s.duration,path:s.source_original,tags:s.content_tags})),pool:pool.map(({path,...d})=>d),planned:schedule.scheduledProducts.flatMap(p=>p.scheduleResult.renderPlan.slots.map(e=>({id:e.shot.id,target:e.slot.targetDuration,start:e.shot.start,end:e.shot.end,tags:e.shot.tags}))),unused:unused.map(d=>d.shotId)};
 results.push(result);await fs.writeFile(root+'/audit.json',JSON.stringify(results,null,2));console.log(id,segments.map(s=>s.duration), 'unused',unused.length,'hash',result.hashesVerified);
 }catch(e){console.log(id,'ERROR',e.message);results.push({id,error:e.message});}
}
await fs.writeFile(root+'/audit.json',JSON.stringify(results,null,2));
