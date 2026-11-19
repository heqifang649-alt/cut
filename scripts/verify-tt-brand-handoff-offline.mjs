// Offline verification only: never admits, claims, publishes or changes a business task.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import assert from 'node:assert/strict';
import {classicMultisourceBgm} from '../worker/classic-multisource-bgm.mjs';
import {prepareBrandAudio,BGM_ROOT} from '../worker/brand-bgm.mjs';
import {BRAND_BGM_DIRECTORIES} from '../lib/brand-bgm-identity.mjs';
const root=process.cwd(),id='5575c66f-cb0b-482b-beed-2acdff29b26c';
const out=path.join(root,'artifacts/tt-brand-handoff-offline-20261113');
await mkdir(out,{recursive:true});
const nas=String.raw`\\192.168.120.60\新成片交付\批量剪辑素材\test\cutflow-link-only-20261015-180959-e6583121\classic-lan-v1`;
const bytes=await readFile(path.join(nas,`inbox/multi-${id}/manifest.json`));
const hash=value=>createHash('sha256').update(value).digest('hex');
assert.equal(hash(bytes),'9bee7ccd8ef86fb01e4d723e711c7a4ed3893ffce2bab92c049ad91a7d3406e4');
const original=JSON.parse(bytes),record=structuredClone(original);
record.sourceBinding.businessBrandId=record.sourceBinding.value;
record.sourceBinding.value='tokyotiger';
record.sources=record.sources.map(s=>({...s,businessBrandId:s.brandIdentity,brandIdentity:'TT'}));
record.audioPolicy=record.edit_policy.audioPolicy;
const beforeResolution=classicMultisourceBgm(original),batch=classicMultisourceBgm(record);
assert.equal(beforeResolution.brandBgmResolution.reason,'brand_unrecognized');
assert.equal(batch.brandBgmContext.brandId,'TT');assert.equal(batch.brandBgmEnabled,true);
await writeFile(path.join(out,'manifest.offline.json'),JSON.stringify(record,null,2));
const runtime=JSON.parse(await readFile(path.join(root,'config/cutflow-runtime.json')));
const exec=promisify(execFile),run=(exe,args)=>exec(exe,args,{windowsHide:true,timeout:60000,maxBuffer:16*1024*1024});
const probe=async file=>JSON.parse((await run(runtime.ffprobeExecutable,['-v','error','-show_streams','-show_format','-of','json',file])).stdout);
const source=path.join('E:/cutflow批量/classic-multisource',id,'output/483d70a2-c291-4102-93e5-734166a8767a.mp4');
const sourceHash=hash(await readFile(source));assert.equal(sourceHash,'ab86eb32c4ba623a177aed9bf9e8bf8bb73689d94ce4d795cbfb7dec03715109');
const before=await probe(source),duration=Number(before.format.duration);
const productionRoot='D:/CUT-Releases/20261030-production-first-r11';
const installedMapping=JSON.parse(await readFile(path.join(productionRoot,'config/brand-bgm-directories.json')));
assert.deepEqual(installedMapping,BRAND_BGM_DIRECTORIES);
assert.deepEqual(JSON.parse(await readFile(path.join(root,'config/brand-bgm-directories.json'))),installedMapping);
const audio=await prepareBrandAudio({root,batch,product:{get segments(){throw Error('source audio must not be read');}},duration,
  directory:path.join(out,'audio'),cacheRoot:path.join(out,'cache'),ffmpeg:runtime.ffmpegExecutable,ffprobe:runtime.ffprobeExecutable});
assert.ok(audio.path,JSON.stringify(audio.decision));assert.equal(audio.decision.brand,'TT');
assert.ok(audio.decision.sourcePath.startsWith(path.join(BGM_ROOT,'亚文化')+path.sep));
assert.ok(audio.decision.candidateCount>0);assert.equal(audio.decision.originalAudio,false);
const target=path.join(out,'TT-audio-validation.mp4');
// Stream-copy immutable completed visuals only; this is not a task recovery/render/publish.
const args=['-v','error','-y','-i',source,'-i',audio.path,'-map','0:v:0','-map','1:a:0','-c:v','copy','-c:a','aac','-b:a','192k','-ar','48000','-t',String(duration),'-movflags','+faststart',target];
await run(runtime.ffmpegExecutable,args);
const after=await probe(target);assert.equal(after.streams.filter(s=>s.codec_type==='audio').length,1);
await run(runtime.ffmpegExecutable,['-v','error','-xerror','-i',target,'-f','null','-']);
const videoHash=async file=>(await run(runtime.ffmpegExecutable,['-v','error','-i',file,'-map','0:v:0','-c','copy','-f','hash','-hash','sha256','-'])).stdout.trim();
assert.equal(await videoHash(source),await videoHash(target));
const v0=before.streams.find(s=>s.codec_type==='video'),v1=after.streams.find(s=>s.codec_type==='video');
assert.equal(v0.duration,v1.duration);assert.equal(v0.nb_frames,v1.nb_frames);
assert.ok(Math.abs(Number(after.format.duration)-duration)<.04);
const pcm=async input=>(await exec(runtime.ffmpegExecutable,['-v','error','-i',input,'-map','0:a:0','-ac','1','-ar','48000','-f','f32le','-'],{windowsHide:true,encoding:'buffer',maxBuffer:8*1024*1024})).stdout;
const samples=await pcm(target);let power=0;for(let i=0;i<samples.length;i+=4)power+=samples.readFloatLE(i)**2;
assert.ok(power/(samples.length/4)>1e-8);
assert.equal(hash(await readFile(source)),sourceHash);assert.equal(hash(await readFile(path.join(nas,`inbox/multi-${id}/manifest.json`))),hash(bytes));
await writeFile(path.join(out,'report.json'),JSON.stringify({isolated:true,providerCalls:0,productionChanged:false,originalTaskReplayed:false,
  originalManifestSha256:hash(bytes),originalOutputSha256:sourceHash,beforeResolution,batch,installedMapping,audio:audio.decision,
  command:args,target,videoStreamUnchanged:true,videoDuration:v1.duration,videoFrames:v1.nb_frames,
  durationBefore:duration,durationAfter:Number(after.format.duration),audioStream:after.streams.find(s=>s.codec_type==='audio'),audioMeanSquare:power/(samples.length/4),
  originalAudio:false,decode:'passed',limit:'Audio path and immutable visuals verified offline; business runner and ALLWE receipt not replayed.'},null,2));
console.log(JSON.stringify({target,brand:audio.decision.brand,track:audio.decision.bgmFile,candidates:audio.decision.candidateCount,videoStreamUnchanged:true,audio:'aac, decoded, non-silent',productionChanged:false}));
