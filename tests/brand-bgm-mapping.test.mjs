import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm, readFile, writeFile} from 'node:fs/promises';
import {enableClassicBrandResources} from '../lib/classic-brand-activation.mjs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {canonicalBgmBrand, BRAND_BGM_DIRECTORIES as mapping} from '../lib/brand-bgm-identity.mjs';
import {classicMultisourceBgm} from '../worker/classic-multisource-bgm.mjs';
import {outputBrand, selectBrandBgm, prepareBrandAudio} from '../worker/brand-bgm.mjs';
const names={NW:'NerdyWave',IP:'IronPandaFit',GC:'GuidingCross',TT:'Tokyo-Tiger',GK:'GeeksOutfit',TSG:'Teachersgram',PPH:'PurpleHecate',PW:'PageWings',NS:'Nursehutshop'};
const runtime=JSON.parse(await readFile(new URL('../config/cutflow-runtime.json',import.meta.url)));
test('configured mapping exactly matches confirmed brand libraries', async()=>{
  assert.deepEqual(JSON.parse(await readFile(new URL('../config/brand-bgm-directories.json',import.meta.url))),mapping);
});
for(const [brand,name] of Object.entries(names)) test(`${brand}: aliases, trusted Classic identity, isolated selection and silent fallback`,async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'cut-bgm-map-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  for(const value of [brand,name,name.toLowerCase().replace(/-/g,''),name.replace(/-/g,'_')]){
    assert.equal(canonicalBgmBrand(value),brand);
    const batch=classicMultisourceBgm({sourceBinding:{kind:'brand',value},sources:[{brandIdentity:name}]});
    assert.equal(batch.brandBgmEnabled,true);assert.equal(outputBrand(batch,{}),brand);
    assert.equal(batch.brandCopyEnabled,undefined);
    if(brand!=='NW')assert.equal(batch.brandCopyContext,undefined);
    assert.equal(classicMultisourceBgm({sourceBinding:{kind:'brand',value},sources:[{brandIdentity:brand==='GC'?'TT':'GC'}]}).brandBgmResolution.reason,'brand_source_mismatch');
  }
  const directory=path.join(root,'music'),cacheRoot=path.join(root,'cache');
  for(const [code,folder] of Object.entries(mapping)){
    await mkdir(path.join(directory,folder),{recursive:true});
    execFileSync(runtime.ffmpegExecutable,['-v','error','-f','lavfi','-i','sine=frequency=440:duration=1','-y',path.join(directory,folder,code+'.wav')],{windowsHide:true});
  }
  const options={root,brand:name,ffmpeg:runtime.ffmpegExecutable,directory,cacheRoot,mapping};
  const selected=await selectBrandBgm(options);
  assert.equal(selected.status,'selected');assert.equal(selected.bgmFile,brand+'.wav');
  assert.equal(path.dirname(selected.sourcePath),path.join(directory,mapping[brand]));
  // A missing/empty library cannot borrow tracks even when other brand libraries are populated.
  await rm(path.join(directory,mapping[brand]),{recursive:true});
  for(const empty of [false,true]){
    if(empty)await mkdir(path.join(directory,mapping[brand]));
    const result=await prepareBrandAudio({root,batch:{brandBgmContext:{brandId:name,provenance:'verified_handoff'}},product:{},duration:1,
      directory:path.join(root,'out'),musicDirectory:directory,cacheRoot:path.join(root,'empty-cache-'+empty),mapping,ffmpeg:runtime.ffmpegExecutable,ffprobe:runtime.ffprobeExecutable});
    assert.equal(result.path,null);assert.equal(result.decision.status,'no_bgm');
    assert.ok(result.decision.warnings.includes('BGM_UNAVAILABLE_VIDEO_ONLY'));
  }
  const wrong=await selectBrandBgm({...options,mapping:{...mapping,[brand]:mapping[brand==='GC'?'TT':'GC']}});
  assert.equal(wrong.status,'no_bgm');
});
test('unmapped names are never guessed',()=>{
  for(const value of ['unknown','fitness','constructor','暗黑'])assert.equal(canonicalBgmBrand(value),null);
});
test('ordinary Classic enables new brand music without copy library or canary allocation',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'cut-classic-music-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(path.join(root,'config'));
  await writeFile(path.join(root,'config/brand-bgm-directories.json'),JSON.stringify(mapping));
  for(const brand of ['IP','GK','TSG','PPH']){
    const options={root,taskId:'a'.repeat(36),manifestSha256:'b'.repeat(64),acceptedAt:'2026-11-13T00:00:00Z',context:{brandId:names[brand],provenance:'verified_handoff'}};
    const flags=await enableClassicBrandResources(options);
    assert.equal(flags.brandBgmEnabled,true);assert.equal(flags.brandCopyEnabled,undefined);assert.equal(outputBrand(flags,{}),brand);
    for(const override of [{context:{brandId:brand,provenance:'authenticated_api'}},{sources:[{brandIdentity:'GC'}]},{manifestSha256:'invalid'},{context:{...options.context,products:{p:{brandId:'GC'}}}}])assert.deepEqual(await enableClassicBrandResources({...options,...override}),{});
  }
});

