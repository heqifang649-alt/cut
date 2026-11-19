import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
const repo='D:/自动剪辑网站',production='D:/CUT-Releases/20261030-production-first-r11';
const dir=path.join(repo,'.project-governance/evidence/brand-bgm-0048'),candidate=path.join(dir,'candidate');
const shared=String.raw`\\192.168.120.60\新成片交付\批量剪辑素材\test\cutflow-link-only-20261015-180959-e6583121\classic-lan-v1`;
const ackFile=path.join(shared,'COORD/ack/0048-activate-brand-bgm-and-audible-validation.json');
const hash=b=>createHash('sha256').update(b).digest('hex'),fileHash=async f=>hash(await fs.readFile(f));
const read=async f=>JSON.parse(await fs.readFile(f,'utf8')),save=async(f,v)=>{await fs.mkdir(path.dirname(f),{recursive:true});await fs.writeFile(f,JSON.stringify(v,null,2)+'\n');};
const atomic=async(f,v)=>{const t=f+'.0048-'+randomUUID();await save(t,v);await fs.rename(t,f);};
const execute=promisify(execFile),run=(exe,args,timeout=180000)=>execute(exe,args,{windowsHide:true,timeout,maxBuffer:16*1024*1024,encoding:'utf8'});
const walk=async p=>(await Promise.all((await fs.readdir(p,{withFileTypes:true})).map(e=>e.isDirectory()?walk(path.join(p,e.name)):[path.join(p,e.name)]))).flat();
const runtime=await read(path.join(production,'config/cutflow-runtime.json'));
const ps=async cmd=>JSON.parse((await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',"[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);"+cmd],20000)).stdout.trim()||'null');
const processSnapshot=()=>ps(`@(Get-CimInstance Win32_Process -Filter "name = 'node.exe'" | Where-Object {$_.CommandLine -and $_.CommandLine.Replace('/','\\').Contains('D:\\CUT-Releases\\20261030-production-first-r11\\')} | ForEach-Object{[PSCustomObject]@{pid=$_.ProcessId;parent=$_.ParentProcessId;startedAt=$_.CreationDate.ToUniversalTime().ToString('o');command=$_.CommandLine}})|ConvertTo-Json -Compress`);
const extraVerifier=`
// Diagnostic only: do not fail a video task or change its completion contract.
export async function inspectRenderedBrandAudio({file,decision,ffmpeg,ffprobe}) {
  const result={...decision,warnings:[...(decision?.warnings || [])]};
  try {
    const info=JSON.parse((await command(ffprobe,['-v','error','-show_streams','-of','json',file],15000)).stdout);
    const count=info.streams.filter(s=>s.codec_type==='audio').length;
    if(!count){result.audioValidation={state:'no_audio_stream',audioStreams:0};if(['selected','cached'].includes(result.status)){result.status='no_bgm';result.reason='render_missing_audio_stream';result.warnings.push('BGM_RENDER_MISSING_AUDIO');}return result;}
    const measured=await command(ffmpeg,['-hide_banner','-v','info','-i',file,'-map','0:a:0','-af','volumedetect','-f','null','-'],60000);
    const mean=Number(measured.stderr.match(/mean_volume:\\s*(-?[\\d.]+) dB/)?.[1]);
    if(!Number.isFinite(mean))throw Error('AUDIO_MEASUREMENT_FAILED');
    const audible=mean > -80;
    result.audioValidation={state:audible?'audible':'silent',audioStreams:count,meanDb:mean,thresholdDb:-80};
    if(!audible){result.status='no_bgm';result.reason='render_audio_silent';result.warnings.push('BGM_RENDER_SILENT');}
    return result;
  } catch {return {...result,status:'no_bgm',reason:'render_audio_check_failed',audioValidation:{state:'check_failed'},warnings:[...result.warnings,'BGM_AUDIO_CHECK_FAILED']};}
}
`;
if(process.argv[2]==='--prepare'){
 await fs.mkdir(dir,{recursive:true});
 const instruction=await read(path.join(shared,'COORD/instr/0048-activate-brand-bgm-and-audible-validation.json'));
 const records=await read(path.join(production,'data/classic-multisource-records.json')),queue=await read(path.join(production,'data/service-queue.json'));
 const initial={instructionId:'0048',state:'ack',at:new Date().toISOString(),host:os.hostname(),sourceRoot:repo,activeRoot:production,processes:await processSnapshot(),inflight:{classic:records.filter(r=>r.lease||r.pendingCompletion||!['completed','review','failed','canceled'].includes(r.status)).map(r=>({taskId:r.taskId,status:r.status})),queue:(queue.tasks||[]).filter(t=>t.lease||['running','leased','queued','retry'].includes(t.status)).map(t=>({id:t.id,status:t.status}))},currentHeartbeats:{classic:await read(path.join(production,'data/classic-multisource-heartbeat.json')),bridge:await read(path.join(production,'data/libtv-bridge-heartbeat.json'))},providerCalls:0,renderedAudibleOutput:false};
 await save(path.join(dir,'initial.json'),initial);await atomic(ackFile,initial);
 const previous=await read(path.join(repo,'.project-governance/evidence/brand-mapping-0047-deployment/prepared.json'));for(const f of previous.files)assert.equal(await fileHash(path.join(production,f.relative)),f.after,'0047_PRODUCTION_DRIFT');
 for(const folder of ['lib','worker','config'])for(const f of await walk(path.join(production,folder))){if(!/\.(mjs|json|ts|py)$/.test(f))continue;const target=path.join(candidate,path.relative(production,f));await fs.mkdir(path.dirname(target),{recursive:true});await fs.copyFile(f,target);}
 const changed=['worker/brand-bgm.mjs','worker/classic-multisource-bgm.mjs','worker/batch-renderer.mjs'];
 let text=await fs.readFile(path.join(candidate,changed[0]),'utf8');
 text=text.replace("const decision={brand,bgmFile:null,status:'no_bgm',warnings:[]};","const decision={brand,bgmFile:null,status:'no_bgm',reason:null,selectionAttempted:false,candidateCount:null,warnings:[]};\n  if(!brand)return {...decision,reason:'brand_unrecognized',warnings:['BGM_BRAND_UNRECOGNIZED']};");
 text=text.replace("if (!brand || folder !== BRAND_BGM_DIRECTORIES[brand]) throw Error('BGM_BRAND_UNMAPPED');","if (folder !== BRAND_BGM_DIRECTORIES[brand]) return {...decision,reason:'library_mapping_invalid',warnings:['BGM_BRAND_UNMAPPED']};");
 text=text.replace("catch { decision.warnings.push('BGM_NAS_UNAVAILABLE'); }","catch { decision.reason='library_unavailable'; decision.warnings.push('BGM_NAS_UNAVAILABLE'); }\n    decision.selectionAttempted=true;decision.candidateCount=decision.reason?null:files.length;");
 text=text.replace("catch { decision.warnings.push('BGM_DECODE_FAILED'); }","catch { decision.reason='track_decode_failed'; decision.warnings.push('BGM_DECODE_FAILED'); }");
 text=text.replaceAll("return {...decision,bgmFile:","return {...decision,reason:null,bgmFile:").replaceAll("return {...decision,path:hit.file","return {...decision,reason:null,path:hit.file");
 text=text.replace("if (decision.warnings.includes('BGM_NAS_UNAVAILABLE')) decision.reason = 'library_unavailable';","decision.reason ||= 'no_candidate_tracks';");
 text=text.replace("catch {decision.warnings.push('BGM_UNAVAILABLE_OR_UNMAPPED');}","catch {decision.reason ||= 'library_unavailable';decision.warnings.push('BGM_UNAVAILABLE_OR_UNMAPPED');}");
 text=text.replace("if(!enabled)return {path:null,decision:{...decision,warnings:['BGM_DISABLED_NO_SOURCE_FALLBACK']}};","if(batch.brandBgmResolution?.reason||!enabled||!decision.brand)return {path:null,decision:{...decision,reason:batch.brandBgmResolution?.reason||(!decision.brand?'brand_unrecognized':'bgm_disabled'),selectionAttempted:false,candidateCount:null,warnings:['BGM_DISABLED_NO_SOURCE_FALLBACK']}};");
 text=text.replace("}catch{decision.warnings.push('BGM_NORMALIZATION_FAILED_TRY_SAME_BRAND');}","}catch{decision.reason='track_normalization_failed';decision.warnings.push('BGM_NORMALIZATION_FAILED_TRY_SAME_BRAND');}");
 text+=extraVerifier;await fs.writeFile(path.join(candidate,changed[0]),text);
 text=await fs.readFile(path.join(candidate,changed[1]),'utf8');text=text.replace("if (!brand || !record.sources?.length || record.sources.some(source => canonicalBgmBrand(source.brandIdentity) !== brand)) return {};","const reason=!brand?'brand_unrecognized':!record.sources?.length?'brand_sources_missing':record.sources.some(source=>canonicalBgmBrand(source.brandIdentity)!==brand)?'brand_source_mismatch':null;\n  if(reason)return {brandBgmEnabled:false,brandBgmResolution:{brand:brand||null,reason},brandBgmContext:{brandId:null,provenance:'verified_handoff'}};");await fs.writeFile(path.join(candidate,changed[1]),text);
 text=await fs.readFile(path.join(candidate,changed[2]),'utf8');text=text.replace('brandBgmEnabled, prepareBrandAudio }','brandBgmEnabled, prepareBrandAudio, inspectRenderedBrandAudio }');
 text=text.replace("const bgmDecision = useBrandBgm ?","let bgmDecision = useBrandBgm ?");
 const insert="if (useBrandBgm) bgmDecision=await inspectRenderedBrandAudio({file:outputPath,decision:bgmDecision,ffmpeg,ffprobe:runtimeConfig.ffprobeExecutable});";
 text=text.replaceAll('const outputDurationSeconds = await verifyEncodedSafeDuration(runtimeConfig.ffprobeExecutable, outputPath);','const outputDurationSeconds = await verifyEncodedSafeDuration(runtimeConfig.ffprobeExecutable, outputPath);\n      '+insert);
 // Checkpoint saves the same observed audio result, including on resume; video completion remains unchanged.
 text=text.replaceAll('state: "completed", record }','state: "completed", bgm:bgmDecision, record }');await fs.writeFile(path.join(candidate,changed[2]),text);
 const files=[];for(const relative of changed){await run(process.execPath,['--check',path.join(candidate,relative)]);const before=await fileHash(path.join(production,relative)),after=await fileHash(path.join(candidate,relative));assert.notEqual(before,after);files.push({relative,before,after});const diff=await run('git',['diff','--no-index','--',path.join(production,relative),path.join(candidate,relative)]).catch(e=>{if(e.code===1)return e;throw e;});await fs.writeFile(path.join(dir,path.basename(relative)+'.patch'),diff.stdout);}
 const protectedHashes={};for(const folder of ['lib','worker','config'])for(const f of await walk(path.join(production,folder))){const rel=path.relative(production,f).replaceAll('\\','/');if(!changed.includes(rel)&&/\.(mjs|json|ts|py)$/.test(f))protectedHashes[rel]=await fileHash(f);}
 const checks=await runChecks(candidate,'candidate');await save(path.join(dir,'prepared.json'),{root:production,files,protectedHashes,tests:checks,at:new Date().toISOString()});
 // Reuse the previously validated guarded installer with this manifest; do not execute its preparation or legacy mapping checks.
 let deploy=await fs.readFile(path.join(repo,'scripts/deploy-brand-mapping-0047.mjs'),'utf8');deploy=deploy.replace("path.join(repo,'.project-governance/evidence/brand-mapping-0047-deployment')","path.join(repo,'.project-governance/evidence/brand-bgm-0048')");
 const start=deploy.indexOf('async function checkFunctions('),end=deploy.indexOf('const mode=process.argv[2];',start);assert.ok(start>0&&end>start);
 deploy=deploy.slice(0,start)+"async function checkFunctions(base,label,options){const {runChecks}=await import("+JSON.stringify(pathToFileURL(path.join(repo,'scripts/brand-bgm-0048.mjs')).href)+");return runChecks(base,label,options);}\n"+deploy.slice(end);
 deploy=deploy.replace("const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');","const repo='D:/自动剪辑网站';");
 deploy=deploy.replaceAll('files:4','files:m.files.length');await fs.writeFile(path.join(dir,'deploy.mjs'),deploy);
 console.log(JSON.stringify({prepared:true,changed,checks:checks.checks.length,protected:Object.keys(protectedHashes).length,dir}));
}
export async function runChecks(base,label,{realPph=false}={}){
 const music=await import(pathToFileURL(path.join(base,'worker/brand-bgm.mjs')).href),mapping=await read(path.join(base,'config/brand-bgm-directories.json'));
 const identity=await import(pathToFileURL(path.join(base,'lib/brand-bgm-identity.mjs')).href),resolver=await import(pathToFileURL(path.join(base,'worker/classic-multisource-bgm.mjs')).href);
 const scratch=path.join(dir,'checks',label);await fs.mkdir(path.join(scratch,'empty/魔法'),{recursive:true});const options={root:scratch,brand:'PPH',mapping,ffmpeg:runtime.ffmpegExecutable,cacheRoot:path.join(scratch,'cache')},checks=[];
 const unknown=await music.selectBrandBgm({...options,brand:'uuid-unknown',directory:path.join(scratch,'empty')});assert.equal(unknown.reason,'brand_unrecognized');assert.equal(unknown.selectionAttempted,false);checks.push('unknown');
 const empty=await music.selectBrandBgm({...options,directory:path.join(scratch,'empty')});assert.equal(empty.reason,'no_candidate_tracks');assert.equal(empty.candidateCount,0);checks.push('empty');
 await fs.mkdir(path.join(scratch,'corrupt/魔法'),{recursive:true});await fs.writeFile(path.join(scratch,'corrupt/魔法/bad.mp4'),'bad-local-fixture');
 const decode=await music.selectBrandBgm({...options,directory:path.join(scratch,'corrupt')});assert.equal(decode.reason,'track_decode_failed');checks.push('decode_failed');
 const missing=await music.prepareBrandAudio({root:scratch,batch:{brandBgmEnabled:true,brandBgmContext:{brandId:'PPH',provenance:'verified_handoff'}},product:{},duration:8,directory:path.join(scratch,'normalize'),ffmpeg:runtime.ffmpegExecutable,ffprobe:runtime.ffprobeExecutable,mapping,cacheRoot:path.join(scratch,'missing-cache'),musicDirectory:realPph?music.BGM_ROOT:path.join(scratch,'missing')});assert.equal(missing.path,null);assert.equal(missing.decision.reason,'library_unavailable');assert.equal(missing.decision.originalAudio,false);checks.push('missing_nonblocking');
 const noAudio=path.join(scratch,'no-audio.mp4'),silent=path.join(scratch,'silent.mp4'),audible=path.join(scratch,'audible.mp4');
 await run(runtime.ffmpegExecutable,['-v','error','-f','lavfi','-i','color=s=64x64:r=10:d=1','-an','-c:v','libx264','-y',noAudio]);
 for(const [f,filter]of [[silent,'anullsrc=r=48000:cl=mono'],[audible,'sine=frequency=440:sample_rate=48000']])await run(runtime.ffmpegExecutable,['-v','error','-i',noAudio,'-f','lavfi','-i',filter,'-t','1','-c:v','copy','-c:a','aac','-y',f]);
 const diagnostics=[];for(const [f,reason]of [[noAudio,'render_missing_audio_stream'],[silent,'render_audio_silent'],[audible,null]]){const d=await music.inspectRenderedBrandAudio({file:f,decision:{status:'selected',brand:'TT',warnings:[]},ffmpeg:runtime.ffmpegExecutable,ffprobe:runtime.ffprobeExecutable});assert.equal(d.reason??null,reason);assert.equal(d.status,reason?'no_bgm':'selected');diagnostics.push(d);checks.push(reason||'audible');}
 for(const [brand,slug]of Object.entries({TT:'tokyotiger',GC:'guidingcross',NW:'nerdywave',IP:'ironpandafit',GK:'geeksoutfit',TSG:'teachersgram',PW:'pagewings',PPH:'purplehecate'})){for(const alias of [brand,slug,slug.toUpperCase()])assert.equal(identity.canonicalBgmBrand(alias),brand);const r=resolver.classicMultisourceBgm({sourceBinding:{kind:'brand',value:slug},sources:[{brandIdentity:slug,businessBrandId:'not-brand'}]});assert.equal(r.brandBgmEnabled,true);checks.push('alias_'+brand);}
 assert.equal(resolver.classicMultisourceBgm({sourceBinding:{kind:'brand',value:'TT'},sources:[{brandIdentity:'PW'}]}).brandBgmResolution.reason,'brand_source_mismatch');checks.push('mismatch');
 await save(path.join(scratch,'results.json'),{checks,unknown,empty,decode,missingDecision:missing.decision,diagnostics});return {checks,missingDecision:missing.decision,diagnostics};
}
