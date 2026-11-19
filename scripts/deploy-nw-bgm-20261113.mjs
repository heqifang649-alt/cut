import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
const exec=promisify(execFile),dir=path.resolve('.project-governance/evidence/nw-bgm-deployment-20261113');
const prepared=JSON.parse(await fs.readFile(path.join(dir,'prepared.json'))),root=prepared.live;
const {readJson,withFileLock}=await import(pathToFileURL(path.join(root,'lib/atomic-json.mjs')));
const hash=async p=>createHash('sha256').update(await fs.readFile(p)).digest('hex');
const rollback=process.argv.includes('--rollback');
const result=rollback?JSON.parse(await fs.readFile(path.join(dir,'deployment.json'))):{root,startedAt:new Date().toISOString(),files:prepared.files,protectedHashes:prepared.protectedHashes,status:'preflight'};
const save=()=>fs.writeFile(path.join(dir,rollback?'rollback.json':'deployment.json'),JSON.stringify(result,null,2));
const ps=async command=>JSON.parse((await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,timeout:10000})).stdout.trim()||'null');
const listCommand=`$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process -Filter "name = 'node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Replace('/','\\').Contains('D:\\CUT-Releases\\20261030-production-first-r11\\worker\\') -and $_.CommandLine -match 'classic-multisource-runner\\.mjs' } | ForEach-Object { [PSCustomObject]@{pid=$_.ProcessId;parent=$_.ParentProcessId;startedAt=$_.CreationDate.ToUniversalTime().ToString('o');command=$_.CommandLine} }) | ConvertTo-Json -Compress`;
const protectedCheck=async()=>{for(const[p,h]of Object.entries(prepared.protectedHashes))if(await hash(path.join(root,p))!==h)throw Error('PROTECTED_DRIFT:'+p);};
const restore=async()=>{for(const f of [...result.files].reverse()){
 const target=path.join(root,f.path);
 if(f.before){const backup=path.join(dir,'backup',f.path);if(await hash(backup)!==f.before)throw Error('BACKUP_HASH:'+f.path);await fs.copyFile(backup,target+'.nw-restore');await fs.rename(target+'.nw-restore',target);}
 else if(await fs.stat(target).catch(()=>null))await fs.rename(target,target+'.rollback-preserved-'+Date.now());
}};
async function locked(fn){return withFileLock(path.join(root,'data/classic-multisource-records.json'),()=>withFileLock(path.join(root,'data/service-queue.json'),fn));}
async function idle(){
 const records=await readJson(path.join(root,'data/classic-multisource-records.json'),[]),q=await readJson(path.join(root,'data/service-queue.json'),{});
 if(records.some(r=>r.lease||r.pendingCompletion||!['completed','review','failed','canceled'].includes(r.status))||(q.tasks||[]).some(t=>['running','leased','processing'].includes(t.status)))throw Error('ACTIVE_TASK_WAIT');
 result.idleCheckedAt=new Date().toISOString();
 return records;
}
async function reloadIdle(){
 const rows=await ps(listCommand),targets=Array.isArray(rows)?rows:rows?[rows]:[];
 if(targets.length!==1)throw Error('RUNNER_COUNT:'+targets.length);
 const pid=Number(targets[0].pid);if(!Number.isInteger(pid)||pid<1)throw Error('BAD_PID');
 await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command',`$ErrorActionPreference='Stop'; $p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if(!$p -or $p.CommandLine -notmatch 'classic-multisource-runner\\.mjs' -or !$p.CommandLine.Replace('/','\\').Contains('D:\\CUT-Releases\\20261030-production-first-r11\\worker\\')){throw 'PROCESS_IDENTITY_CHANGED'}; Stop-Process -Id ${pid} -Force`],{windowsHide:true,timeout:10000});
 result.oldRunner=targets[0];result.reloadRequestedAt=new Date().toISOString();
}
if(!rollback){
 const c=await fs.readFile(path.join(dir,'candidate-tests.log'),'utf8'),b=await fs.readFile(path.join(dir,'baseline-tests.log'),'utf8');
 if(!c.includes('pass 59')||!c.includes('fail 1')||!b.includes('pass 57')||!b.includes('fail 1'))throw Error('TEST_GATE');
 const failures=s=>[...s.matchAll(/^✖ (.+?) \([\d.]+ms\)/gm)].map(m=>m[1]);
 if(JSON.stringify(failures(c))!==JSON.stringify(failures(b)))throw Error('NEW_REGRESSION');
 for(const f of result.files){if(await hash(path.join(prepared.candidate,f.path))!==f.candidate)throw Error('CANDIDATE_DRIFT');await exec(process.execPath,['--check',path.join(prepared.candidate,f.path)]);}
 await exec(process.execPath,['--input-type=module','-e',`await import(${JSON.stringify(pathToFileURL(path.join(prepared.candidate,'worker/classic-multisource-executor.mjs')).href)});`]);
}
await fs.mkdir(path.join(dir,'backup'),{recursive:true});
// Retry only idle-window checks. No task, queue, claim flag or historical record is mutated.
for(let attempt=0;;attempt++){
 try{
 await locked(async()=>{
  const records=await idle();await protectedCheck();
  for(const f of result.files){const h=await hash(path.join(root,f.path)).catch(e=>{if(e.code==='ENOENT')return null;throw e;});if(h!==(rollback?f.candidate:f.before))throw Error('MODULE_DRIFT:'+f.path);}
  if(rollback){await restore();await reloadIdle();result.status='rolled_back';await save();return;}
  result.baselineRecords=Object.fromEntries(records.map(r=>[r.taskId,createHash('sha256').update(JSON.stringify(r)).digest('hex')]));
  result.baselineTaskIds=records.map(r=>r.taskId);
  for(const f of result.files)if(f.before){await fs.mkdir(path.dirname(path.join(dir,'backup',f.path)),{recursive:true});await fs.copyFile(path.join(root,f.path),path.join(dir,'backup',f.path));}
  result.status='backed_up';await save();
  try{
   // New dependency first; existing idle runner keeps old imports until all replacements are ready.
   for(const f of [...result.files].reverse()){const target=path.join(root,f.path);await fs.copyFile(path.join(prepared.candidate,f.path),target+'.nw-new');await fs.rename(target+'.nw-new',target);}
   for(const f of result.files)if(await hash(path.join(root,f.path))!==f.candidate)throw Error('INSTALLED_HASH');
   await exec(process.execPath,['--input-type=module','-e',`await import(${JSON.stringify(pathToFileURL(path.join(root,'worker/classic-multisource-executor.mjs')).href)});`]);
   await protectedCheck();result.installedAt=new Date().toISOString();await reloadIdle();result.status='installed';await save();
  }catch(e){await restore();result.status='rolled_back_after_error';result.error=e.message;await save();throw e;}
 });break;
 }catch(e){if(e.message!=='ACTIVE_TASK_WAIT'||attempt>=119)throw e;if(attempt%6===0)console.log('Waiting for idle window');await new Promise(r=>setTimeout(r,5000));}
}
console.log(JSON.stringify({status:result.status,oldRunner:result.oldRunner,installedAt:result.installedAt}));
