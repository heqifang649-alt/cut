import test from 'node:test';
import assert from 'node:assert/strict';
import {brandBgmEnabled,chooseTrack,outputBrand,selectBrandBgm} from '../worker/brand-bgm.mjs';

test('brand BGM defaults off and explicit switch restores legacy route',()=>{
  assert.equal(brandBgmEnabled({}),false);assert.equal(brandBgmEnabled({ENABLE_BRAND_BGM:'true'}),true);
});
test('random selector excludes previous track, allows single track and empty pool',()=>{
  assert.equal(chooseTrack(['a','b'],'a',()=>0),'b');assert.equal(chooseTrack(['a'],'a',()=>0),'a');assert.equal(chooseTrack([],null),null);
  assert.equal(chooseTrack(['a','b','c'],null,()=>2),'c');
});
test('brand comes only from trusted upstream with per-product priority',()=>{
  const batch={brandCopyContext:{brandId:'GC',provenance:'verified_handoff',products:{p:{brandId:'TokyoTiger'},n:{brandId:'NW'}}}};
  assert.equal(outputBrand(batch,{product_id:'p'}),'TT');assert.equal(outputBrand(batch,{product_id:'n'}),'NW');assert.equal(outputBrand(batch,{product_id:'x'}),'GC');
  assert.equal(outputBrand({brandCopyContext:{brandId:'GC'}},{}),null);
});
test('unknown or unsafe brand mapping fails soft without looking in other libraries',async()=>{
  for(const brand of ['UNKNOWN',null,'GC']){
    const result=await selectBrandBgm({root:process.cwd(),brand,ffmpeg:'unused',mapping:{GC:'../TT'}});
    assert.equal(result.status,'no_bgm');assert.equal(result.path,undefined);assert.ok(result.warnings.length);
  }
});
