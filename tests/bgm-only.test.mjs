import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BGM_ROOT, normalizeBrandTrack, prepareBrandAudio } from '../worker/brand-bgm.mjs';

const run = promisify(execFile);
const runtime = JSON.parse(await readFile(new URL('../config/cutflow-runtime.json', import.meta.url)));
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cut-bgm-only-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const folder = 'offline-'+randomUUID();
  const cacheRoot = path.join(root, 'cache');
  const cache = path.join(cacheRoot, 'GC', createHash('sha256').update(BGM_ROOT+'|'+folder).digest('hex').slice(0,16));
  await mkdir(cache,{recursive:true});
  return {root,cache,options:{root,cacheRoot,mapping:{GC:folder},batch:{brandCopyContext:{brandId:'GC',provenance:'verified_handoff'}},
    product:{get segments(){throw Error('source audio must never be accessed');}},duration:8,directory:path.join(root,'audio'),
    ffmpeg:runtime.ffmpegExecutable,ffprobe:runtime.ffprobeExecutable}};
}
async function tone(file,duration=10) {
  await run(runtime.ffmpegExecutable,['-v','error','-f','lavfi','-i',`sine=frequency=440:sample_rate=48000:duration=${duration}`,'-y',file],{windowsHide:true});
}
test('disabled resources yield video-only without accessing source audio',async t=>{
  const {options}=await fixture(t);
  const result=await prepareBrandAudio({...options,enabled:false});
  assert.equal(result.path,null);assert.equal(result.decision.originalAudio,false);
  assert.equal(result.decision.status,'no_bgm');
});
test('corrupt music retries another cached track of the same brand',async t=>{
  const {cache,options}=await fixture(t);
  const good=String.raw`${BGM_ROOT}\基督\good.wav`,bad=String.raw`${BGM_ROOT}\基督\bad.wav`;
  await tone(path.join(cache,'good.wav'));
  await writeFile(path.join(cache,'good.wav.json'),JSON.stringify({source:good,name:'good.wav'}));
  await writeFile(path.join(cache,'bad.wav'),'corrupt');
  await writeFile(path.join(cache,'bad.wav.json'),JSON.stringify({source:bad,name:'bad.wav'}));
  await writeFile(path.join(cache,'recent.txt'),good);
  const result=await prepareBrandAudio(options);
  assert.equal(result.decision.bgmFile,'good.wav');assert.equal(result.decision.brand,'GC');
  assert.equal(result.decision.originalAudio,false);assert.ok(result.path);
  assert.ok(result.decision.warnings.includes('BGM_NORMALIZATION_FAILED_TRY_SAME_BRAND'));
});
test('all corrupt or missing tracks yield video-only and never original/template audio',async t=>{
  const {cache,options}=await fixture(t);
  await writeFile(path.join(cache,'bad.wav'),'bad');
  await writeFile(path.join(cache,'bad.wav.json'),JSON.stringify({source:'GC/bad.wav',name:'bad.wav'}));
  const result=await prepareBrandAudio(options);
  assert.equal(result.path,null);assert.equal(result.decision.originalAudio,false);
  assert.ok(result.decision.warnings.includes('BGM_UNAVAILABLE_VIDEO_ONLY'));
});
for(const [name,length]of [['short',1.73],['equal',8],['long',12]])test(`${name} music fits exact duration with expected loop behavior`,async t=>{
  const {root,options}=await fixture(t);const file=path.join(root,'music.wav');await tone(file,length);
  const result=await normalizeBrandTrack({...options,file});
  assert.equal(result.loopCount>1,name==='short');assert.equal(result.crossfadeSeconds,name==='short'?.2:0);
  const probe=JSON.parse((await run(runtime.ffprobeExecutable,['-v','error','-show_entries','format=duration','-of','json',result.path],{windowsHide:true})).stdout);
  assert.equal(Number(probe.format.duration),8);
});
