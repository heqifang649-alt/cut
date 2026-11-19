import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath,pathToFileURL} from 'node:url';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const root='D:/CUT-Releases/20261030-production-first-r11';
const source='E:/DevCache/tmp/cut-0047-7d20b3e6-63a2-4259-812b-710866648f34';
const dir=path.join(repo,'.project-governance/evidence/brand-mapping-0047-deployment');
const candidate=path.join(dir,'candidate'),manifestFile=path.join(dir,'prepared.json'),deploymentFile=path.join(dir,'deployment.json');
const execute=promisify(execFile),run=(exe,args,timeout=20000)=>execute(exe,args,{windowsHide:true,timeout,maxBuffer:4*1024*1024});
const digest=b=>createHash('sha256').update(b).digest('hex'),hash=async f=>digest(await fs.readFile(f));
const read=async f=>JSON.parse(await fs.readFile(f,'utf8'));
const save=async(f,v)=>{await fs.mkdir(path.dirname(f),{recursive:true});await fs.writeFile(f,JSON.stringify(v,null,2)+'\n');};
const ps=async command=>JSON.parse((await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',"[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);$ErrorActionPreference='Stop';"+command])).stdout.trim()||'null');
const processes=()=>ps(`@(Get-CimInstance Win32_Process -Filter "name = 'node.exe'" | Where-Object {$_.CommandLine -and $_.CommandLine.Replace('/','\\').Contains('D:\\CUT-Releases\\20261030-production-first-r11\\')} | ForEach-Object{[PSCustomObject]@{pid=$_.ProcessId;parent=$_.ParentProcessId;startedAt=$_.CreationDate.ToUniversalTime().ToString('o');command=$_.CommandLine}})|ConvertTo-Json -Compress`);
const targets=rows=>rows.filter(p=>/worker[\\/](?:classic-multisource-runner|libtv-bridge-worker|service-runner)\.mjs/.test(p.command));
const stores=['batches.json','service-queue.json','classic-multisource-records.json','libtv-receipts.json','templates.json','users.json'];
const dataHashes=async()=>Object.fromEntries(await Promise.all(stores.map(async f=>[f,await hash(path.join(root,'data',f))])));
const walk=async p=>(await Promise.all((await fs.readdir(p,{withFileTypes:true})).map(e=>e.isDirectory()?walk(path.join(p,e.name)):[path.join(p,e.name)]))).flat();
const {withFileLock}=await import(pathToFileURL(path.join(root,'lib/atomic-json.mjs')));
const locks=['libtv-lan-scan','libtv-transfer-worker','classic-multisource-records.json','service-queue.json'];
const locked=(fn,i=0)=>i===locks.length?fn():withFileLock(path.join(root,'data',locks[i]),()=>locked(fn,i+1),{timeoutMs:12000});
async function idle(){
 const records=await read(path.join(root,'data/classic-multisource-records.json')),queue=await read(path.join(root,'data/service-queue.json')),receipts=await read(path.join(root,'data/libtv-receipts.json'));
 if(records.some(r=>r.lease||r.pendingCompletion||!['completed','review','failed','canceled'].includes(r.status))||(queue.tasks||[]).some(t=>t.lease||['running','leased','processing','queued','retry'].includes(t.status))||receipts.some(r=>['queued','importing','transferring','exporting'].includes(r.status)))throw Error('ACTIVE_WORK_WAIT');
 const services=[];for(const f of await fs.readdir(path.join(root,'data/service-heartbeats'))){if(!f.endsWith('.json'))continue;const h=await read(path.join(root,'data/service-heartbeats',f));if(Date.now()-Date.parse(h.at)<30000)services.push(h);}
 assert.equal(services.length,9,'FRESH_SERVICE_COUNT');assert.ok(services.every(h=>h.claimsEnabled===false),'CLAIMS_CHANGED');
 const route=await read(path.join(root,'config/classic-website-template.json'));assert.equal(route.enabled,true);assert.equal(route.revision,'classic-website-template/20261113-r1');return records;
}
async function protectedCheck(m){for(const [relative,h] of Object.entries(m.protectedHashes))assert.equal(await hash(path.join(root,relative)),h,'PROTECTED_DRIFT:'+relative);}
async function moduleCheck(m,kind){for(const f of m.files)assert.equal(await hash(path.join(root,f.relative)),f[kind],'PRODUCTION_VERSION_CONFLICT:'+f.relative);}
async function stop(rows){
 assert.equal(rows.length,11);assert.equal(rows.filter(r=>r.command.includes('service-runner.mjs')).length,9);
 const checks=rows.map(p=>{const suffix=p.command.slice(p.command.indexOf('D:\\CUT-Releases\\'));assert.ok(suffix.startsWith('D:\\CUT-Releases\\'));return `$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${Number(p.pid)}';if(!$p -or $p.ParentProcessId -ne ${Number(p.parent)} -or !$p.CommandLine.EndsWith('${suffix.replaceAll("'","''")}') -or $p.CreationDate.ToUniversalTime().ToString('o') -ne '${p.startedAt}'){throw 'PROCESS_IDENTITY_CHANGED'};`;}).join('');
 await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',"$ErrorActionPreference='Stop';"+checks+`Stop-Process -Id ${rows.map(r=>Number(r.pid)).join(',')} -Force`]);
}
async function replace(relative,from){const dest=path.join(root,relative),temp=dest+'.0047-new';await fs.copyFile(from,temp);await fs.rename(temp,dest);}
async function restore(m){
 // Restore exact modules; old PPH->泛读书 must never resume business music lookup.
 for(const f of [...m.files].reverse()){assert.equal(await hash(path.join(dir,'backup',f.relative)),f.before);await replace(f.relative,path.join(dir,'backup',f.relative));}
 // Keep the user-correct routing: old identity rejects this PPH directory and PW is unrecognized, so both safely mute.
 const config=JSON.parse(await fs.readFile(path.join(dir,'backup/config/brand-bgm-directories.json'),'utf8'));config.PPH='魔法';config.PW='泛读书';
 const safety=path.join(dir,'rollback-safe-mapping.json');await save(safety,config);await replace('config/brand-bgm-directories.json',safety);
}
async function checkFunctions(base,label,{realPph=false}={}){
 const identity=await import(pathToFileURL(path.join(base,'lib/brand-bgm-identity.mjs')).href+'?'+label),music=await import(pathToFileURL(path.join(base,'worker/brand-bgm.mjs')).href+'?'+label),activation=await import(pathToFileURL(path.join(base,'lib/classic-brand-activation.mjs')).href+'?'+label);
 const mapping=await read(path.join(base,'config/brand-bgm-directories.json'));
 const expected={TT:['tokyotiger','亚文化'],PW:['pagewings','泛读书'],PPH:['purplehecate','魔法'],GC:['guidingcross','基督'],NW:['nerdywave','暗黑'],IP:['ironpandafit','健身'],GK:['geeksoutfit','极客'],TSG:['teachersgram','教师']},checks=[];
 for(const [brand,[slug,folder]]of Object.entries(expected)){assert.equal(identity.canonicalBgmBrand(slug),brand);assert.equal(identity.canonicalBgmBrand(brand),brand);assert.equal(mapping[brand],folder);assert.equal(identity.BRAND_BGM_DIRECTORIES[brand],folder);assert.equal(music.outputBrand({brandBgmContext:{brandId:slug,provenance:'verified_handoff'}},{}),brand);checks.push('route_'+brand);}
 assert.equal(identity.canonicalBgmBrand('483d70a2-c291-4102-93e5-734166a8767a'),null);
 const scratch=path.join(dir,'checks',label),localLibrary=path.join(scratch,'empty-library');await fs.mkdir(path.join(localLibrary,'亚文化'),{recursive:true});await fs.mkdir(path.join(localLibrary,'魔法'),{recursive:true});
 const common={root:scratch,brand:'PPH',mapping,ffmpeg:path.join(scratch,'not-invoked-ffmpeg'),cacheRoot:path.join(scratch,'cache')};
 const unknown=await music.selectBrandBgm({...common,brand:'unknown',directory:localLibrary});assert.equal(unknown.reason,undefined);assert.ok(unknown.warnings.includes('BGM_UNAVAILABLE_OR_UNMAPPED'));checks.push('unknown_not_library_unavailable');
 const empty=await music.selectBrandBgm({...common,directory:localLibrary});assert.equal(empty.reason,undefined);assert.ok(empty.warnings.includes('BGM_NO_VALID_TRACK'));checks.push('empty_not_library_unavailable');
 await fs.writeFile(path.join(localLibrary,'魔法','broken.mp4'),'intentionally corrupt local decode test');
 const decode=await music.selectBrandBgm({...common,directory:localLibrary});assert.equal(decode.reason,undefined);assert.ok(decode.warnings.includes('BGM_DECODE_FAILED'));checks.push('decode_failure_not_library_unavailable');
 const missingDirectory=realPph?music.BGM_ROOT:path.join(scratch,'intentionally-missing');
 const missing=await music.prepareBrandAudio({root:scratch,batch:{brandBgmEnabled:true,brandBgmContext:{brandId:'PPH',provenance:'verified_handoff'}},product:{},duration:10,directory:path.join(scratch,'unused-normalization'),ffmpeg:common.ffmpeg,ffprobe:common.ffmpeg,mapping,cacheRoot:path.join(scratch,'missing-cache'),musicDirectory:missingDirectory});
 assert.equal(missing.path,null);assert.equal(missing.decision.status,'no_bgm');assert.equal(missing.decision.reason,'library_unavailable');assert.equal(missing.decision.originalAudio,false);assert.ok(missing.decision.warnings.includes('BGM_NAS_UNAVAILABLE'));assert.ok(missing.decision.warnings.includes('BGM_UNAVAILABLE_VIDEO_ONLY'));checks.push(realPph?'real_pph_missing_nonblocking':'local_missing_nonblocking');
 assert.notEqual(digest(missingDirectory+'|魔法').slice(0,16),digest(missingDirectory+'|泛读书').slice(0,16));checks.push('old_pph_cache_namespace_excluded');
 const activationRoot=path.join(scratch,'activation');await fs.mkdir(path.join(activationRoot,'config'),{recursive:true});await save(path.join(activationRoot,'config/brand-bgm-directories.json'),mapping);
 for(const brand of ['PPH','PW']){const result=await activation.enableClassicBrandResources({root:activationRoot,context:{brandId:brand,provenance:'verified_handoff'},taskId:'5575c66f-cb0b-482b-beed-2acdff29b26c',manifestSha256:'a'.repeat(64),acceptedAt:new Date().toISOString(),sources:[{brandIdentity:brand}]});assert.equal(result.brandBgmEnabled,true);assert.notEqual(result.brandCopyEnabled,true);checks.push('music_only_activation_'+brand);}
 return {checks,missingDecision:missing.decision,unknown,empty,decode,realPphChecked:realPph};
}
const mode=process.argv[2];
if(mode==='--prepare'){
 assert.ok(!(await fs.stat(deploymentFile).catch(()=>null)),'DEPLOYMENT_ALREADY_EXISTS');await fs.mkdir(candidate,{recursive:true});
 const convergence=await read(path.join(source,'CONVERGENCE.json')),preflight=await read(path.join(source,'deployment-preflight/PREFLIGHT.json'));
 const files=convergence.files.map(f=>({relative:f.relative,before:f.installedBaselineSha256,after:f.candidateSha256,from:path.join(source,'production-derived-mapping-candidate',f.relative)}));
 files.push({relative:'worker/brand-bgm.mjs',before:preflight.additionalCandidate.beforeSha256,after:preflight.additionalCandidate.candidateSha256,from:preflight.additionalCandidate.path});
 for(const f of files){assert.equal(await hash(path.join(root,f.relative)),f.before,'VERSION_CONFLICT');assert.equal(await hash(f.from),f.after);await fs.mkdir(path.dirname(path.join(candidate,f.relative)),{recursive:true});await fs.copyFile(f.from,path.join(candidate,f.relative));}
 // Full installed module tree in isolation, then overwrite precisely four candidates.
 for(const folder of ['lib','worker'])for(const f of await walk(path.join(root,folder))){if(!f.endsWith('.mjs'))continue;const relative=path.relative(root,f);if(files.some(x=>x.relative.replaceAll('/',path.sep)===relative))continue;await fs.mkdir(path.dirname(path.join(candidate,relative)),{recursive:true});await fs.copyFile(f,path.join(candidate,relative));}
 const protectedHashes={};for(const folder of ['lib','worker','config'])for(const f of await walk(path.join(root,folder))){const relative=path.relative(root,f).replaceAll('\\','/');if(!files.some(x=>x.relative===relative)&&/\.(mjs|json)$/.test(f))protectedHashes[relative]=await hash(f);}
 for(const name of ['.env','.env.local','.env.production','.env.production.local'])if(await fs.stat(path.join(root,name)).catch(()=>null))protectedHashes[name]=await hash(path.join(root,name));
 for(const f of files)if(f.relative.endsWith('.mjs'))await run(process.execPath,['--check',path.join(candidate,f.relative)]);
 const original=await fs.readFile(path.join(root,'worker/brand-bgm.mjs'),'utf8'),updated=await fs.readFile(path.join(candidate,'worker/brand-bgm.mjs'),'utf8');assert.equal(updated,original.replace("    decision.warnings.push('BGM_NO_VALID_TRACK');","    decision.warnings.push('BGM_NO_VALID_TRACK');\n    if (decision.warnings.includes('BGM_NAS_UNAVAILABLE')) decision.reason = 'library_unavailable';"));
 const tests=await checkFunctions(candidate,'candidate');
 const m={root,preparedAt:new Date().toISOString(),files:files.map(({from,...f})=>f),protectedHashes,tests};await save(manifestFile,m);console.log(JSON.stringify({status:'prepared',files:4,protected:Object.keys(protectedHashes).length,checks:tests.checks.length}));
}else if(mode==='--deploy'||mode==='--rollback'){
 const rollback=mode==='--rollback',m=await read(manifestFile);if(!rollback)assert.ok(!(await fs.stat(deploymentFile).catch(()=>null)),'DEPLOYMENT_ALREADY_EXISTS');
 let result;
 for(;;){try{await locked(async()=>{
  const records=await idle();await protectedCheck(m);await moduleCheck(m,rollback?'after':'before');
  const rows=await processes(),reload=targets(rows);assert.equal(reload.length,11);assert.ok(rows.some(p=>p.command.includes('fleet-supervisor.mjs --no-claim')));const dataBefore=await dataHashes();
  if(rollback){result=await read(deploymentFile);assert.equal(result.status,'installed');await restore(m);await stop(reload);await save(path.join(dir,'rollback.json'),{at:new Date().toISOString(),status:'safe_rollback',restoredModules:true,pphOldLibraryDisabled:true,reloaded:reload});return;}
  result={root,status:'backing_up',startedAt:new Date().toISOString(),files:m.files,processesBefore:rows,reloaded:reload,dataBefore,historicalRecords:Object.fromEntries(records.map(r=>[r.taskId,digest(JSON.stringify(r))]))};
  for(const f of m.files){const dest=path.join(dir,'backup',f.relative);await fs.mkdir(path.dirname(dest),{recursive:true});await fs.copyFile(path.join(root,f.relative),dest);assert.equal(await hash(dest),f.before);const trial=path.join(dir,'rollback-rehearsal',f.relative);await fs.mkdir(path.dirname(trial),{recursive:true});await fs.copyFile(dest,trial);assert.equal(await hash(trial),f.before);}
  result.backupAndRestoreRehearsal='passed';await save(deploymentFile,result);
  let stopped=false;
  try{
   for(const f of m.files)await replace(f.relative,path.join(candidate,f.relative));await moduleCheck(m,'after');await protectedCheck(m);
   await run(process.execPath,['--input-type=module','-e',`await import(${JSON.stringify(pathToFileURL(path.join(root,'worker/classic-multisource-executor.mjs')).href)});await import(${JSON.stringify(pathToFileURL(path.join(root,'worker/batch-renderer.mjs')).href)});`]);
   result.installedAt=new Date().toISOString();await stop(reload);stopped=true;result.status='installed';result.dataAfter=await dataHashes();assert.deepEqual(result.dataAfter,dataBefore);await save(deploymentFile,result);
  }catch(e){await restore(m);result.status='safe_rollback_after_error';result.error=e.message;if(!stopped)await stop(reload);await save(deploymentFile,result);throw e;}
 });break;}catch(e){if(e.message!=='ACTIVE_WORK_WAIT')throw e;console.log('Waiting for naturally completed production work');await new Promise(r=>setTimeout(r,5000));}}
 console.log(JSON.stringify({status:result?.status,installedAt:result?.installedAt,files:4}));
}else if(mode==='--verify'){
 const m=await read(manifestFile),deployment=await read(deploymentFile);assert.equal(deployment.status,'installed');await moduleCheck(m,'after');await protectedCheck(m);
 const rows=await processes(),consumers=targets(rows);assert.equal(consumers.length,11);assert.ok(consumers.every(p=>Date.parse(p.startedAt)>Date.parse(deployment.installedAt)),'CONSUMER_NOT_RELOADED');
 for(const p of deployment.processesBefore.filter(p=>!deployment.reloaded.some(r=>r.pid===p.pid)))assert.ok(rows.some(r=>r.pid===p.pid&&r.startedAt===p.startedAt),'UNRELATED_PROCESS_CHANGED');
 const classic=await read(path.join(root,'data/classic-multisource-heartbeat.json')),bridge=await read(path.join(root,'data/libtv-bridge-heartbeat.json')),services=[];
 for(const f of await fs.readdir(path.join(root,'data/service-heartbeats'))){if(!f.endsWith('.json'))continue;const h=await read(path.join(root,'data/service-heartbeats',f));if(consumers.some(p=>p.pid===h.pid))services.push(h);}
 assert.equal(services.length,9);assert.ok(services.every(h=>h.claimsEnabled===false&&Date.now()-Date.parse(h.at)<30000));
 for(const h of [classic,bridge]){assert.ok(consumers.some(p=>p.pid===h.pid));assert.ok(Date.now()-Date.parse(h.at)<30000);}assert.equal(classic.directTemplateRevision,'classic-website-template/20261113-r1');
 const tests=await checkFunctions(root,'installed',{realPph:true});
 const records=await read(path.join(root,'data/classic-multisource-records.json'));for(const [id,h]of Object.entries(deployment.historicalRecords)){const record=records.find(r=>r.taskId===id);assert.ok(record);assert.equal(digest(JSON.stringify(record)),h,'HISTORY_CHANGED');}
 const natural=records.filter(r=>!Object.hasOwn(deployment.historicalRecords,r.taskId)).map(r=>({taskId:r.taskId,status:r.status,acceptedAt:r.acceptedAt}));
 const http={};for(const route of ['/','/api/health'])http[route]=(await fetch('http://127.0.0.1:3001'+route)).status;assert.equal(http['/'],200);assert.equal(http['/api/health'],401);
 const result={at:new Date().toISOString(),root,installedAt:deployment.installedAt,DEPLOYED:true,VERIFIED:'installed_hashes_runtime_and_isolated_components; real_pph_missing_nonblocking; production_business_pending',files:m.files,protectedFiles:Object.keys(m.protectedHashes).length,protectedHashesPassed:true,consumers,heartbeats:{classic,bridge,services},unrelatedProcessesUnchanged:true,tests,http,historicalRecordsUnchanged:true,naturalTasks:natural,finalMp4NasAllweAcceptance:'pending',providerCalls:0};await save(path.join(dir,'runtime-verification.json'),result);console.log(JSON.stringify({DEPLOYED:true,VERIFIED:result.VERIFIED,consumers:consumers.map(p=>p.pid),checks:tests.checks.length,pphReason:tests.missingDecision.reason,naturalTasks:natural}));
}else throw Error('Use --prepare / --deploy / --verify / --rollback');
