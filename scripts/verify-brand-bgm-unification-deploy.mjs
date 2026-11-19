import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
const run=promisify(execFile),dir=path.resolve('.project-governance/evidence/brand-bgm-unification-20261113/deployment');
const prepared=JSON.parse(await fs.readFile(path.join(dir,'prepared.json'))),m=JSON.parse(await fs.readFile(path.join(dir,'deployment.json'))),root=prepared.root;
const hash=async p=>createHash('sha256').update(await fs.readFile(p)).digest('hex');
const ps=async command=>JSON.parse((await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',"[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);"+command],{windowsHide:true,timeout:15000})).stdout.trim());
const processes=await ps(`@(Get-CimInstance Win32_Process -Filter "name = 'node.exe'" | Where-Object {$_.CommandLine -and $_.CommandLine.Replace('/','\\').Contains('D:\\CUT-Releases\\20261030-production-first-r11\\')} | ForEach-Object{[PSCustomObject]@{pid=$_.ProcessId;parent=$_.ParentProcessId;startedAt=$_.CreationDate.ToUniversalTime().ToString('o');command=$_.CommandLine}})|ConvertTo-Json -Compress`);
const fail=s=>{throw Error(s);};
if(m.status!=='installed')fail('NOT_INSTALLED');
for(const f of prepared.files)if(await hash(path.join(root,f.path))!==f.candidate)fail('INSTALLED_HASH:'+f.path);
for(const [p,h]of Object.entries(prepared.protectedHashes))if(await hash(path.join(root,p))!==h)fail('PROTECTED_HASH:'+p);
const consumers=processes.filter(p=>/worker[\\/](?:classic-multisource-runner|libtv-bridge-worker|service-runner)\.mjs/.test(p.command));
if(consumers.length!==11||consumers.some(p=>Date.parse(p.startedAt)<=Date.parse(m.installedAt)))fail('CONSUMER_NOT_RELOADED');
const unchangedProcesses=m.processesBefore.filter(p=>!m.reloaded.some(r=>r.pid===p.pid));
if(unchangedProcesses.some(p=>!processes.some(r=>r.pid===p.pid&&r.startedAt===p.startedAt)))fail('UNRELATED_PROCESS_CHANGED');
const read=async p=>JSON.parse(await fs.readFile(path.join(root,p),'utf8'));
const heartbeats={classic:await read('data/classic-multisource-heartbeat.json'),bridge:await read('data/libtv-bridge-heartbeat.json'),services:[]};
for(const p of consumers){const files=await fs.readdir(path.join(root,'data/service-heartbeats'));for(const f of files.filter(f=>f.endsWith('.json'))){const h=await read('data/service-heartbeats/'+f);if(h.pid===p.pid)heartbeats.services.push(h);}}
if(heartbeats.services.length!==9||heartbeats.services.some(h=>h.claimsEnabled!==false||Date.now()-Date.parse(h.at)>30000))fail('SERVICE_HEARTBEAT');
for(const k of ['classic','bridge'])if(!consumers.some(p=>p.pid===heartbeats[k].pid)||Date.now()-Date.parse(heartbeats[k].at)>30000)fail('HEARTBEAT:'+k);
if(heartbeats.classic.directTemplateRevision!=='classic-website-template/20261113-r1')fail('DIRECT_TEMPLATE_REVISION');
const identity=await import(pathToFileURL(path.join(root,'lib/brand-bgm-identity.mjs')));
const music=await import(pathToFileURL(path.join(root,'worker/brand-bgm.mjs')));
const mapping=await read('config/brand-bgm-directories.json');
const libraries=[];
for(const [brand,folder]of Object.entries(identity.BRAND_BGM_DIRECTORIES)){
 if(mapping[brand]!==folder)fail('MAPPING:'+brand);
 const r=await run(process.execPath,[path.join(root,'worker/brand-bgm.mjs'),'--scan-bgm',path.join(music.BGM_ROOT,folder)],{windowsHide:true,timeout:5000,maxBuffer:2*1024*1024}).catch(()=>null);
 libraries.push({brand,folder,tracks:r?JSON.parse(r.stdout).length:null,status:r?'readable':'unavailable'});
}
const records=await read('data/classic-multisource-records.json'),natural=records.filter(r=>!Object.hasOwn(m.historicalRecords,r.taskId));
for(const [id,h]of Object.entries(m.historicalRecords)){const r=records.find(r=>r.taskId===id);if(!r||createHash('sha256').update(JSON.stringify(r)).digest('hex')!==h)fail('HISTORICAL_RECORD_CHANGED:'+id);}
const http={};for(const route of ['/','/api/health']){const response=await fetch('http://127.0.0.1:3001'+route);http[route]=response.status;}
if(http['/']!==200||http['/api/health']!==401)fail('HTTP_HEALTH');
const data={};for(const [f,h]of Object.entries(m.dataBefore))data[f]={unchanged:await hash(path.join(root,'data',f))===h};
const result={checkedAt:new Date().toISOString(),root,installedAt:m.installedAt,status:'runtime_verified',installedHashes:true,protectedFileCount:Object.keys(prepared.protectedHashes).length,protectedHashes:true,consumers,unrelatedProcessesUnchanged:true,heartbeats,http,libraries,historicalRecordsUnchanged:true,data,naturalTasks:natural.map(r=>({taskId:r.taskId,status:r.status,acceptedAt:r.acceptedAt})),productionBusinessAcceptance:natural.length?'requires_task_review':'pending_no_natural_task'};
await fs.writeFile(path.join(dir,'runtime-verification.json'),JSON.stringify(result,null,2));
// These copies import installed production functions but all fixture writes stay isolated.
for(const f of ['brand-bgm-mapping.test.mjs','classic-multisource-nw-bgm.test.mjs','brand-bgm.test.mjs','bgm-only.test.mjs','classic-brand-activation.test.mjs','brand-copy.test.mjs','brand-original-render.integration.test.mjs','brand-expanded-render.integration.test.mjs','direct-template-executor.integration.test.mjs','direct-template-scope.test.mjs','allwe-website-template-pilot.test.mjs','ootd-template-diversity.test.mjs']){
 let s=await fs.readFile(path.join(prepared.candidate,'tests',f),'utf8');
 s=s.replace(/(['"])\.\.\/(lib|worker)\/([^'"\n]+)\1/g,(_,q,d,p)=>{const [file,query]=p.split('?');return q+pathToFileURL(path.join(root,d,file)).href+(query?'?'+query:'')+q;});
 await fs.writeFile(path.join(prepared.candidate,'tests','installed-'+f),s);
}
console.log(JSON.stringify({status:result.status,consumerPids:consumers.map(p=>p.pid),protected:result.protectedFileCount,libraries,http,naturalTasks:result.naturalTasks}));
