import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const run=promisify(execFile),root='D:/CUT-Releases/20261030-production-first-r11';
const rt=JSON.parse(await fs.readFile(root+'/config/cutflow-runtime.json','utf8'));
const dest=path.resolve('.project-governance/evidence/allwe-short-shot-20261119');
for(const id of ['e4d39e41-f684-4e64-8dad-0cbaa867d3ca','2863bcc1-ff81-4ed3-ae2f-4ea1c88a09fe']){
 const a=JSON.parse(await fs.readFile(dest+'/'+id+'/audit.json','utf8'));
 const decode=async p=>(await run(rt.ffmpegExecutable,['-nostdin','-v','error','-i',p,'-vf','scale=96:96,format=gray','-fps_mode','passthrough','-an','-f','rawvideo','pipe:1'],{encoding:'buffer',maxBuffer:32*1024*1024,windowsHide:true})).stdout;
 const expected=Buffer.concat(await Promise.all(a.clips.map(c=>decode(c.path))));const actual=await decode(a.output);
 const differences=[];for(let f=0;f<actual.length/9216;f++){let sum=0,max=0;for(let k=0;k<9216;k++){const d=Math.abs(actual[f*9216+k]-expected[f*9216+k]);sum+=d;max=Math.max(max,d);}differences.push({frame:f,mean:sum/9216,max});}
 const proof={expectedFrames:expected.length/9216,actualFrames:actual.length/9216,maxMean:Math.max(...differences.map(d=>d.mean)),differences};
 await fs.writeFile(dest+'/'+id+'/prefix-proof.json',JSON.stringify(proof,null,2));console.log(id,proof.maxMean, differences.filter(d=>[0,72,73,129,130,183,184,185,228,229,230,312].includes(d.frame)));
}
