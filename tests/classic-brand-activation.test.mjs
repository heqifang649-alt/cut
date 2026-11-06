import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeJsonAtomic } from '../lib/atomic-json.mjs';
import { classicBrandActivation, enableClassicBrandResources } from '../lib/classic-brand-activation.mjs';
import { brandBgmEnabled } from '../worker/brand-bgm.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cut-brand-scope-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  const policy = {schemaVersion:1, enabled:true, mode:'canary', enabledAfter:'2026-11-02T00:00:00Z'};
  const setPolicy = p => writeJsonAtomic(path.join(root,'config/classic-brand-activation.json'), p);
  await setPolicy(policy);
  await writeJsonAtomic(path.join(root,'config/brand-copy-files.json'), {filesByBrand:{TT:['tt.xlsx'], GC:['gc.xlsx'], NW:['nw.xlsx']}});
  await writeJsonAtomic(path.join(root,'config/brand-bgm-directories.json'), {TT:'亚文化', GC:'基督', NW:'暗黑'});
  const input = {root, taskId:randomUUID(), manifestSha256:'a'.repeat(64), acceptedAt:'2026-11-02T01:00:00Z', context:{brandId:'tokyotiger', provenance:'verified_handoff'}, sources:[{brandIdentity:'tokyotiger'}]};
  return {input, root, policy, setPolicy};
}

test('batch BGM switch leaves global environment unchanged', () => {
  assert.equal(brandBgmEnabled({}, {brandBgmEnabled:true}), true);
  assert.equal(brandBgmEnabled({}, {}), false);
  assert.equal(brandBgmEnabled({ENABLE_BRAND_BGM:'true'}, {}), true);
});
test('single concurrent canary, durable identity and immediate rollback', async t => {
  const {input,policy,setPolicy} = await fixture(t);
  const attempts = Array.from({length:8}, () => ({...input, taskId:randomUUID()}));
  const results = await Promise.all(attempts.map(x => classicBrandActivation(x)));
  assert.equal(results.filter(Boolean).length, 1);
  const winner = attempts[results.findIndex(Boolean)];
  assert.equal((await enableClassicBrandResources(winner)).brandBgmEnabled, true);
  assert.ok(await classicBrandActivation({...winner, allocate:false}));
  assert.equal(await classicBrandActivation({...winner, manifestSha256:'b'.repeat(64)}), null);
  await setPolicy({...policy,enabled:false});
  assert.equal(await classicBrandActivation({...winner,allocate:false}), null);
});
test('historical, unknown, untrusted and cross-brand inputs remain compatible', async t => {
  const {input} = await fixture(t);
  for (const override of [
    {acceptedAt:'2026-11-01T00:00:00Z'}, {acceptedAt:'bad'},
    {context:{brandId:'pagewings',provenance:'verified_handoff'}},
    {context:{brandId:'TT',provenance:'authenticated_api'}},
    {sources:[{brandIdentity:'guidingcross'}]},
    {context:{...input.context,products:{p:{brandId:'GC'}}}},
    {manifestSha256:'bad'},
  ]) assert.deepEqual(await enableClassicBrandResources({...input,...override}), {});
  assert.equal((await enableClassicBrandResources(input)).brandCopyEnabled, true);
});
for (const brand of ['guidingcross','tokyotiger','NW']) test(`formal mapped identity ${brand}`, async t => {
  const {input} = await fixture(t);
  assert.ok(await classicBrandActivation({...input, context:{brandId:brand,provenance:'verified_handoff'}, sources:[{brandIdentity:brand}]}));
});
test('missing formal mappings and unaccepted expansion do not activate', async t => {
  const {input,root,policy,setPolicy} = await fixture(t);
  await setPolicy({...policy,mode:'all'});
  assert.equal(await classicBrandActivation(input), null);
  await setPolicy({...policy,mode:'all',canaryAccepted:true,canaryEvidence:'operator-reviewed.json'});
  assert.ok(await classicBrandActivation(input));
  await writeJsonAtomic(path.join(root,'config/brand-bgm-directories.json'), {});
  assert.equal(await classicBrandActivation(input), null);
});


test('normal GC TT scope enables copy and music together without altering Canary',async t=>{
 const {input,root,policy,setPolicy}=await fixture(t);await classicBrandActivation(input);
 const fs=await import('node:fs/promises');const stateFile=path.join(root,'data/classic-brand-activation-state.json');const before=await fs.readFile(stateFile,'utf8');
 const normal={...policy,normalClassicBrandResources:true,normalEnabledAfter:policy.enabledAfter};await setPolicy(normal);
 for(const brand of ['guidingcross','tokyotiger']){const other={...input,taskId:randomUUID(),context:{brandId:brand,provenance:'verified_handoff'},sources:[{brandIdentity:brand}]};const flags=await enableClassicBrandResources(other);assert.equal(flags.brandCopyEnabled,true);assert.equal(flags.brandBgmEnabled,true);assert.equal(flags.classicBrandActivation.scope,'normal_gc_tt');}
 assert.equal(await fs.readFile(stateFile,'utf8'),before);
 const other={...input,taskId:randomUUID()};await setPolicy({...normal,normalEnabledAfter:'2026-11-02T02:00:00Z'});assert.deepEqual(await enableClassicBrandResources(other),{});
 await setPolicy(normal);for(const brand of ['NW','pagewings'])assert.deepEqual(await enableClassicBrandResources({...other,context:{brandId:brand,provenance:'verified_handoff'},sources:[{brandIdentity:brand}]}),{});
 await setPolicy({...normal,normalClassicBrandResources:false});assert.deepEqual(await enableClassicBrandResources(other),{});
});
