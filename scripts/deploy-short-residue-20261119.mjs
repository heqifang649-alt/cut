import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import assert from 'node:assert/strict';
const run=promisify(execFile),root='D:/CUT-Releases/20261030-production-first-r11';
const base=path.resolve('.project-governance/evidence/short-residue-20261119'),dir=base+'/deployment';
const read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
const hash=async p=>createHash('sha256').update(await fs.readFile(p)).digest('hex');
const save=async(name,value)=>fs.writeFile(dir+'/'+name,JSON.stringify(value,null,2)+'\n');
const exists=async p=>!!(await fs.stat(p).catch(e=>{if(e.code==='ENOENT')return null;throw e;}));
const {withFileLock}=await import(pathToFileURL(root+'/lib/atomic-json.mjs'));
const lockNames=['libtv-lan-scan','libtv-transfer-worker','classic-multisource-records.json','service-queue.json'];
const locked=(fn,i=0)=>i===lockNames.length?fn():withFileLock(root+'/data/'+lockNames[i],()=>locked(fn,i+1),{timeoutMs:12000});
const ps=async code=>JSON.parse((await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',"[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);$ErrorActionPreference='Stop';"+code],{windowsHide:true,timeout:20000})).stdout.trim()||'null');
const processes=()=>ps(`@(Get-CimInstance Win32_Process -Filter "name='node.exe'" | Where-Object {$_.CommandLine -and $_.CommandLine.Contains('20261030-production-first-r11')} | ForEach-Object {[PSCustomObject]@{pid=$_.ProcessId;parent=$_.ParentProcessId;start=$_.CreationDate.ToUniversalTime().ToString('o');command=$_.CommandLine}})|ConvertTo-Json -Compress`);
const targets=rows=>rows.filter(p=>/worker[\\/]classic-multisource-runner\.mjs/.test(p.command));
async function stop(p){
 const command=p.command.replaceAll("'","''");
 assert.ok(/D:[\\/]CUT-Releases[\\/]20261030-production-first-r11[\\/]worker[\\/]classic-multisource-runner\.mjs/.test(p.command));
 await ps(`$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${p.pid}';if(!$p -or $p.ParentProcessId -ne ${p.parent} -or $p.CreationDate.ToUniversalTime().ToString('o') -ne '${p.start}' -or $p.CommandLine -ne '${command}'){throw 'PROCESS_IDENTITY_CHANGED'};Stop-Process -Id ${p.pid} -Force`);
}
const stores=['batches.json','service-queue.json','classic-multisource-records.json','libtv-receipts.json','templates.json','users.json'];
const dataHashes=async()=>Object.fromEntries(await Promise.all(stores.map(async p=>[p,await hash(root+'/data/'+p)])));
async function idle(){
 const rows=await read(root+'/data/classic-multisource-records.json'),holds=await read(root+'/config/classic-task-isolation.json');
 assert.ok(!rows.some(r=>r.lease||r.pendingCompletion||(!['completed','review','failed','canceled'].includes(r.status)&&!holds.tasks.includes(r.taskId))),'ACTIVE_CLASSIC_WAIT');
 const q=await read(root+'/data/service-queue.json');
 assert.ok(!(Array.isArray(q)?q:q.tasks||[]).some(t=>t.lease||['running','leased','processing'].includes(t.status)),'ACTIVE_SERVICE_WAIT');
 return rows;
}
const walk=async p=>(await Promise.all((await fs.readdir(p,{withFileTypes:true})).map(e=>e.isDirectory()?walk(path.join(p,e.name)):[path.join(p,e.name)]))).flat();
async function protectedCheck(m){for(const [file,expected]of Object.entries(m.protected))assert.equal(await hash(root+'/'+file),expected,'PROTECTED_DRIFT:'+file);}
async function checkFiles(m,installed){for(const f of m.files){const expected=installed?f.candidateSha256:f.productionSha256;if(expected)assert.equal(await hash(root+'/'+f.file),expected,'MODULE_DRIFT:'+f.file);else assert.equal(await exists(root+'/'+f.file),false,'UNEXPECTED_MODULE:'+f.file);}}
async function replace(from,file){const dest=root+'/'+file;await fs.copyFile(from,dest+'.short-residue-new');await fs.rename(dest+'.short-residue-new',dest);}
async function restore(m){
 for(const f of [...m.files].reverse()){
  if(!f.added){assert.equal(await hash(dir+'/backup/'+f.file),f.productionSha256);await replace(dir+'/backup/'+f.file,f.file);}
  else if(await exists(root+'/'+f.file)){
   assert.equal(await hash(root+'/'+f.file),f.candidateSha256);
   await fs.rename(root+'/'+f.file,root+'/'+f.file+'.rollback-preserved-'+Date.now());
  }
 }
 await checkFiles(m,false);
}
async function importInstalled(){
 const code=`await import(${JSON.stringify(pathToFileURL(root+'/worker/classic-multisource-executor.mjs').href)});await import(${JSON.stringify(pathToFileURL(root+'/lib/short-residue-repair.mjs').href)});`;
 await run(process.execPath,['--input-type=module','-e',code],{windowsHide:true,timeout:30000});
}
await fs.mkdir(dir,{recursive:true});const mode=process.argv[2];
if(mode==='--prepare'){
 assert.equal(await exists(dir+'/deployment.json'),false,'ALREADY_DEPLOYED');
 const delivery=await read(base+'/delivery.json'),baseline=await read(base+'/manifest.json'),checks=await read(base+'/candidate-checks.json');
 assert.equal(checks.testExitCode,0);assert.equal(checks.lintExitCode,0);
 const regression=await read(base+'/latest-verification.json');assert.equal(regression.cases.length,14);
 assert.ok(regression.cases.every(c=>c.pass||c.rejected));
 for(const f of baseline.files)assert.equal(await hash(root+'/'+f.file),f.sha256,'PRODUCTION_DRIFT:'+f.file);
 const files=delivery.files.map(f=>({...f,productionSha256:f.baselineSha256,added:f.baselineSha256===null}));assert.equal(files.length,5);const excluded=new Set(files.map(f=>f.file));
 assert.deepEqual(files.map(f=>f.file),['lib/short-residue-repair.mjs','lib/internal-cut-repair.mjs','worker/batch-renderer.mjs','worker/classic-multisource-executor.mjs','lib/classic-multisource.mjs']);
 assert.equal(await exists(root+'/lib/short-residue-repair.mjs'),false,'UNEXPECTED_NEW_MODULE');
 const protectedHashes={};
 for(const folder of ['lib','worker','config'])for(const file of await walk(root+'/'+folder)){
  const rel=path.relative(root,file).replaceAll('\\','/');if(!excluded.has(rel)&&/\.(mjs|ts|json|py)$/.test(file))protectedHashes[rel]=await hash(file);
 }
 for(const name of ['.env.local','.env.production','.env.production.local'])if(await exists(root+'/'+name))protectedHashes[name]=await hash(root+'/'+name);
 for(const f of files){
  assert.equal(await hash(base+'/candidate/'+f.file),f.candidateSha256,'CANDIDATE_DRIFT');
  await run(process.execPath,['--check',base+'/candidate/'+f.file],{windowsHide:true});
  if(!f.added){await fs.mkdir(path.dirname(dir+'/backup/'+f.file),{recursive:true});await fs.copyFile(root+'/'+f.file,dir+'/backup/'+f.file);assert.equal(await hash(dir+'/backup/'+f.file),f.productionSha256);}
 }
 const rehearsal=dir+'/rollback-rehearsal';
 for(const f of files){const p=rehearsal+'/'+f.file;await fs.mkdir(path.dirname(p),{recursive:true});await fs.copyFile(base+'/candidate/'+f.file,p);if(f.added)await fs.rename(p,p+'.rollback-preserved');else {await fs.copyFile(dir+'/backup/'+f.file,p);assert.equal(await hash(p),f.productionSha256);}}
 await save('prepared.json',{at:new Date().toISOString(),root,files,protected:protectedHashes,rollbackBytesRehearsed:true});
 console.log(JSON.stringify({prepared:true,files:files.length,protectedFiles:Object.keys(protectedHashes).length,productionChanged:false}));
}else if(mode==='--deploy'||mode==='--rollback'){
 const m=await read(dir+'/prepared.json'),rollback=mode==='--rollback';
 if(!rollback)assert.equal(await exists(dir+'/deployment.json'),false,'ALREADY_DEPLOYED');
 await locked(async()=>{
  const records=await idle();await protectedCheck(m);await checkFiles(m,rollback);
  for(const f of m.files)assert.equal(await hash(base+'/candidate/'+f.file),f.candidateSha256);
  const rows=await processes(),child=targets(rows);assert.equal(child.length,1);
  assert.ok(rows.some(p=>p.pid===child[0].parent&&/auxiliary-supervisor\.mjs.*--worker=multisource/.test(p.command)),'SUPERVISOR_MISSING');
  const result={at:new Date().toISOString(),root,files:m.files,processesBefore:rows,old:child[0],dataBefore:await dataHashes(),recordsBefore:records.map(r=>({taskId:r.taskId,hash:createHash('sha256').update(JSON.stringify(r)).digest('hex')}))};
  await save(rollback?'rollback-start.json':'deployment-start.json',result);
  let mutated=false;
  try{
   if(rollback){mutated=true;await restore(m);}else{
    // Install dependency before importers. No running task exists under locks.
    for(const f of [...m.files].sort((a,b)=>Number(!!b.added)-Number(!!a.added))){mutated=true;await replace(base+'/candidate/'+f.file,f.file);}
    await checkFiles(m,true);await importInstalled();
   }
   await protectedCheck(m);
   result.dataAfter=await dataHashes();assert.deepEqual(result.dataAfter,result.dataBefore);
   result.installedAt=new Date().toISOString();await stop(child[0]);
   result.status=rollback?'rolled_back':'installed';
   await save(rollback?'rollback.json':'deployment.json',result);
  }catch(error){
   result.error=error.message;
   if(!rollback&&mutated){await restore(m);const current=targets(await processes());if(current.length===1)await stop(current[0]);result.status='restored_after_error';}
   await save('deployment-error.json',result);throw error;
  }
  console.log(JSON.stringify({status:result.status,installedAt:result.installedAt,oldPid:child[0].pid,files:m.files.length,businessDataUnchanged:true}));
 });
}else if(mode==='--verify'){
 const m=await read(dir+'/prepared.json'),d=await read(dir+'/deployment.json');assert.equal(d.status,'installed');
 await checkFiles(m,true);await protectedCheck(m);await importInstalled();
 const rows=await processes(),child=targets(rows);assert.equal(child.length,1);assert.ok(Date.parse(child[0].start)>Date.parse(d.installedAt));
 for(const p of d.processesBefore.filter(p=>p.pid!==d.old.pid))assert.ok(rows.some(r=>r.pid===p.pid&&r.start===p.start),'UNRELATED_PROCESS_CHANGED:'+p.pid);
 const heartbeat=await read(root+'/data/classic-multisource-heartbeat.json');assert.equal(heartbeat.pid,child[0].pid);assert.ok(Date.now()-Date.parse(heartbeat.at)<30000);assert.equal(heartbeat.directTemplateRevision,'classic-website-template/20261113-r1');
 const services=[];for(const file of await fs.readdir(root+'/data/service-heartbeats'))if(file.endsWith('.json')){const s=await read(root+'/data/service-heartbeats/'+file);if(Date.now()-Date.parse(s.at)<30000)services.push(s);}
 assert.equal(services.length,9);assert.ok(services.every(s=>s.claimsEnabled===false));
 const records=await read(root+'/data/classic-multisource-records.json');for(const old of d.recordsBefore){const r=records.find(x=>x.taskId===old.taskId);assert.equal(createHash('sha256').update(JSON.stringify(r)).digest('hex'),old.hash,'HISTORY_CHANGED:'+old.taskId);}
 const http={};for(const route of ['/','/api/health'])http[route]=(await fetch('http://127.0.0.1:3001'+route,{signal:AbortSignal.timeout(10000)})).status;
 assert.equal(http['/'],200);assert.equal(http['/api/health'],401);
 const result={at:new Date().toISOString(),deployed:true,root,files:m.files,classic:child[0],heartbeat,unrelatedProcessesUnchanged:true,protectedFiles:Object.keys(m.protected).length,historicalRecordsUnchanged:true,services:services.map(s=>({pid:s.pid,claimsEnabled:s.claimsEnabled})),http};
 await save('runtime-verification.json',result);console.log(JSON.stringify({deployed:true,pid:child[0].pid,protectedFiles:result.protectedFiles,http}));
}else throw Error('--prepare / --deploy / --verify / --rollback');
