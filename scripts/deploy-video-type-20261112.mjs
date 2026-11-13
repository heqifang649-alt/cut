import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
const root='D:/CUT-Releases/20261030-production-first-r11';
const evidence=path.resolve('.project-governance/evidence/video-type-deployment-20261112');
const candidate=path.resolve('.video-type-production-candidate');
const dist='.next-video-type-20261112', oldDist='.next-owner-20261106';
const files=JSON.parse(await fs.readFile(path.join(evidence,'files.json'),'utf8'));
const {withFileLock,readJson}=await import('file:///D:/CUT-Releases/20261030-production-first-r11/lib/atomic-json.mjs');
const hash=async p=>createHash('sha256').update(await fs.readFile(p)).digest('hex');
const protectedFiles=['lib/brand-copy-match.mjs','lib/brand-copy-history.mjs','worker/brand-copy-render.mjs','worker/shot-scheduler.mjs','worker/guided-production-policy.mjs','worker/guided-safe-pool.mjs','worker/guided-render-v22.mjs','lib/libtv-guided-policy.mjs','config/cutflow-runtime.json','config/classic-brand-activation.json','config/brand-copy-files.json','config/brand-bgm-directories.json'];
const snapshots=async()=>Object.fromEntries(await Promise.all(protectedFiles.map(async p=>[p,await hash(path.join(root,p))])));
const manifest={root,dist,oldDist,startedAt:new Date().toISOString(),files:[],protectedBefore:await snapshots(),status:'preflight'};
const save=()=>fs.writeFile(path.join(evidence,'deployment.json'),JSON.stringify(manifest,null,2));
// No secrets are copied to evidence. Only the dist line of .env.local is changed.
async function changeDist(from,to){
 const p=path.join(root,'.env.local');const text=await fs.readFile(p,'utf8');
 if(!text.includes('CUTFLOW_NEXT_DIST_DIR='+from))throw Error('DIST_CONFIG_DRIFT');
 const updated=text.replace('CUTFLOW_NEXT_DIST_DIR='+from,'CUTFLOW_NEXT_DIST_DIR='+to);
 await fs.writeFile(p,updated);
 if((await fs.readFile(p,'utf8')).replace('CUTFLOW_NEXT_DIST_DIR='+to,'CUTFLOW_NEXT_DIST_DIR='+from)!==text)throw Error('ENV_OTHER_SETTING_CHANGED');
}
const powershell=cmd=>exec('powershell.exe',['-NoProfile','-NonInteractive','-Command',cmd],{windowsHide:true,maxBuffer:1024*1024});
async function reload(nextDist){
 await fs.writeFile(path.join(evidence,'empty.stdin'),'');
 const logRoot=evidence.replaceAll("'","''");
 const cmd=`$ErrorActionPreference='Stop'; $targets=@(Get-CimInstance Win32_Process -Filter "name = 'node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Replace('/','\\').Contains('D:\\CUT-Releases\\20261030-production-first-r11\\') -and ($_.CommandLine -match 'service-runner\\.mjs' -or $_.CommandLine -match '(libtv-bridge-worker|classic-multisource-runner)\\.mjs' -or $_.CommandLine -match 'next.*start.*3001') }); $summary=@($targets|ForEach-Object{[PSCustomObject]@{pid=$_.ProcessId;parent=$_.ParentProcessId}}); foreach($target in $targets){Stop-Process -Id $target.ProcessId -Force}; $env:CUTFLOW_NEXT_DIST_DIR='${nextDist}'; Start-Process -FilePath '${process.execPath.replaceAll("'","''")}' -ArgumentList @('D:\\CUT-Releases\\20261030-production-first-r11\\node_modules\\next\\dist\\bin\\next','start','-p','3001','-H','0.0.0.0') -WorkingDirectory 'D:\\CUT-Releases\\20261030-production-first-r11' -WindowStyle Hidden -RedirectStandardInput '${logRoot}/empty.stdin' -RedirectStandardOutput '${logRoot}/web.stdout.log' -RedirectStandardError '${logRoot}/web.stderr.log' | Out-Null; $summary|ConvertTo-Json -Compress`;
 return (await powershell(cmd)).stdout;
}
async function locked(fn){
 const locks=['classic-multisource-records.json','service-queue.json','libtv-receipts.json','batches.json'];
 const run=i=>i===locks.length?fn():withFileLock(path.join(root,'data',locks[i]),()=>run(i+1));return run(0);
}
await fs.mkdir(path.join(evidence,'backup'),{recursive:true});
if(process.argv.includes('--reload-workers')){
 await locked(async()=>{
  await assertIdle();
  const cmd=`$ErrorActionPreference='Stop'; $targets=@(Get-CimInstance Win32_Process -Filter "name = 'node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Replace('/','\\').Contains('D:\\CUT-Releases\\20261030-production-first-r11\\') -and ($_.CommandLine -match 'service-runner' -or $_.CommandLine -match 'libtv-bridge-worker' -or $_.CommandLine -match 'classic-multisource-runner') }); $targets|ForEach-Object{[PSCustomObject]@{pid=$_.ProcessId;parent=$_.ParentProcessId}}|ConvertTo-Json -Compress; foreach($target in $targets){Stop-Process -Id $target.ProcessId -Force}`;
  const result=await powershell(cmd);await fs.writeFile(path.join(evidence,'worker-reload.json'),JSON.stringify({at:new Date().toISOString(),stopped:JSON.parse(result.stdout)},null,2));
 });console.log('idle workers reloaded through unchanged supervisors');
}else if(process.argv.includes('--rollback')){
 const deployed=await readJson(path.join(evidence,'deployment.json'),null);if(!deployed)throw Error('MISSING_DEPLOYMENT');
 await locked(async()=>{
  await assertIdle();
  const rows=await readJson(path.join(root,'data/classic-multisource-records.json'),[]);
  const batches=await readJson(path.join(root,'data/batches.json'),[]);
  if(rows.some(r=>!['completed','review','failed','canceled'].includes(r.status)&&(r.videoType==='unboxing'||r.sources?.some(s=>s.videoType==='unboxing')))||batches.some(b=>b.videoType==='unboxing'&&!['completed','review','failed','canceled'].includes(b.status)))throw Error('PENDING_UNBOXING_REFUSE_ROLLBACK');
  for(const f of deployed.files){if(await hash(path.join(root,f.path)).catch(()=>null)!==f.candidate)throw Error('MODULE_DRIFT_REFUSE_ROLLBACK');}
  await restore(deployed);await reload(oldDist);
 });
 await fs.writeFile(path.join(evidence,'rollback.json'),JSON.stringify({at:new Date().toISOString(),restored:true,preservedData:true},null,2));
 console.log('rollback restored; runtime verification required');
}else{
 const testLog=await fs.readFile(path.join(evidence,'candidate-tests-final.log'),'utf8');
 if(!testLog.includes('fail 0')||!testLog.includes('tests 145'))throw Error('CANDIDATE_TEST_GATE');
 const buildLog=await fs.readFile(path.join(evidence,'build.log'),'utf8');if(!buildLog.includes('Dynamic)'))throw Error('BUILD_GATE');
 if(await fs.stat(path.join(root,dist)).catch(()=>null))throw Error('DIST_ALREADY_EXISTS');
 await fs.cp(path.join(candidate,dist),path.join(root,dist),{recursive:true,filter:p=>!p.includes(path.sep+'cache'+path.sep)&&path.basename(p)!=='cache'});
 manifest.buildId=(await fs.readFile(path.join(root,dist,'BUILD_ID'),'utf8')).trim();
 await locked(async()=>{
  await assertIdle();
  for(const p of files){
   const live=path.join(root,p),before=await hash(live).catch(()=>null);
   if(p!=='lib/video-type.mjs'&&before!==await hash(path.join(evidence,'original',p)))throw Error('PRODUCTION_DRIFT:'+p);
   if(p==='lib/video-type.mjs'&&before)throw Error('NEW_MODULE_EXISTS');
   if(before){await fs.mkdir(path.dirname(path.join(evidence,'backup',p)),{recursive:true});await fs.copyFile(live,path.join(evidence,'backup',p));}
   manifest.files.push({path:p,before,candidate:await hash(path.join(candidate,p))});
  }
  manifest.status='backed_up';await save();
  try{
   for(const f of manifest.files){const target=path.join(root,f.path);await fs.copyFile(path.join(candidate,f.path),target+'.video-type-new');await fs.rename(target+'.video-type-new',target);}
   for(const f of manifest.files){if(await hash(path.join(root,f.path))!==f.candidate)throw Error('INSTALL_HASH_MISMATCH');}
   await exec(process.execPath,['--input-type=module','-e',`await import('file:///D:/CUT-Releases/20261030-production-first-r11/worker/classic-multisource-executor.mjs');await import('file:///D:/CUT-Releases/20261030-production-first-r11/lib/libtv-bridge.mjs');`]);
   await changeDist(oldDist,dist);manifest.reloadedPids=await reload(dist);manifest.status='installed';
  }catch(e){manifest.error=e.message;await restore(manifest);await reload(oldDist);manifest.status='rolled_back';await save();throw e;}
 });
 manifest.protectedAfter=await snapshots();
 if(JSON.stringify(manifest.protectedBefore)!==JSON.stringify(manifest.protectedAfter))throw Error('PROTECTED_DRIFT');
 manifest.finishedAt=new Date().toISOString();await save();console.log(JSON.stringify({status:manifest.status,buildId:manifest.buildId,files:manifest.files.length,protectedUnchanged:true}));
}
async function assertIdle(){
 const records=await readJson(path.join(root,'data/classic-multisource-records.json'),[]),queue=await readJson(path.join(root,'data/service-queue.json'),{}),batches=await readJson(path.join(root,'data/batches.json'),[]),receipts=await readJson(path.join(root,'data/libtv-receipts.json'),[]);
 if(records.some(r=>r.lease||['running','processing','rendering'].includes(r.status))||(queue.tasks||[]).some(t=>['running','leased','processing'].includes(t.status))||batches.some(b=>['editing','revising','creating_proxies','detecting_products','analyzing_reference'].includes(b.status))||receipts.some(r=>r.status==='importing'))throw Error('ACTIVE_TASK_REFUSE');
 manifest.idleCheckedAt=new Date().toISOString();
 manifest.dataBefore=Object.fromEntries(await Promise.all(['batches.json','service-queue.json','classic-multisource-records.json','libtv-receipts.json','users.json','templates.json'].map(async p=>[p,await hash(path.join(root,'data',p)).catch(()=>null)])));
}
async function restore(m){
 for(const f of m.files){const target=path.join(root,f.path);if(f.before){if(await hash(path.join(evidence,'backup',f.path))!==f.before)throw Error('BACKUP_HASH_INVALID');await fs.copyFile(path.join(evidence,'backup',f.path),target);}else if(await fs.stat(target).catch(()=>null))await fs.rename(target,target+'.rollback-preserved-'+Date.now());}
 const text=await fs.readFile(path.join(root,'.env.local'),'utf8');if(text.includes('CUTFLOW_NEXT_DIST_DIR='+dist))await changeDist(dist,oldDist);
}
