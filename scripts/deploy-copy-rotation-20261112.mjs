import fs from 'node:fs/promises';import path from 'node:path';import {createHash} from 'node:crypto';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
const exec=promisify(execFile),root='D:/CUT-Releases/20261030-production-first-r11',source=path.resolve('.project-governance/evidence/brand-copy-rotation-20261112/patch'),dest=path.resolve('.project-governance/evidence/brand-copy-rotation-20261112/deployment');
const {withFileLock,readJson}=await import('file:///D:/CUT-Releases/20261030-production-first-r11/lib/atomic-json.mjs');
const files=['lib/brand-copy-match.mjs','lib/brand-copy-history.mjs','worker/brand-copy-render.mjs'];
const configs=['config/cutflow-runtime.json','config/classic-brand-activation.json','config/brand-copy-files.json','config/brand-bgm-directories.json'];
const protectedFiles=['worker/batch-renderer.mjs','worker/classic-multisource-executor.mjs','worker/libtv-guided-auto.mjs','worker/shot-scheduler.mjs','worker/quality-gate-v2.mjs',...configs];
const hash=async p=>createHash('sha256').update(await fs.readFile(p)).digest('hex');
await fs.mkdir(dest,{recursive:true});
const before=Object.fromEntries(await Promise.all(protectedFiles.map(async p=>[p,await hash(path.join(root,p))])));
const result={startedAt:new Date().toISOString(),root,before,files:[],status:'preflight'};
const stopIdle=async()=>{
 const cmd=`$ErrorActionPreference='Stop'; $targets=@(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -and $_.CommandLine.Replace('/','\\').Contains('D:\\CUT-Releases\\20261030-production-first-r11\\worker\\') -and ($_.CommandLine -match 'classic-multisource-runner.mjs' -or ($_.CommandLine -match 'service-runner.mjs' -and $_.CommandLine -match '--service=render')) }); $targets | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress; foreach($target in $targets){ Stop-Process -Id $target.ProcessId -Force }`;
 return (await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command',cmd],{windowsHide:true})).stdout;
};
await withFileLock(path.join(root,'data/classic-multisource-records.json'),()=>withFileLock(path.join(root,'data/service-queue.json'),async()=>{
 const records=await readJson(path.join(root,'data/classic-multisource-records.json'),[]),queue=await readJson(path.join(root,'data/service-queue.json'),{});
 if(records.some(r=>r.lease||['running','processing','rendering'].includes(r.status))||(queue.tasks||[]).some(t=>['running','leased','processing'].includes(t.status)))throw Error('ACTIVE_TASK_REFUSE');
 result.idleCheckedAt=new Date().toISOString();result.baselineTaskIds=records.map(r=>r.taskId);
 for(const p of [...files,...configs]){const from=path.join(root,p);try{await fs.mkdir(path.dirname(path.join(dest,'backup',p)),{recursive:true});await fs.copyFile(from,path.join(dest,'backup',p));}catch(e){if(e.code!=='ENOENT')throw e;}}
 for(const p of files) result.files.push({path:p,before:await hash(path.join(root,p)).catch(()=>null),candidate:await hash(path.join(source,p))});
 // Pause only idle consumers while the claim locks prevent a task-start race.
 result.reloadedChildren=await stopIdle();
 try{
 for(const p of files){const temp=path.join(root,p+'.copy-rotation-new');await fs.copyFile(path.join(source,p),temp);await fs.rename(temp,path.join(root,p));}
 for(const p of files){await exec(process.execPath,['--check',path.join(root,p)]);if(await hash(path.join(root,p))!==result.files.find(f=>f.path===p).candidate)throw Error('HASH_MISMATCH');}
 await exec(process.execPath,['--input-type=module','-e',`await import('file:///D:/CUT-Releases/20261030-production-first-r11/worker/brand-copy-render.mjs');console.log('installed import passed')`]);
 result.status='installed';
 }catch(e){for(const f of result.files){if(f.before)await fs.copyFile(path.join(dest,'backup',f.path),path.join(root,f.path));else await fs.rename(path.join(root,f.path),path.join(root,f.path+'.rolled-back'));}result.status='rolled_back';result.error=e.message;throw e;}
}));
result.after=Object.fromEntries(await Promise.all(protectedFiles.map(async p=>[p,await hash(path.join(root,p))])));
result.protectedUnchanged=JSON.stringify(result.before)===JSON.stringify(result.after);result.finishedAt=new Date().toISOString();
await fs.writeFile(path.join(dest,'deployment.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({status:result.status,protectedUnchanged:result.protectedUnchanged,reloadedChildren:result.reloadedChildren}));
