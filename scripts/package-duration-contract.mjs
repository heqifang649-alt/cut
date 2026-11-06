import {readFile,writeFile,copyFile,mkdir,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
const out='E:/cutflow-duration-8-18-20261102',base='D:/CUT-Releases/20261030-production-first-r11',candidate=path.join(out,'candidate'),bundle=path.join(out,'patch');
const hash=async f=>createHash('sha256').update(await readFile(f)).digest('hex');
const allowed=new Set(['lib/output-duration.mjs','lib/classic-multisource.mjs','lib/libtv-bridge.mjs','lib/libtv-auto-policy.mjs','worker/ai-ingest.mjs','worker/batch-renderer.mjs','worker/classic-multisource-analyze.mjs','worker/classic-multisource-executor.mjs','worker/libtv-guided-auto.mjs','worker/processor.mjs','worker/scheduler-v2-policy.mjs','worker/shot-scheduler.mjs','worker/service-runner.mjs','worker/recovery.mjs']);
const modules=[],unchanged=[];let diff='';const exec=promisify(execFile);
for(const dir of ['lib','worker'])for(const name of await readdir(path.join(base,dir))){
 if(!/\.(mjs|ts|py)$/.test(name))continue;
 const file=dir+'/'+name,oldHash=await hash(path.join(base,file)),newHash=await hash(path.join(candidate,file));
 if(oldHash===newHash){unchanged.push({file,sha256:oldHash});continue;}
 if(!allowed.has(file))throw Error('Unexpected candidate/production drift: '+file);
 modules.push({file,before:oldHash,after:newHash});
 for(const [kind,root] of [['before',base],['after',candidate]]){const target=path.join(bundle,kind,file);await mkdir(path.dirname(target),{recursive:true});await copyFile(path.join(root,file),target);}
 try{diff+=(await exec('git',['diff','--no-index','--',path.join(bundle,'before',file),path.join(bundle,'after',file)],{windowsHide:true})).stdout;}
 catch(e){if(e.code!==1)throw e;diff+=e.stdout;}
}
if(modules.length!==allowed.size)throw Error('Patch incomplete: '+modules.length);
const protectedFiles=[];
for(const file of ['config/cutflow-runtime.json','config/classic-task-isolation.json','config/classic-brand-activation.json','config/brand-copy-files.json','config/brand-bgm-directories.json','standards/quality-gate-v2-policy.json','worker/quality-gate-v2.mjs','worker/brand-bgm.mjs','lib/brand-copy-library.mjs','lib/brand-copy-match.mjs','lib/types.ts']){
 try{protectedFiles.push({file,sha256:await hash(path.join(base,file))});}catch(e){if(e.code!=='ENOENT')throw e;}
}
let webBuild=null;
const webRoot='D:/CUT-duration-build-20261102';
try{
 const buildId=(await readFile(webRoot+'/.next-production-first-r11/BUILD_ID','utf8')).trim();
 for(const m of modules)if(await hash(path.join(webRoot,m.file))!==m.after)throw Error('Web build source differs from module payload: '+m.file);
 webBuild={root:webRoot,directory:webRoot+'/.next-production-first-r11',buildId,servingBuildId:(await readFile(base+'/.next-production-first-r11/BUILD_ID','utf8')).trim(),deployed:false};
}catch(e){if(e.code!=='ENOENT')throw e;}
const manifest={createdAt:new Date().toISOString(),baseRoot:base,candidate,contract:{minimum:8,maximum:18,inclusive:true},deployed:false,modules,protectedFiles,webBuild,unchangedModuleCount:unchanged.length};
await writeFile(path.join(bundle,'manifest.json'),JSON.stringify(manifest,null,2));await writeFile(path.join(bundle,'duration-contract.diff'),diff);
const install=String.raw`param([switch]$Apply,[switch]$Rollback)
$ErrorActionPreference='Stop'
$bundle=Split-Path -Parent $MyInvocation.MyCommand.Path
$manifest=Get-Content -LiteralPath (Join-Path $bundle 'manifest.json') -Raw|ConvertFrom-Json
$release=[IO.Path]::GetFullPath($manifest.baseRoot)
if($release -ne 'D:\CUT-Releases\20261030-production-first-r11'){throw 'Unexpected release root'}
foreach($p in $manifest.protectedFiles){if((Get-FileHash -LiteralPath (Join-Path $release $p.file)).Hash.ToLower() -ne $p.sha256){throw ('Protected runtime changed: '+$p.file)}}
foreach($m in $manifest.modules){
  $target=[IO.Path]::GetFullPath((Join-Path $release $m.file))
  if(-not $target.StartsWith($release+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Target escapes release root'}
  $expected=if($Rollback){$m.after}else{$m.before}
  $desired=if($Rollback){$m.before}else{$m.after}
  $kind=if($Rollback){'before'}else{'after'}
  if((Get-FileHash -LiteralPath $target).Hash.ToLower() -ne $expected){throw ('Runtime drift: '+$m.file)}
  if((Get-FileHash -LiteralPath (Join-Path (Join-Path $bundle $kind) $m.file)).Hash.ToLower() -ne $desired){throw ('Payload changed: '+$m.file)}
}
if(-not $Apply){Write-Output 'Dry run passed. No production writes or restarts performed.';return}
if(-not $Rollback){
  $runtime=Get-Content -LiteralPath (Join-Path $release 'config/cutflow-runtime.json') -Raw|ConvertFrom-Json
  $workDrive=[IO.DriveInfo]::new([IO.Path]::GetPathRoot($runtime.workRoot))
  if($workDrive.AvailableFreeSpace -lt 20GB){throw 'Work disk is below the existing 20 GiB startup minimum. No files were installed.'}
}
$queue=Get-Content -LiteralPath (Join-Path $release 'data/service-queue.json') -Raw|ConvertFrom-Json
$classic=Get-Content -LiteralPath (Join-Path $release 'data/classic-multisource-records.json') -Raw|ConvertFrom-Json
if(@($queue.tasks|Where-Object {$_.status -in @('running','leased')}).Count -or @($classic|Where-Object {$_.status -in @('queued','uploading','editing')}).Count){throw 'Active tasks: wait for an authorized idle deployment window'}
$restoreKind=if($Rollback){'after'}else{'before'}
$kind=if($Rollback){'before'}else{'after'}
try{
  foreach($m in $manifest.modules){$target=Join-Path $release $m.file;$stage=$target+'.duration-contract.tmp';Copy-Item -LiteralPath (Join-Path (Join-Path $bundle $kind) $m.file) -Destination $stage;[IO.File]::Move($stage,$target,$true)}
  foreach($m in $manifest.modules){$desired=if($Rollback){$m.before}else{$m.after};if((Get-FileHash -LiteralPath (Join-Path $release $m.file)).Hash.ToLower() -ne $desired){throw 'Installed hash mismatch'}}
}catch{
  foreach($m in $manifest.modules){Copy-Item -LiteralPath (Join-Path (Join-Path $bundle $restoreKind) $m.file) -Destination (Join-Path $release $m.file) -Force}
  throw
}
Write-Output 'Module files updated. Web bundle not installed and no workers restarted. Follow the authorized deployment procedure.'
`;
await writeFile(path.join(bundle,'install.ps1'),install);
await writeFile(path.join(bundle,'ROLLBACK.md'),'# Rollback\n\nAfter deployment authorization, drain active jobs. Run install.ps1 -Rollback for read-only checks, then install.ps1 -Apply -Rollback to restore only the 14 backed-up module files. Reload the affected workers only with authorization. Verify heartbeats, hashes and service health. Do not reset, delete, or retry historical Batch records. Configuration, Quality Gate, brands, Provider and concurrency stay unchanged.\n');
console.log(JSON.stringify({bundle,modules:modules.map(m=>m.file),deployed:false},null,2));
