import fs from 'node:fs/promises';import path from 'node:path';import {createHash} from 'node:crypto';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
const exec=promisify(execFile),dir=path.resolve('.project-governance/evidence/brand-copy-rotation-20261112/deployment'),m=JSON.parse(await fs.readFile(path.join(dir,'deployment.json'),'utf8')),root=m.root;
const {withFileLock,readJson}=await import('file:///D:/CUT-Releases/20261030-production-first-r11/lib/atomic-json.mjs');
const hash=async p=>createHash('sha256').update(await fs.readFile(p)).digest('hex');
await withFileLock(path.join(root,'data/classic-multisource-records.json'),()=>withFileLock(path.join(root,'data/service-queue.json'),async()=>{
const records=await readJson(path.join(root,'data/classic-multisource-records.json'),[]),q=await readJson(path.join(root,'data/service-queue.json'),{});
if(records.some(r=>r.lease||['running','processing','rendering'].includes(r.status))||(q.tasks||[]).some(t=>['running','leased','processing'].includes(t.status)))throw Error('ACTIVE_TASK_REFUSE');
for(const f of m.files){if(await hash(path.join(root,f.path))!==f.candidate)throw Error('PRODUCTION_MODULE_DRIFT');if(f.before&&await hash(path.join(dir,'backup',f.path))!==f.before)throw Error('BACKUP_HASH_MISMATCH');}
await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command',`$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -and $_.CommandLine.Replace('/','\\').Contains('D:\\CUT-Releases\\20261030-production-first-r11\\worker\\') -and ($_.CommandLine -match 'classic-multisource-runner.mjs' -or ($_.CommandLine -match 'service-runner.mjs' -and $_.CommandLine -match '--service=render')) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`],{windowsHide:true});
for(const f of m.files){if(f.before){await fs.copyFile(path.join(dir,'backup',f.path),path.join(root,f.path));if(await hash(path.join(root,f.path))!==f.before)throw Error('RESTORE_HASH_MISMATCH');}else await fs.rename(path.join(root,f.path),path.join(root,f.path+'.rollback-preserved-'+Date.now()));}
await fs.writeFile(path.join(dir,'rollback-result.json'),JSON.stringify({at:new Date().toISOString(),status:'restored',preservedHistory:true},null,2));
}));console.log('Only copy patch restored; existing supervisors reload idle consumers.');
