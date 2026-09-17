import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  await writeFile(path.join(batchDir, 'cancel.request'), 'cancel');

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
  await assert.rejects(access(path.join(batchDir, 'cancel.request')), { code: 'ENOENT' });
  const queue = await readJson(path.join(root, 'data', 'service-queue.json'), { tasks: [] });
  assert.equal(queue.tasks.length, 1);
  assert.equal(queue.tasks[0].batchId, batch.id);
  assert.equal(queue.tasks[0].operation, 'quality');
  assert.equal(queue.tasks[0].workflowVersion, 4);
});

test('unverified Provider cannot resume a Batch', async () => {
  await assert.rejects(
    resumeOneBatchAfterProviderRecovery({ batchId: 'anything', providerHealth: { status: 'PENDING_RECOVERY' } }),
    /RECOVERY_VERIFIED/,
  );
});
