import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { openProviderIncident, assertProviderAvailable, providerScope, readProviderHealth, recordProviderResult, requireProviderRecovery, runProviderRecovery } from '../lib/provider-incident.mjs';
import { AiProviderAdapter } from '../lib/ai-provider-adapter.mjs';
import { DurableProviderRequestGuard } from '../lib/ai-provider-guard.mjs';
import { qualityEvidenceProviderJsonSchema } from '../lib/quality-evidence-v2.mjs';
const config = { baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture', fastModel: 'm', protocolMode: 'responses', retryLimit: 0, requestTimeoutMs: 1000 };
const temp = () => mkdtemp(path.join(os.tmpdir(), 'incident-'));
test('queue admission does not gate on historical Provider incident state', async () => {
  const route = await readFile(new URL('../app/api/batches/[id]/queue-reference/route.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(route, /assertProviderAvailable|Recovery Check A.D is required/);
  assert.ok(route.indexOf('await ensureFleetAvailable') < route.indexOf('await resetBatchStagesForExplicitRetry'));
  assert.match(route, /manualStageForBatch/);
});
test('durable guard admits a live request while retaining incident evidence', async () => {
  const root = await temp(); await openProviderIncident(config, { root });
  const g = new DurableProviderRequestGuard({ ...config, root }); let calls = 0;
  assert.equal(await g.run(async () => { calls++; return 'live'; }), 'live');
  assert.equal(calls, 1);
});
test('open incident remains visible while a normal adapter request proves current availability', async () => {
  const root = await temp(); await openProviderIncident(config, { root });
  let dispatches = 0;
  const a = new AiProviderAdapter(config, { root, recoveryPermit: {}, fetchImpl: async () => {
    dispatches++;
    return new Response(JSON.stringify({ output_text: 'ok' }));
  } });
  assert.equal((await a.complete({ model: 'm', prompt: 'x' })).text, 'ok');
  assert.equal(dispatches, 1);
  const url = new URL('../lib/provider-incident.mjs', import.meta.url).href;
  const code = `import {assertProviderAvailable} from ${JSON.stringify(url)}; const v=await assertProviderAvailable(${JSON.stringify(config)},'m',{root:${JSON.stringify(root)}}); process.exit(v?.status==='OPEN_WAITING_PROVIDER'?0:2)`;
  assert.equal(spawnSync(process.execPath, ['--input-type=module', '-e', code]).status, 0);
});
test('schema-invalid model output does not open the Provider circuit or gate live requests', async () => {
  const root = await temp(); let requests = 0;
  for (let i = 0; i < 4; i++) {
    const a = new AiProviderAdapter(config, { root, fetchImpl: async () => { requests++; return new Response('{}', { status: 200 }); } });
    await assert.rejects(a.complete({ model: 'm', prompt: 'x', jsonSchema: { properties: { schema_version: { const: 'semantic-shot.v1' } } } }), { code: 'SEMANTIC_SCHEMA_INVALID' });
  }
  assert.equal((await assertProviderAvailable(config, 'm', { root })).status, 'HEALTHY'); assert.equal(requests, 4);
});
test('incident opened after admission does not cancel an already-admitted live request', async () => {
  const root = await temp(); let dispatches = 0;
  const a = new AiProviderAdapter(config, { root, fetchImpl: async () => { dispatches++; return new Response(JSON.stringify({ output_text: 'ok' })); } });
  const response = await a.complete({ model:'m', prompt:'x', beforeDispatch: async phase => {
    if(phase === 'acquire') await openProviderIncident(config,{root});
  } });
  assert.equal(response.text, 'ok');
  assert.equal(dispatches,1);
});
test('business rejection and cancellation do not count; valid unusable result resets faults', async () => {
  const root = await temp();
  for (const code of ['REVIEW', 'REJECT', 'WRONG_SKU', 'USER_CANCELED']) for (let n = 0; n < 4; n++) await recordProviderResult(config, 'm', { code }, { root });
  await assertProviderAvailable(config, 'm', { root });
  await recordProviderResult(config, 'm', { code: 'PROVIDER_TIMEOUT' }, { root });
  const result = { schema_version: 'semantic-shot.v1', shot_id: 's', shot_type: 'other', product_match: 0, clothing_visibility: 0, visual_quality: 0, hook_value: 0, usable: false, confidence: 1 };
  const a = new AiProviderAdapter(config, { root, fetchImpl: async () => new Response(JSON.stringify({ output_text: JSON.stringify(result) })) });
  assert.equal((await a.scoreShot({ model: 'm', shotId: 's', prompt: 'x' })).result.usable, false);
  assert.equal((await assertProviderAvailable(config, 'm', { root })).consecutiveFailures, 0);
});
test('local Shot budget expiration does not open a global Provider incident', async () => {
  const root = await temp();
  for (let n = 0; n < 4; n++) await recordProviderResult(config, 'm', { code: 'SEMANTIC_SHOT_BUDGET_EXCEEDED' }, { root });
  const health = await assertProviderAvailable(config, 'm', { root });
  assert.equal(health.consecutiveFailures, 0);
});
test('valid quality evidence with wrong SKU remains a valid Provider result', async () => {
  const root = await temp();
  const evidence = { schema_version:'quality-evidence-provider.v2', source_id:'s', artifacts:Object.fromEntries(['hand','face','body','temporal'].map(k=>[k,{severity:'none',confidence:1,region:'unknown',evidence_frames:[]} ])), product:{match:'mismatch',wrong_sku:'mismatch',product_error:'match',graphic_text_logo:'mismatch',color:'match',structure:'match',evidence_frames:[1],confidence:1},usability:'unusable',confidence:1 };
  const a = new AiProviderAdapter(config,{root,fetchImpl:async()=>new Response(JSON.stringify({output_text:JSON.stringify(evidence)}))});
  for(let i=0;i<4;i++) await a.complete({model:'m',prompt:'x',jsonSchema:qualityEvidenceProviderJsonSchema()});
  assert.equal((await assertProviderAvailable(config,'m',{root})).consecutiveFailures,0);
});
test('each recovery failure stops immediately and leaves incident open; only full A-D clears', async () => {
  const stages = ['A', 'B', 'C', 'D1', 'D2', 'D3'];
  for (let fail = 0; fail <= 6; fail++) {
    const root = await temp(); await openProviderIncident(config, { root }); const seen = [];
    const reportFile = path.join(root, 'check.json');
    const report = await runProviderRecovery({ config, root, reportFile, check: async (stage, permit) => {
      assert.equal((await assertProviderAvailable(config, 'm', { root })).status, 'OPEN_WAITING_PROVIDER');
      await assertProviderAvailable(config, 'm', { root, permit }); seen.push(stage);
      if (stages.indexOf(stage) === fail) throw Object.assign(new Error('fixture'), { code: 'PROVIDER_TIMEOUT' });
      return { valid: true, protocol: 'responses' };
    } });
    assert.deepEqual(seen, stages.slice(0, Math.min(6, fail + 1)));
    assert.equal(JSON.parse(await readFile(reportFile)).status, report.status);
    if (fail < 6) {
      assert.equal((await assertProviderAvailable(config, 'm', { root })).status, 'OPEN_WAITING_PROVIDER');
      const incidents = JSON.parse(await readFile(path.join(root, 'data/provider-incidents.json')));
      assert.equal(Object.values(incidents.scopes)[0].recoveryRunId, null);
    }
    else assert.equal((await assertProviderAvailable(config, 'm', { root })).status, 'RECOVERY_VERIFIED');
  }
});

test('a new logical Provider has independent health and never inherits the old Provider incident', async () => {
  const root = await temp();
  const oldProvider = { ...config, providerId: 'provider-old' };
  const newProvider = { ...config, providerId: 'provider-new' };
  await openProviderIncident(oldProvider, { root, batchId: 'old-batch' });
  assert.equal((await assertProviderAvailable(oldProvider, 'm', { root })).status, 'OPEN_WAITING_PROVIDER');
  assert.notEqual(providerScope(oldProvider, 'm'), providerScope(newProvider, 'm'));
  assert.equal((await readProviderHealth(newProvider, 'm', { root })).status, 'UNVERIFIED');

  await requireProviderRecovery(newProvider, { root, model: 'm', batchId: 'resume-one' });
  assert.equal((await assertProviderAvailable(newProvider, 'm', { root })).status, 'PENDING_RECOVERY');
  const report = await runProviderRecovery({
    config: newProvider,
    model: 'm',
    root,
    reportFile: path.join(root, 'new-provider-recovery.json'),
    check: async stage => ({ valid: true, stage, protocol: 'responses' }),
  });
  assert.equal(report.status, 'RECOVERY_VERIFIED');
  const health = await readProviderHealth(newProvider, 'm', { root });
  assert.equal(health.status, 'RECOVERY_VERIFIED');
  assert.equal(health.healthStatus, 'HEALTHY');
  await assertProviderAvailable(newProvider, 'm', { root });
  assert.equal((await assertProviderAvailable(oldProvider, 'm', { root })).status, 'OPEN_WAITING_PROVIDER');
});
