// Local fixture admission only. No HTTP, NAS, workers, Provider, or production READY writes.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const root=process.cwd();
const out=path.join(root,'artifacts','allwe-brand-receiver-'+new Date().toISOString().replace(/[:.]/g,'-'));
await mkdir(out,{recursive:true});
// Installed admission reads its isolation policy from cwd. Supply a fixture-only policy.
await mkdir(path.join(out,'config'),{recursive:true});
await writeFile(path.join(out,'config/classic-task-isolation.json'),JSON.stringify({schemaVersion:1,tasks:[]}));
process.chdir(out);
const installed='D:/CUT-Releases/20261030-production-first-r11';
const hash=b=>createHash('sha256').update(b).digest('hex');
const load=(base,file)=>import(pathToFileURL(path.join(base,file)).href);
const runtime=JSON.parse(await readFile(path.join(root,'config/cutflow-runtime.json'),'utf8'));
const exec=promisify(execFile);
const run=(exe,args)=>exec(exe,args,{windowsHide:true,timeout:30000,maxBuffer:2*1024*1024});
const brands={TT:'tokyotiger',GC:'guidingcross',NW:'nerdywave',IP:'ironpandafit',GK:'geeksoutfit',TSG:'teachersgram',PPH:'purplehecate'};
const {BRAND_BGM_DIRECTORIES:mapping}=await load(root,'lib/brand-bgm-identity.mjs');
assert.deepEqual(JSON.parse(await readFile(path.join(installed,'config/brand-bgm-directories.json'),'utf8')),mapping);
const source=path.join(out,'source-fixture.mp4');
await run(runtime.ffmpegExecutable,['-v','error','-f','lavfi','-i','color=c=blue:s=64x64:r=30:d=0.5','-an','-c:v','libx264','-y',source]);
const sourceBytes=await readFile(source),musicDirectory=path.join(out,'music');
for(const [i,brand] of Object.keys(brands).entries()){
  const dir=path.join(musicDirectory,mapping[brand]);await mkdir(dir,{recursive:true});
  await run(runtime.ffmpegExecutable,['-v','error','-f','lavfi','-i',`sine=frequency=${300+i*100}:duration=1`,'-y',path.join(dir,brand+'-fixture.wav')]);
}
const rows=[],protectedFiles=['lib/classic-multisource.mjs','worker/classic-multisource-bgm.mjs','worker/brand-bgm.mjs','lib/brand-bgm-identity.mjs','config/brand-bgm-directories.json'];
const before=Object.fromEntries(await Promise.all(protectedFiles.map(async f=>[f,hash(await readFile(path.join(installed,f)))])));
for(const [label,base] of [['candidate',root],['installed',installed]]){
  const {admitMultisource,loadMultisourceExecution}=await load(base,'lib/classic-multisource.mjs');
  const {canonicalBgmBrand}=await load(base,'lib/brand-bgm-identity.mjs');
  const {classicMultisourceBgm}=await load(base,'worker/classic-multisource-bgm.mjs');
  const {selectBrandBgm,outputBrand}=await load(base,'worker/brand-bgm.mjs');
  for(const [brand,key] of Object.entries(brands)){
    const fixtureRoot=path.join(out,label,brand),nasRoot=path.join(fixtureRoot,'local-share');
    const taskId=randomUUID(),userId=randomUUID(),businessBrandId=brand==='TT'?'483d70a2-c291-4102-93e5-734166a8767a':randomUUID();
    const handoffKey=`multi-${taskId}`,dir=path.join(nasRoot,'inbox',handoffKey);
    await mkdir(path.join(dir,'assets'),{recursive:true});
    await mkdir(path.join(fixtureRoot,'data'),{recursive:true});
    await writeFile(path.join(fixtureRoot,'data/classic-integration-runtime.json'),JSON.stringify({schemaVersion:1,enabled:true,nasRoot}));
    const sources=[];
    for(let i=0;i<2;i++){
      const relativePath=`assets/${i+1}.mp4`;await copyFile(source,path.join(dir,relativePath));
      sources.push({id:randomUUID(),order:i+1,relativePath,sha256:hash(sourceBytes),sizeBytes:sourceBytes.length,durationSeconds:0.5,
        productId:null,brandIdentity:key,businessBrandId,videoType:i?'unboxing':'ootd'});
    }
    const manifest={contractVersion:'libtv-cut-lan-multi/2',taskId,handoffKey,userId,idempotencyKey:'fixture-'+taskId,policyVersion:'fixture-policy/1',
      sourceBinding:{kind:'brand',value:key,granularity:'brand-profile',productIdProvided:false,businessBrandId},sources,
      edit_policy:{audioPolicy:{sourceAudio:'mute',bgm:'auto_match',beatSync:true}}};
    const publishLocal=async value=>{
      const bytes=JSON.stringify(value);await writeFile(path.join(dir,'manifest.json'),bytes);
      await writeFile(path.join(dir,'READY'),JSON.stringify({sha256:hash(bytes)}));
      return {contractVersion:manifest.contractVersion,taskId,handoffKey,idempotencyKey:manifest.idempotencyKey,
        manifestRelativePath:`inbox/${handoffKey}/manifest.json`,manifestSha256:hash(bytes)};
    };
    const config={ready:true,nasRoot,owners:{['fixture:'+userId]:'fixture-owner'},qualityVerifier:'fixture',productionEditor:'fixture'};
    const descriptor=await publishLocal(manifest);
    const admitted=await admitMultisource(fixtureRoot,config,descriptor);
    const duplicate=await admitMultisource(fixtureRoot,config,descriptor);
    assert.equal(admitted.batchId,duplicate.batchId);assert.equal(admitted.taskId,taskId);
    const record=await loadMultisourceExecution(fixtureRoot,config,taskId);
    assert.equal(record.sourceBinding.value,key);assert.equal(record.sourceBinding.businessBrandId,businessBrandId);
    assert.deepEqual(record.sources.map(s=>s.videoType),['ootd','unboxing']);
    assert.ok(record.sources.every(s=>s.brandIdentity===key&&s.businessBrandId===businessBrandId&&s.productId===null));
    assert.deepEqual(record.sources.map(s=>s.id),sources.map(s=>s.id));
    const batch=classicMultisourceBgm(record);assert.equal(outputBrand(batch,{}),brand);
    const altered=structuredClone(record);altered.sourceBinding.businessBrandId=randomUUID();altered.sources.forEach(s=>s.businessBrandId=randomUUID());
    assert.equal(outputBrand(classicMultisourceBgm(altered),{}),brand);
    const wrong=structuredClone(manifest);wrong.sources[1].brandIdentity=brand==='GC'?'tokyotiger':'guidingcross';
    await assert.rejects(admitMultisource(fixtureRoot,config,await publishLocal(wrong)),/INVALID_SOURCE/);
    const wrongProduct=structuredClone(manifest);wrongProduct.sources[0].productId='foreign-product';
    await assert.rejects(admitMultisource(fixtureRoot,config,await publishLocal(wrongProduct)),/INVALID_SOURCE/);
    await publishLocal(manifest);
    const music=await selectBrandBgm({root:fixtureRoot,brand:outputBrand(batch,{}),directory:musicDirectory,
      cacheRoot:path.join(fixtureRoot,'cache'),mapping,ffmpeg:runtime.ffmpegExecutable});
    assert.equal(music.status,'selected');assert.equal(music.bgmFile,brand+'-fixture.wav');
    assert.equal(path.dirname(music.sourcePath),path.join(musicDirectory,mapping[brand]));
    const probe=JSON.parse((await run(runtime.ffprobeExecutable,['-v','error','-show_streams','-of','json',music.path])).stdout);
    assert.ok(probe.streams.some(s=>s.codec_type==='audio'));
    assert.equal(canonicalBgmBrand(businessBrandId),null);
    rows.push({code:label,brand,key,folder:mapping[brand],parsing:'passed',admission:'passed',businessIdOnlyTracking:true,
      brandMismatch:'rejected',foreignProduct:'rejected',duplicateSameBatch:true,videoTypesPreserved:true,
      musicQuery:'selected_local_fixture',candidates:music.candidateCount??null,track:music.bgmFile,decodableAudio:true,
      finalVideoSynthesis:'not_executed',manifest:path.join(dir,'manifest.json'),music});
  }
}
const after=Object.fromEntries(await Promise.all(protectedFiles.map(async f=>[f,hash(await readFile(path.join(installed,f)))])));
assert.deepEqual(after,before);
await writeFile(path.join(out,'report.json'),JSON.stringify({rows,installedRoot:installed,installedHashes:after,
  installedFilesUnchanged:true,productionReadyPackagesWritten:0,productionTasksCreated:0,providerCalls:0,finalVideoSynthesis:'not_executed',
  limitations:'Generated local fixture music only; no NAS library availability check, no final MP4 or production/ALLWE end-to-end acceptance.'},null,2));
console.log(JSON.stringify({out,checks:rows.length,result:'passed',finalVideoSynthesis:'not_executed'}));
