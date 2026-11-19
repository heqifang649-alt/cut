import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const repo='D:/自动剪辑网站',root='D:/CUT-Releases/20261030-production-first-r11';
const dir=path.join(repo,'.project-governance/evidence/final-shot-boundary-20261117'),relative='worker/ootd-template-render.mjs';
const run=promisify(execFile),read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
const hash=async p=>createHash('sha256').update(await fs.readFile(p)).digest('hex');
const save=async(name,value)=>fs.writeFile(path.join(dir,name),JSON.stringify(value,null,2)+'\n');
const {withFileLock}=await import(pathToFileURL(path.join(root,'lib/atomic-json.mjs')));
const locks=['libtv-lan-scan','libtv-transfer-worker','classic-multisource-records.json','service-queue.json'];
const locked=(fn,i=0)=>i===locks.length?fn():withFileLock(path.join(root,'data',locks[i]),()=>locked(fn,i+1),{timeoutMs:12000});
const ps=async code=>JSON.parse((await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',"[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);$ErrorActionPreference='Stop';"+code],{windowsHide:true})).stdout.trim()||'null');
const processes=()=>ps(`@(Get-CimInstance Win32_Process -Filter "name='node.exe'" | Where-Object {$_.CommandLine -and $_.CommandLine.Contains('20261030-production-first-r11')} | ForEach-Object {[PSCustomObject]@{pid=$_.ProcessId;parent=$_.ParentProcessId;start=$_.CreationDate.ToUniversalTime().ToString('o');command=$_.CommandLine}})|ConvertTo-Json -Compress`);
const target=rows=>rows.filter(p=>/worker[\\/]classic-multisource-runner\.mjs/.test(p.command));
async function stop(p){
 const suffix=p.command.slice(p.command.indexOf('D:\\CUT-Releases\\'));
 assert.ok(suffix.startsWith('D:\\CUT-Releases\\20261030-production-first-r11\\worker\\classic-multisource-runner.mjs'));
 await ps(`$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${p.pid}';if(!$p -or $p.ParentProcessId -ne ${p.parent} -or $p.CreationDate.ToUniversalTime().ToString('o') -ne '${p.start}' -or !$p.CommandLine.EndsWith('${suffix.replaceAll("'","''")}')){throw 'PROCESS_IDENTITY_CHANGED'};Stop-Process -Id ${p.pid} -Force`);
}
const stores=['batches.json','service-queue.json','classic-multisource-records.json','libtv-receipts.json','templates.json','users.json'];
const dataHashes=async()=>Object.fromEntries(await Promise.all(stores.map(async p=>[p,await hash(path.join(root,'data',p))])));
async function idle(){
 const rows=await read(path.join(root,'data/classic-multisource-records.json'));
 const holds=await read(path.join(root,'config/classic-task-isolation.json'));
 // A freshly submitted, unclaimed task is safe under the claim lock. It stays
 // queued and can be consumed normally after unlock; no historical task resets.
 const safeQueued=r=>r.status==='queued'&&r.attempt===0&&Date.now()-Date.parse(r.acceptedAt)<30*60000;
 assert.ok(!rows.some(r=>r.lease||r.pendingCompletion||(!['completed','review','failed','canceled'].includes(r.status)&&!holds.tasks.includes(r.taskId)&&!safeQueued(r))),'ACTIVE_WORK_WAIT');
 const queue=await read(path.join(root,'data/service-queue.json'));
 assert.ok(!(queue.tasks||[]).some(t=>t.lease||['running','leased','processing'].includes(t.status)),'ACTIVE_SERVICE_WAIT');
 return rows;
}
const walk=async p=>(await Promise.all((await fs.readdir(p,{withFileTypes:true})).map(e=>e.isDirectory()?walk(path.join(p,e.name)):[path.join(p,e.name)]))).flat();
async function protectedCheck(m){for(const [p,h]of Object.entries(m.protected))assert.equal(await hash(path.join(root,p)),h,'PROTECTED_DRIFT:'+p);}
async function replace(from){const dest=path.join(root,relative);await fs.copyFile(from,dest+'.boundary-new');await fs.rename(dest+'.boundary-new',dest);}
const mode=process.argv[2];
if(mode==='--prepare'){
 assert.ok(!(await fs.stat(path.join(dir,'deployment.json')).catch(()=>null)));
 const result=await read(path.join(dir,'offline-regression/result.json'));assert.equal(result.real.encodedLayoutProven,true);assert.equal(result.fixtures.length,2);assert.ok(result.fixtures.every(f=>f.refused));
 const protectedHashes={};for(const folder of ['lib','worker','config'])for(const f of await walk(path.join(root,folder))){const p=path.relative(root,f).replaceAll('\\','/');if(p!==relative&&/\.(mjs|ts|json)$/.test(f))protectedHashes[p]=await hash(f);}
 for(const p of ['.env.local','.env.production','.env.production.local'])if(await fs.stat(path.join(root,p)).catch(()=>null))protectedHashes[p]=await hash(path.join(root,p));
 const m={at:new Date().toISOString(),root,relative,before:await hash(path.join(root,relative)),after:await hash(path.join(dir,'candidate',relative)),protected:protectedHashes};
 await fs.mkdir(path.join(dir,'backup'),{recursive:true});await fs.copyFile(path.join(root,relative),path.join(dir,'backup/ootd-template-render.mjs'));assert.equal(await hash(path.join(dir,'backup/ootd-template-render.mjs')),m.before);
 await fs.copyFile(path.join(dir,'backup/ootd-template-render.mjs'),path.join(dir,'rollback-rehearsal.mjs'));assert.equal(await hash(path.join(dir,'rollback-rehearsal.mjs')),m.before);
 await save('prepared.json',m);console.log(JSON.stringify({prepared:true,productionModules:1,protectedFiles:Object.keys(protectedHashes).length,rollbackBytesRehearsed:true}));
}else if(mode==='--deploy'||mode==='--rollback'){
 const m=await read(path.join(dir,'prepared.json')),rollback=mode==='--rollback';
 if(!rollback)assert.ok(!(await fs.stat(path.join(dir,'deployment.json')).catch(()=>null)),'ALREADY_INSTALLED');
 await locked(async()=>{
  const rows=await idle();await protectedCheck(m);assert.equal(await hash(path.join(root,relative)),rollback?m.after:m.before);
  const procs=await processes(),targets=target(procs);assert.equal(targets.length,1);
  const before=await dataHashes(),result={at:new Date().toISOString(),root,relative,protectedCount:Object.keys(m.protected).length,processesBefore:procs,old:targets[0],dataBefore:before,recordsBefore:rows.map(r=>({taskId:r.taskId,hash:createHash('sha256').update(JSON.stringify(r)).digest('hex')}))};
  await save(rollback?'rollback-start.json':'deployment-start.json',result);
  const from=rollback?path.join(dir,'backup/ootd-template-render.mjs'):path.join(dir,'candidate',relative);
  assert.equal(await hash(from),rollback?m.before:m.after);
  let stopped=false;
  try{
   await replace(from);assert.equal(await hash(path.join(root,relative)),rollback?m.before:m.after);await protectedCheck(m);
   await run(process.execPath,['--input-type=module','-e',`await import(${JSON.stringify(pathToFileURL(path.join(root,relative)).href)})`],{windowsHide:true});
   result.installedAt=new Date().toISOString();await stop(targets[0]);stopped=true;
   result.dataAfter=await dataHashes();assert.deepEqual(result.dataAfter,before);result.status=rollback?'rolled_back':'installed';
  }catch(error){
   if(!rollback){await replace(path.join(dir,'backup/ootd-template-render.mjs'));assert.equal(await hash(path.join(root,relative)),m.before);if(stopped){const current=target(await processes());if(current.length===1)await stop(current[0]);}}
   result.status='restored_after_error';result.error=error.message;await save('deployment-error.json',result);throw error;
  }
  await save(rollback?'rollback.json':'deployment.json',result);console.log(JSON.stringify({status:result.status,installedAt:result.installedAt,oldPid:targets[0].pid,businessDataUnchanged:true}));
 });
}else if(mode==='--verify'){
 const m=await read(path.join(dir,'prepared.json')),d=await read(path.join(dir,'deployment.json'));assert.equal(d.status,'installed');await protectedCheck(m);assert.equal(await hash(path.join(root,relative)),m.after);
 const rows=await processes(),t=target(rows);assert.equal(t.length,1);assert.ok(Date.parse(t[0].start)>Date.parse(d.installedAt));
 for(const p of d.processesBefore.filter(p=>p.pid!==d.old.pid))assert.ok(rows.some(r=>r.pid===p.pid&&r.start===p.start),'UNRELATED_PROCESS_CHANGED:'+p.pid);
 const h=await read(path.join(root,'data/classic-multisource-heartbeat.json'));assert.equal(h.pid,t[0].pid);assert.ok(Date.now()-Date.parse(h.at)<30000);assert.equal(h.directTemplateRevision,'classic-website-template/20261113-r1');
 const services=[];for(const file of await fs.readdir(path.join(root,'data/service-heartbeats'))){if(file.endsWith('.json')){const s=await read(path.join(root,'data/service-heartbeats',file));if(Date.now()-Date.parse(s.at)<30000)services.push(s);}}
 assert.equal(services.length,9);assert.ok(services.every(s=>s.claimsEnabled===false));
 const current=await read(path.join(root,'data/classic-multisource-records.json'));for(const old of d.recordsBefore){const r=current.find(r=>r.taskId===old.taskId);assert.equal(createHash('sha256').update(JSON.stringify(r)).digest('hex'),old.hash,'HISTORY_CHANGED');}
 const http={};for(const route of ['/','/api/health'])http[route]=(await fetch('http://127.0.0.1:3001'+route)).status;assert.equal(http['/'],200);assert.equal(http['/api/health'],401);
 const result={at:new Date().toISOString(),deployed:true,installedSha256:m.after,classic:t[0],heartbeat:h,unrelatedProcessesUnchanged:true,protectedFiles:Object.keys(m.protected).length,historicalRecordsUnchanged:true,services:services.map(s=>({pid:s.pid,claimsEnabled:s.claimsEnabled})),http};await save('runtime-verification.json',result);console.log(JSON.stringify({deployed:true,pid:t[0].pid,protectedFiles:result.protectedFiles,http}));
}else throw Error('--prepare / --deploy / --verify / --rollback');
