import path from 'node:path';
import { access } from 'node:fs/promises';
import { readJson, withFileLock, writeJsonAtomic } from './atomic-json.mjs';
import { batchWorkspacePath } from './tenant-paths.mjs';
import { taskNumberForBatch } from './task-number.mjs';
import { enqueueStage, resetBatchStagesForExplicitRetry } from '../worker/service-queue.mjs';

const batchesFile = root => path.join(root, 'data', 'batches.json');

export async function resumeOneBatchAfterProviderRecovery({ root = process.cwd(), batchId, providerHealth } = {}) {
  if (providerHealth?.status !== 'RECOVERY_VERIFIED' || providerHealth?.healthStatus !== 'HEALTHY') {
    throw new Error('Provider must be RECOVERY_VERIFIED and HEALTHY before resuming a Batch');
  }
  const file = batchesFile(root);
  let batch;
  await withFileLock(file, async () => {
    const batches = await readJson(file, []);
    const index = batches.findIndex(item => item.id === batchId || item.taskNumber === batchId);
    if (index < 0) throw new Error('Batch not found');
    const current = batches[index];
    if (current.status !== 'failed') throw new Error(`Only a failed Batch may be resumed without separate canceled-Batch authorization: ${current.status}`);
    const batchDir = batchWorkspacePath(root, current);
    if (await access(path.join(batchDir, 'cancel.request')).then(() => true, () => false)) throw new Error('Batch has a cancellation marker and cannot be auto-resumed');
    current.workflowVersion = Math.max(1, Number(current.workflowVersion) || 1) + 1;
    current.status = 'batch_queued';
    current.progress = 40;
    current.error = undefined;
    current.execution = { state: 'queued', stage: 'analyze', reason: 'provider_recovery_verified', updatedAt: new Date().toISOString() };
    current.renderingLabel = 'Provider recovery verified; continuing unfinished semantic Shots';
    current.updatedAt = new Date().toISOString();
    batches[index] = current;
    await writeJsonAtomic(file, batches);
    batch = structuredClone(current);
  });

  const batchDir = batchWorkspacePath(root, batch);
  await resetBatchStagesForExplicitRetry({ root, batchId: batch.id, reason: 'provider_recovery_verified' });
  await writeJsonAtomic(path.join(batchDir, 'service-stage.json'), {
    schemaVersion: 1,
    next: 'analyze',
    operation: 'quality',
    workflowVersion: batch.workflowVersion,
    queuedAt: new Date().toISOString(),
    reason: 'provider_recovery_verified',
  });
  await writeJsonAtomic(path.join(batchDir, 'provider-recovery-resume.json'), {
    schemaVersion: 1,
    workflowVersion: batch.workflowVersion,
    providerScope: providerHealth.scope || null,
    verifiedAt: providerHealth.verifiedAt || new Date().toISOString(),
    reuseCompletedEvidence: true,
    resumeOperation: 'quality',
  });
  const task = await enqueueStage({
    root,
    batchId: batch.id,
    stage: 'analyze',
    operation: 'quality',
    priority: batch.priority,
    workflowVersion: batch.workflowVersion,
    reason: 'provider_recovery_verified',
    taskNumber: taskNumberForBatch(batch),
  });
  return { batch, task, resumedBatchCount: 1 };
}
