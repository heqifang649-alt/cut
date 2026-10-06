import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resumeOneBatchAfterProviderRecovery } from '../lib/provider-recovery-resume.mjs';
import { readJson } from '../lib/atomic-json.mjs';

test('verified Provider resumes exactly one Batch at quality and preserves completed Evidence', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cutflow-provider-resume-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const batch = { id: 'batch-one', taskNumber: 'GC-ONE', ownerId: 'owner', status: 'failed', progress: 40, workflowVersion: 3, priority: 'HIGH', files: [] };
  const untouched = { id: 'batch-two', taskNumber: 'GC-TWO', ownerId: 'owner', status: 'failed', progress: 40, workflowVersion: 7, files: [] };
  await mkdir(path.join(root, 'data'), { recursive: true });
  await writeFile(path.join(root, 'data', 'batches.json'), JSON.stringify([batch, untouched]));
  const batchDir = path.join(root, 'storage', 'batches', batch.id);
  await mkdir(batchDir, { recursive: true });
  const evidence = JSON.stringify({ records: [{ shotId: 'done', result: { usable: true } }] });
  await writeFile(path.join(batchDir, 'semantic-attempts.v1.json'), evidence);

  const resumed = await resumeOneBatchAfterProviderRecovery({
    root,
    batchId: 'GC-ONE',
    providerHealth: { status: 'RECOVERY_VERIFIED', healthStatus: 'HEALTHY' },
  });
  assert.equal(resumed.resumedBatchCount, 1);
  const batches = await readJson(path.join(root, 'data', 'batches.json'), []);
  assert.equal(batches[0].status, 'batch_queued');
  assert.equal(batches[0].workflowVersion, 4);
  assert.equal(batches[1].status, 'failed');
  assert.equal(batches[1].workflowVersion, 7);
  assert.equal(await readFile(path.join(batchDir, 'semantic-attempts.v1.json'), 'utf8'), evidence);
  const queue = await readJson(path.join(root, 'data', 'service-queue.json'), { tasks: [] });
  assert.equal(queue.tasks.length, 1);
  assert.equal(queue.tasks[0].batchId, batch.id);
  assert.equal(queue.tasks[0].operation, 'quality');
  assert.equal(queue.tasks[0].workflowVersion, 4);
});

test('Provider recovery never revives canceled Batches or ignores a cancellation marker', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cutflow-provider-cancel-fence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'data'), { recursive: true });
  await writeFile(path.join(root, 'data', 'batches.json'), JSON.stringify([
    { id: 'canceled', status: 'canceled', workflowVersion: 1 },
    { id: 'cancel-marked', status: 'failed', workflowVersion: 1 },
  ]));
  const dir = path.join(root, 'storage', 'batches', 'cancel-marked');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'cancel.request'), 'cancel');
  const providerHealth = { status: 'RECOVERY_VERIFIED', healthStatus: 'HEALTHY' };
  await assert.rejects(resumeOneBatchAfterProviderRecovery({ root, batchId: 'canceled', providerHealth }), /Only a failed Batch/);
  await assert.rejects(resumeOneBatchAfterProviderRecovery({ root, batchId: 'cancel-marked', providerHealth }), /cancellation marker/);
  const batches = await readJson(path.join(root, 'data', 'batches.json'), []);
  assert.deepEqual(batches.map(batch => batch.status), ['canceled', 'failed']);
  assert.equal(await readFile(path.join(dir, 'cancel.request'), 'utf8'), 'cancel');
});

test('unverified Provider cannot resume a Batch', async () => {
  await assert.rejects(
    resumeOneBatchAfterProviderRecovery({ batchId: 'anything', providerHealth: { status: 'PENDING_RECOVERY' } }),
    /RECOVERY_VERIFIED/,
  );
});

test('A-D operator script does not mutate a backpressured or canceled Batch after verification', async () => {
  const source = await readFile(new URL('../scripts/check-provider-recovery.mjs', import.meta.url), 'utf8');
  assert.match(source, /if \(latest\?\.status === 'failed'\) resume = await resumeOneBatchAfterProviderRecovery/);
  assert.match(source, /latest\?\.status === 'editing' && latest\?\.execution\?\.state === 'backpressured'/);
});
