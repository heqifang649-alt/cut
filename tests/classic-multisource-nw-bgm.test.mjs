import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalBrand } from '../lib/brand-copy-library.mjs';
import { classicMultisourceBgm } from '../worker/classic-multisource-bgm.mjs';
import { outputBrand } from '../worker/brand-bgm.mjs';

test('verified Nerdywave handoff gets NW music independently of copy activation', () => {
  for (const value of ['NW', 'nerdywave', 'NerdyWave']) {
    assert.equal(canonicalBrand(value), 'NW');
    const batch = classicMultisourceBgm({sourceBinding:{kind:'brand',value},sources:[{brandIdentity:'nerdywave'}]});
    assert.equal(batch.brandBgmEnabled,true);
    assert.equal(outputBrand(batch,{}),'NW');
    assert.equal(batch.brandCopyEnabled,undefined);
  }
});
test('missing, product-scoped, unknown and mixed-brand inputs never enable NW music', () => {
  for (const record of [{}, {sourceBinding:{kind:'product',value:'NW'},sources:[{brandIdentity:'NW'}]},
    {sourceBinding:{kind:'brand',value:'NW'},sources:[]},
    {sourceBinding:{kind:'brand',value:'NW'},sources:[{brandIdentity:'TT'}]},
    {sourceBinding:{kind:'brand',value:'unknown'},sources:[{brandIdentity:'NW'}]}]) {
    const result=classicMultisourceBgm(record);
    assert.equal(result.brandBgmEnabled,false);assert.ok(result.brandBgmResolution.reason);
  }
});
