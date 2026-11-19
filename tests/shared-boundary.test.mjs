import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {boundaryConflict,verifyBoundaryConflict,boundaryCheckpointFile,finalOutputError} from '../lib/final-mp4-boundary.mjs';

const clock={fps:30,frameCount:120,width:96,height:96};
const result={encodedLayoutProven:false,plans:[{frame:0},{frame:59}],shots:[{duration:59/30},{duration:1/30},{duration:2}]};
test('conflict gate excludes normal/proven layouts and independently detected real short intervals',()=>{
 assert.equal(boundaryConflict({result,cuts:[{frame:60}],clock}),true);
 assert.equal(boundaryConflict({result:{...result,encodedLayoutProven:true},cuts:[{frame:60}],clock}),false);
 assert.equal(boundaryConflict({result:{...result,shots:[{duration:2}]},cuts:[{frame:60}],clock}),false);
 assert.equal(boundaryConflict({result,cuts:[{frame:59},{frame:60}],clock}),false);
});
async function input(){
 const editDir=await mkdtemp(path.join(os.tmpdir(),'cut-boundary-')),output=editDir+'/final.mp4',clip=editDir+'/clip.mp4';
 await writeFile(output,'immutable-final');await writeFile(clip,'immutable-clip');
 return {editDir,output,clips:[clip],clock,rawCounts:[121],requestedDuration:4,ffmpeg:'never-called',edl:{transition_profile:'hard_cut'},product:{product_id:'any-brand'}};
}
test('unsupported discrepancy is durable and can never launch a second verification',async()=>{
 const i=await input();i.rawCounts=[123];let calls=0;const run=async()=>{calls++;throw Error('must not decode');};
 const first=await verifyBoundaryConflict(i,{run}),second=await verifyBoundaryConflict(i,{run});
 assert.equal(first.state,'unconfirmed');assert.equal(first.reason,'unsupported_layout');assert.equal(second.reused,true);assert.equal(calls,0);
});
test('parallel attempts cannot consume a second automatic verification',async()=>{
 const i=await input();let calls=0,release;
 const blocked=new Promise(resolve=>{release=resolve;});
 const run=async()=>{calls++;await blocked;return {stdout:Buffer.alloc(120*9216)};};
 const first=verifyBoundaryConflict(i,{run});
 while(!calls)await new Promise(resolve=>setTimeout(resolve,5));
 const second=await verifyBoundaryConflict(i,{run});assert.equal(second.reason,'checkpoint_in_progress_or_interrupted');
 release();await first;assert.equal(calls,2); // final + one clip in one claimed run
});
test('deadline aborts a real child process and leaves other work free to finish',async()=>{
 const i=await input();let pid,closed=false;
 const run=(_exe,_args,options)=>new Promise((resolve,reject)=>{
  const child=execFile(process.execPath,['-e','setInterval(()=>{},1000)'],options,(error,stdout)=>error?reject(error):resolve({stdout}));
  pid=child.pid;child.on('close',()=>{closed=true;});
 });
 const start=Date.now();let otherCompleted=false;
 const [r]=await Promise.all([verifyBoundaryConflict(i,{run,timeoutMs:250}),new Promise(resolve=>setTimeout(()=>{otherCompleted=true;resolve();},20))]);
 assert.equal(r.reason,'verification_timeout');assert.ok(Date.now()-start<2000);assert.equal(otherCompleted,true);
 for(let n=0;n<100&&!closed;n++)await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal(closed,true);assert.throws(()=>process.kill(pid,0));
 const checkpoint=JSON.parse(await readFile(boundaryCheckpointFile(i.editDir,i.output),'utf8'));
 assert.equal(checkpoint.state,'unconfirmed');let again=0;
 const cached=await verifyBoundaryConflict(i,{run:async()=>{again++;}});assert.equal(cached.reused,true);assert.equal(again,0);
});
test('valid persistent proof reuses media verification and rejects changed artifacts',async()=>{
 const i=await input();let calls=0;
 const run=async(_exe,args)=>{calls++;return {stdout:Buffer.alloc((args[args.indexOf('-i')+1]===i.output?120:121)*9216)};};
 const first=await verifyBoundaryConflict(i,{run});assert.equal(first.state,'verified');assert.deepEqual(first.counts,[120]);
 assert.equal((await verifyBoundaryConflict(i,{run})).reused,true);assert.equal(calls,2);
 await writeFile(i.clips[0],'different-clip');
 const changed=await verifyBoundaryConflict(i,{run});assert.equal(changed.reason,'checkpoint_input_changed');assert.equal(calls,2);
});
test('interrupted/invalid checkpoint cannot be reclaimed or silently accepted',async()=>{
 const i=await input(),file=boundaryCheckpointFile(i.editDir,i.output);let calls=0;
 await verifyBoundaryConflict({...i,rawCounts:[123]});await writeFile(file,'incomplete-json');
 const r=await verifyBoundaryConflict(i,{run:async()=>{calls++;}});assert.equal(r.state,'unconfirmed');assert.equal(calls,0);
});
test('boundary and corruption errors preserve output without inventing a task state',()=>{
 for(const code of ['FINAL_MP4_BOUNDARY_UNCONFIRMED','FINAL_MP4_CORRUPT']){
  const e=finalOutputError(code,'test');assert.equal(e.code,code);assert.equal(e.retryable,false);assert.equal(e.preserveExistingOutput,true);assert.equal(e.stage,'render');
 }
});
test('no paid-provider or rendering module is a shared verifier dependency',async()=>{
 const source=await readFile(new URL('../lib/final-mp4-boundary.mjs',import.meta.url),'utf8');
 assert.deepEqual([...source.matchAll(/from ['"](\.[^'"]+)['"]/g)].map(m=>m[1]),['./atomic-json.mjs']);
});
