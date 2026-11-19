import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,readFile,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {classicMultisourceBgm} from '../worker/classic-multisource-bgm.mjs';
import {prepareBrandAudio,brandBgmEnabled} from '../worker/brand-bgm.mjs';
const runtime=JSON.parse(await readFile(new URL('../config/cutflow-runtime.json',import.meta.url)));
const record={sourceBinding:{kind:'brand',value:'tokyotiger'},sources:[{brandIdentity:'TT'}],audioPolicy:{bgm:'auto_match'}};
test('resolution failure never enters selection, even with global enable or copy context',async()=>{
  for(const [change,reason] of [[{sourceBinding:{kind:'brand',value:'483d70a2-c291-4102-93e5-734166a8767a'}},'brand_unrecognized'],[{sources:[{brandIdentity:'GC'}]},'brand_source_mismatch'],[{audioPolicy:{bgm:'none'}},'audio_policy_disabled']]){
    const batch={brandCopyContext:{brandId:'TT',provenance:'verified_handoff'},...classicMultisourceBgm({...record,...change})};
    assert.equal(brandBgmEnabled({ENABLE_BRAND_BGM:'true'},batch),false);
    const result=await prepareBrandAudio({batch,product:{},enabled:false});
    assert.equal(result.path,null);assert.equal(result.decision.reason,reason);
    assert.equal(result.decision.selectionAttempted,false);assert.equal(result.decision.candidateCount,null);
  }
});
test('unavailable, empty, corrupt and invalid mapping are distinct soft fallbacks',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'cut-bgm-reasons-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const musicDirectory=path.join(root,'music');
  const options={root,batch:classicMultisourceBgm(record),product:{get segments(){throw Error('source sound accessed');}},duration:1,
    directory:path.join(root,'out'),musicDirectory,mapping:{TT:'亚文化'},ffmpeg:runtime.ffmpegExecutable,ffprobe:runtime.ffprobeExecutable};
  for(const [name,expected] of [['missing','library_unavailable'],['empty','no_candidate_tracks'],['corrupt','track_decode_failed'],['wrong','library_mapping_invalid']]){
    if(name==='empty')await mkdir(path.join(musicDirectory,'亚文化'),{recursive:true});
    if(name==='corrupt')await writeFile(path.join(musicDirectory,'亚文化','bad.wav'),'bad');
    const result=await prepareBrandAudio({...options,cacheRoot:path.join(root,name),...(name==='wrong'?{mapping:{TT:'基督'}}:{})});
    assert.equal(result.path,null);assert.equal(result.decision.status,'no_bgm');assert.equal(result.decision.reason,expected);
    assert.equal(result.decision.originalAudio,false);
    if(name==='empty')assert.equal(result.decision.candidateCount,0);
    if(name==='missing')assert.equal(result.decision.candidateCount,null);
  }
});
