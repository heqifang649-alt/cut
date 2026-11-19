import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile),root='D:/CUT-Releases/20261030-production-first-r11',dir=path.resolve('.project-governance/evidence/direct-template-deployment-20261113'),candidate=path.resolve('.direct-template-candidate');
const files=JSON.parse(await fs.readFile(path.join(dir,'files.json'),'utf8'));
const configPath='config/classic-website-template.json',revision='classic-website-template/20261113-r1';
const {withFileLock,readJson,writeJsonAtomic}=await import('file:///D:/CUT-Releases/20261030-production-first-r11/lib/atomic-json.mjs');
const hash=async p=>createHash('sha256').update(await fs.readFile(p)).digest('hex');
const previous=await readJson(path.resolve('.project-governance/evidence/video-type-deployment-20261112/deployment.json'),null);
const protectedPaths=[...new Set([...previous.files.filter(f=>f.path!=='worker/classic-multisource-executor.mjs').map(f=>f.path),...Object.keys(previous.protectedBefore),'.env.local','worker/classic-multisource-quality.mjs','worker/classic-multisource-analyze.mjs','worker/quality-gate-v2.mjs'])];
const hashes=async paths=>Object.fromEntries(await Promise.all(paths.map(async p=>[p,await hash(path.join(root,p))])));
const stores=['batches.json','service-queue.json','classic-multisource-records.json','libtv-receipts.json','templates.json','users.json'];
const dataHashes=async()=>Object.fromEntries(await Promise.all(stores.map(async p=>[p,await hash(path.join(root,'data',p)).catch(()=>null)])));
const stopIdleClassic=async()=>{
 const script=`$ErrorActionPreference='Stop'; $targets=@(Get-CimInstance Win32_Process -Filter "name = 'node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Replace('/','\\').Contains('D:\\CUT-Releases\\20261030-production-first-r11\\') -and $_.CommandLine -match 'classic-multisource-runner' }); $targets|ForEach-Object{[PSCustomObject]@{pid=$_.ProcessId;parent=$_.ParentProcessId}}|ConvertTo-Json -Compress; foreach($target in $targets){Stop-Process -Id $target.ProcessId -Force}`;
 return (await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true})).stdout;
};
async function idle(){const rows=await readJson(path.join(root,'data/classic-multisource-records.json'),[]);if(rows.some(r=>r.lease||['uploading','editing','running','rendering','processing'].includes(r.status)))throw Error('ACTIVE_CLASSIC_TASK_REFUSE');return rows;}
await fs.mkdir(path.join(dir,'backup'),{recursive:true});
if(process.argv.includes('--rollback')){
 const m=await readJson(path.join(dir,'deployment.json'),null);if(!m||m.status!=='installed')throw Error('NO_INSTALLED_DEPLOYMENT');
 await withFileLock(path.join(root,'data/classic-multisource-records.json'),async()=>{
  const rows=await idle();
  for(const row of rows){const pinned=await readJson(path.join(root,'data/classic-website-template-contexts',row.taskId+'.json'),null);if(pinned?.state==='selected'&&!['completed','review','failed','canceled'].includes(row.status))throw Error('PENDING_PINNED_TASK_REFUSE_ROLLBACK');}
  for(const f of files)if(await hash(path.join(root,f.path))!==f.candidate)throw Error('MODULE_DRIFT_REFUSE_ROLLBACK');
  await writeJsonAtomic(path.join(root,configPath),{...m.activation,enabled:false});
  for(const f of files){const dest=path.join(root,f.path);if(f.before){const backup=path.join(dir,'backup',f.path);if(await hash(backup)!==f.before)throw Error('BACKUP_HASH_INVALID');await fs.copyFile(backup,dest);}else await fs.rename(dest,dest+'.rollback-preserved-'+Date.now());}
  if(m.configBefore)await fs.copyFile(path.join(dir,'backup',configPath),path.join(root,configPath));
  const stopped=await stopIdleClassic();await writeJsonAtomic(path.join(dir,'rollback.json'),{at:new Date().toISOString(),restored:true,stopped,preservedTasks:true});
 });console.log('direct template routing rolled back; original supervisor retained');
}else{
 if(await fs.stat(path.join(dir,'deployment.json')).catch(()=>null))throw Error('DEPLOYMENT_ALREADY_RECORDED');
 const final=await fs.readFile(path.join(dir,'final-tests.log'),'utf8'),legacy=await fs.readFile(path.join(dir,'legacy-tests.log'),'utf8');if(!final.includes('tests 26')||!final.includes('fail 0')||!legacy.includes('tests 56')||!legacy.includes('fail 0'))throw Error('TEST_GATE');
 const m={root,revision,startedAt:new Date().toISOString(),files,protectedBefore:await hashes(protectedPaths),status:'preflight'};
 await withFileLock(path.join(root,'data/classic-multisource-records.json'),async()=>{
  const rows=await idle();m.dataBefore=await dataHashes();
  for(const f of files){if(await hash(path.join(root,f.path)).catch(()=>null)!==f.before)throw Error('PRODUCTION_DRIFT:'+f.path);if(await hash(path.join(candidate,f.path))!==f.candidate)throw Error('CANDIDATE_DRIFT');if(f.before){const dest=path.join(dir,'backup',f.path);await fs.mkdir(path.dirname(dest),{recursive:true});await fs.copyFile(path.join(root,f.path),dest);}}
  m.configBefore=await hash(path.join(root,configPath)).catch(()=>null);if(m.configBefore)throw Error('EXISTING_ROUTING_CONFIG_REQUIRES_REVIEW');
  m.activation={enabled:true,revision,activatedAt:new Date().toISOString(),existingTaskIds:rows.map(r=>r.taskId)};
  await writeJsonAtomic(path.join(dir,'deployment.json'),m);
  try{
   for(const f of files){const dest=path.join(root,f.path);await fs.copyFile(path.join(candidate,f.path),dest+'.direct-template-new');await fs.rename(dest+'.direct-template-new',dest);}
   for(const f of files)if(await hash(path.join(root,f.path))!==f.candidate)throw Error('INSTALL_HASH_INVALID');
   await exec(process.execPath,['--input-type=module','-e',`await import('file:///D:/CUT-Releases/20261030-production-first-r11/worker/classic-multisource-context.mjs');await import('file:///D:/CUT-Releases/20261030-production-first-r11/worker/classic-multisource-executor.mjs');`],{timeout:30000});
   await writeJsonAtomic(path.join(root,configPath),m.activation);
   m.reloadedChildren=await stopIdleClassic();m.status='installed';
  }catch(error){
   await writeJsonAtomic(path.join(root,configPath),{...m.activation,enabled:false});
   for(const f of files){if(f.before)await fs.copyFile(path.join(dir,'backup',f.path),path.join(root,f.path));else if(await fs.stat(path.join(root,f.path)).catch(()=>null))await fs.rename(path.join(root,f.path),path.join(root,f.path)+'.rollback-preserved-'+Date.now());}
   m.reloadedChildren=await stopIdleClassic();m.status='rolled_back';m.error=error.message;await writeJsonAtomic(path.join(dir,'deployment.json'),m);throw error;
  }
  m.dataAfter=await dataHashes();m.protectedAfter=await hashes(protectedPaths);m.finishedAt=new Date().toISOString();
  if(JSON.stringify(m.protectedBefore)!==JSON.stringify(m.protectedAfter))throw Error('PROTECTED_DRIFT');
  await writeJsonAtomic(path.join(dir,'deployment.json'),m);
 });console.log(JSON.stringify({status:m.status,activation:m.activation.activatedAt,excludedExisting:m.activation.existingTaskIds.length,files:files.length,reloadedChildren:m.reloadedChildren}));
}
