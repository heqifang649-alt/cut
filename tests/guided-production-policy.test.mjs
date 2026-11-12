import test from 'node:test';
import assert from 'node:assert/strict';
import {eligibleForSafePool,productionGuidedMode,renderWithGuidedFallback} from '../worker/guided-production-policy.mjs';
const fixture=()=>({policy:{enabled:true,mode:'safe-pool',activatedAt:'2026-11-12T02:00:00Z',excludedTaskIds:['old']},
 record:{taskId:'new',acceptedAt:'2026-11-12T02:01:00Z',attempt:0,contractVersion:'libtv-cut-lan-multi/2',manifestSha256:'hash',userId:'employee',handoffKey:'multi-new',sources:[{source:{user_id:'employee'}},{source:{user_id:'employee'}}]},
 manifest:{taskId:'new',created_at:'2026-11-12T02:00:01',userId:'employee',handoffKey:'multi-new'},manifestSha256:'hash',manifestMtime:Date.parse('2026-11-12T02:00:02Z')});
test('new admitted guided defaults on only after submitted, NAS and acceptance cutoffs',()=>assert.equal(eligibleForSafePool(fixture()),true));
test('old submitted packages scanned later stay original',()=>{const x=fixture();x.manifest.created_at='2026-11-12T01:59:59';assert.equal(eligibleForSafePool(x),false);});
test('already accepted records and snapshot exclusions stay original',()=>{const x=fixture();x.record.acceptedAt=x.policy.activatedAt;assert.equal(eligibleForSafePool(x),false);const y=fixture();y.record.taskId='old';assert.equal(eligibleForSafePool(y),false);});
test('single source, templates, retries, wrong identity and disabled policy stay original',()=>{
 for(const change of [{sources:[{}]},{contractVersion:'template'},{attempt:1},{userId:'other'}]){const x=fixture();Object.assign(x.record,change);assert.equal(eligibleForSafePool(x),false);}
 const x=fixture();x.policy.enabled=false;assert.equal(eligibleForSafePool(x),false);
});
test('manifest integrity or NAS age mismatch cannot activate',()=>{for(const change of [{manifestSha256:'other'},{manifestMtime:0}])assert.equal(eligibleForSafePool({...fixture(),...change}),false);});
test('missing or unreadable optional policy returns existing mode',async()=>assert.equal(await productionGuidedMode({root:'not-a-real-policy',record:{},config:{},fallback:'original'}),'original'));
test('render exception automatically uses exact original guided products',async()=>{const legacy=[{id:'old'}],refined=[{id:'new'}];let called=false;const r=await renderWithGuidedFallback({options:{batch:{id:'task'}},refined,legacy,renderGuided:async()=>{throw Error('optimisation_failed');},renderer:async o=>{called=true;assert.strictEqual(o.scheduledProducts,legacy);return 'ok';}});assert(called);assert.equal(r,'ok');});
test('success does not render twice',async()=>{const r=await renderWithGuidedFallback({options:{},refined:[],legacy:[],renderGuided:async()=>'ok',renderer:async()=>{throw Error('unexpected');}});assert.equal(r,'ok');});
test('cancel is never retried, while optional audit failure cannot block fallback',async()=>{
 await assert.rejects(renderWithGuidedFallback({options:{},renderGuided:async()=>{throw Object.assign(Error('cancel'),{name:'AbortError'});},renderer:async()=>{assert.fail();}}),{name:'AbortError'});
 assert.equal(await renderWithGuidedFallback({options:{},legacy:[],renderGuided:async()=>{throw Error();},onFallback:async()=>{throw Error();},renderer:async()=>true}),true);
});
