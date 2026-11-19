import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
const run=promisify(execFile),dir=path.resolve('.project-governance/evidence/brand-bgm-unification-20261113/deployment');
const prepared=JSON.parse(await fs.readFile(path.join(dir,'prepared.json'))),root=prepared.root;
const {readJson,withFileLock}=await import(pathToFileURL(path.join(root,'lib/atomic-json.mjs')));
const hash=async p=>createHash('sha256').update(await fs.readFile(p)).digest('hex');
const rollback=process.argv.includes('--rollback');
const stores=['batches.json','service-queue.json','classic-multisource-records.json','libtv-receipts.json','templates.json','users.json'];
const dataHashes=async()=>Object.fromEntries(await Promise.all(stores.map(async f=>[f,await hash(path.join(root,'data',f))])));
const ps=async s=>JSON.parse((await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',"[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);"+s],{windowsHide:true,timeout:20000})).stdout.trim()||'null');
const processList=()=>ps(`@(Get-CimInstance Win32_Process -Filter "name = 'node.exe'" | Where-Object {$_.CommandLine -and $_.CommandLine.Replace('/','\\').Contains('D:\\CUT-Releases\\20261030-production-first-r11\\')} | ForEach-Object{[PSCustomObject]@{pid=$_.ProcessId;parent=$_.ParentProcessId;startedAt=$_.CreationDate.ToUniversalTime().ToString('o');command=$_.CommandLine}})|ConvertTo-Json -Compress`);
const protectedCheck=async()=>{for(const [p,h]of Object.entries(prepared.protectedHashes))if(await hash(path.join(root,p))!==h)throw Error('PROTECTED_DRIFT:'+p);};
const moduleCheck=async kind=>{for(const f of prepared.files){const actual=await hash(path.join(root,f.path)).catch(e=>{if(e.code==='ENOENT')return null;throw e;});if(actual!==f[kind])throw Error('MODULE_DRIFT:'+f.path);}};
const targets=rows=>rows.filter(p=>/worker[\\/](?:classic-multisource-runner|libtv-bridge-worker|service-runner)\.mjs/.test(p.command));
const idle=async()=>{
 const records=await readJson(path.join(root,'data/classic-multisource-records.json'),[]),queue=await readJson(path.join(root,'data/service-queue.json'),{});
 if(records.some(r=>r.lease||r.pendingCompletion||!['completed','review','failed','canceled'].includes(r.status))||(queue.tasks||[]).some(t=>t.lease||['running','leased','processing','queued','retry'].includes(t.status)))throw Error('ACTIVE_WORK_WAIT');
 const receipts=await readJson(path.join(root,'data/libtv-receipts.json'),[]);
 if(receipts.some(r=>['queued','importing','transferring','exporting'].includes(r.status)))throw Error('ACTIVE_WORK_WAIT');
 const hbDir=path.join(root,'data/service-heartbeats');let count=0;
 for(const f of await fs.readdir(hbDir)){if(!f.endsWith('.json'))continue;const h=await readJson(path.join(hbDir,f),null);if(h&&Date.now()-Date.parse(h.at)<30000){if(h.claimsEnabled!==false)throw Error('CLAIMS_NOT_DISABLED');count++;}}
 if(count!==9)throw Error('SERVICE_HEARTBEATS:'+count);
 return records;
};
const lockNames=['libtv-lan-scan','libtv-transfer-worker','classic-multisource-records.json','service-queue.json'];
const locked=(fn,i=0)=>i===lockNames.length?fn():withFileLock(path.join(root,'data',lockNames[i]),()=>locked(fn,i+1),{timeoutMs:12000});
const stopTargets=async rows=>{
 if(rows.length!==11||rows.filter(p=>p.command.includes('service-runner.mjs')).length!==9)throw Error('RELOAD_TARGET_COUNT');
 const checks=rows.map(p=>{const suffix=p.command.slice(p.command.indexOf('D:\\CUT-Releases\\'));if(!suffix)throw Error('PROCESS_SUFFIX');return `$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${Number(p.pid)}';if(!$p -or $p.ParentProcessId -ne ${Number(p.parent)} -or !$p.CommandLine.EndsWith('${suffix.replace(/'/g,"''")}') -or $p.CreationDate.ToUniversalTime().ToString('o') -ne '${p.startedAt}'){throw 'PROCESS_IDENTITY_CHANGED'};`;}).join('');
 await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',`$ErrorActionPreference='Stop';${checks} Stop-Process -Id ${rows.map(p=>Number(p.pid)).join(',')} -Force`],{windowsHide:true,timeout:20000});
};
const restore=async manifest=>{for(const f of [...manifest.files].reverse()){
 const dest=path.join(root,f.path);
 if(f.before){const backup=path.join(dir,'backup',f.path);if(await hash(backup)!==f.before)throw Error('INVALID_BACKUP:'+f.path);await fs.copyFile(backup,dest+'.bgm-restore');await fs.rename(dest+'.bgm-restore',dest);}
 else if(await fs.stat(dest).catch(()=>null))await fs.rename(dest,dest+'.rollback-preserved-'+Date.now());
}};
const rehearsal=async()=>{for(const f of prepared.files)if(f.before){const dest=path.join(dir,'rollback-rehearsal',f.path);await fs.mkdir(path.dirname(dest),{recursive:true});await fs.copyFile(path.join(dir,'backup',f.path),dest);if(await hash(dest)!==f.before)throw Error('REHEARSAL_HASH');}};
const output=path.join(dir,rollback?'rollback.json':'deployment.json');
let result;
if(rollback){result=await readJson(path.join(dir,'deployment.json'),null);if(result?.status!=='installed')throw Error('NO_INSTALLED_DEPLOYMENT');}
else{
 if(await fs.stat(output).catch(()=>null)){
  const old=await readJson(output,null);
  if(!process.argv.includes('--retry-guarded')||old?.status!=='backed_up')throw Error('DEPLOYMENT_ALREADY_EXISTS');
  await moduleCheck('before');await protectedCheck();
  old.status='restored_before_reload';old.error='Process identity comparison rejected because legacy PowerShell output encoding corrupted a non-ASCII executable path; all process checks preceded Stop-Process; production bytes restored.';
  await fs.writeFile(path.join(dir,'attempt-restored-before-reload.json'),JSON.stringify(old,null,2));
  await fs.rename(output,path.join(dir,'attempt-original-manifest.json'));
 }
 const log=await fs.readFile(path.join(dir,'candidate-tests.log'),'utf8');if(!/pass 52\b/.test(log)||!/fail 0\b/.test(log))throw Error('TEST_GATE');
 for(const [f,count]of [['original-brand-render-tests.log',12],['expanded-brand-render-tests.log',4],['direct-template-render-tests.log',2]]){
  const log=await fs.readFile(path.join(dir,f),'utf8');if(!log.includes('pass '+count)||!log.includes('fail 0'))throw Error('RENDER_TEST_GATE:'+f);
 }
 for(const f of prepared.files){if(await hash(path.join(prepared.candidate,f.path))!==f.candidate)throw Error('CANDIDATE_DRIFT');if(f.path.endsWith('.mjs'))await run(process.execPath,['--check',path.join(prepared.candidate,f.path)]);}
 result={root,startedAt:new Date().toISOString(),files:prepared.files,status:'preflight'};
}
for(let attempt=0;;attempt++){
 try{await locked(async()=>{
  const records=await idle();await protectedCheck();await moduleCheck(rollback?'candidate':'before');
  const processes=await processList(),reload=targets(processes);
  if(!processes.some(p=>p.command.includes('fleet-supervisor.mjs --no-claim')))throw Error('FLEET_IDENTITY');
  const route=await readJson(path.join(root,'config/classic-website-template.json'),null);if(route?.revision!=='classic-website-template/20261113-r1'||!route.enabled)throw Error('DIRECT_TEMPLATE_NOT_PRESERVED');
  const before=await dataHashes();
  if(rollback){await restore(result);await protectedCheck();await stopTargets(reload);result={...result,status:'rolled_back',rolledBackAt:new Date().toISOString(),rollbackReloaded:reload};}
  else{
   result.processesBefore=processes;result.dataBefore=before;result.historicalRecords=Object.fromEntries(records.map(r=>[r.taskId,createHash('sha256').update(JSON.stringify(r)).digest('hex')]));
   for(const f of result.files)if(f.before){const dest=path.join(dir,'backup',f.path);await fs.mkdir(path.dirname(dest),{recursive:true});await fs.copyFile(path.join(root,f.path),dest);if(await hash(dest)!==f.before)throw Error('BACKUP_HASH');}
   await rehearsal();result.rollbackRehearsal='exact-byte-restore-passed';result.status='backed_up';await fs.writeFile(output,JSON.stringify(result,null,2));
   try{
    // Dependency first, atomic replacements while claims/imports are guarded by existing locks.
    const order=['lib/brand-bgm-identity.mjs','worker/brand-bgm.mjs','lib/classic-brand-activation.mjs','worker/classic-multisource-bgm.mjs','config/brand-bgm-directories.json'];
    for(const p of order){const dest=path.join(root,p);await fs.copyFile(path.join(prepared.candidate,p),dest+'.bgm-new');await fs.rename(dest+'.bgm-new',dest);}
    await moduleCheck('candidate');await protectedCheck();
    await run(process.execPath,['--input-type=module','-e',`await import(${JSON.stringify(pathToFileURL(path.join(root,'worker/classic-multisource-executor.mjs')).href)});await import(${JSON.stringify(pathToFileURL(path.join(root,'worker/batch-renderer.mjs')).href)});`],{windowsHide:true,timeout:15000});
    result.installedAt=new Date().toISOString();await stopTargets(reload);result.reloaded=reload;result.status='installed';
   }catch(e){await restore(result);result.status='rolled_back_after_error';result.error=e.message;await fs.writeFile(output,JSON.stringify(result,null,2));await stopTargets(reload);throw e;}
  }
  result.dataAfter=await dataHashes();if(JSON.stringify(before)!==JSON.stringify(result.dataAfter))throw Error('BUSINESS_DATA_CHANGED');
  result.finishedAt=new Date().toISOString();await fs.writeFile(output,JSON.stringify(result,null,2));
 });break;}catch(e){if(e.message!=='ACTIVE_WORK_WAIT'||attempt>=59)throw e;console.log('Waiting for safe idle window');await new Promise(r=>setTimeout(r,5000));}
}
console.log(JSON.stringify({status:result.status,installedAt:result.installedAt,files:result.files.length,reloaded:result.reloaded?.map(p=>p.pid),rollbackRehearsal:result.rollbackRehearsal}));
