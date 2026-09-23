// 运维入口：在 Provider Recovery Check A-D 全通过（RECOVERY_VERIFIED / HEALTHY）之后，
// 把指定批次从 failed/canceled 正式接续回队列。
// 复用 lib/provider-recovery-resume.mjs，不自行改写批次或队列状态。
//
// 用法：
//   node scripts/resume-batches-after-provider-recovery.mjs GC-20260921-5FE9CC69 GC-20260921-FB7EEE27
//
// 接受 Batch UUID 或任务号；未通过恢复检查时直接拒绝，不产生任何状态变更。
import { resolveProviderConfig } from '../lib/ai-provider-config.mjs';
import { readProviderHealth } from '../lib/provider-incident.mjs';
import { resumeOneBatchAfterProviderRecovery } from '../lib/provider-recovery-resume.mjs';

process.loadEnvFile('.env.local');
const root = process.cwd();
const targets = process.argv.slice(2).filter(Boolean);
if (!targets.length) {
  throw new Error('Require at least one Batch id or task number, e.g. GC-20260921-5FE9CC69');
}

const { config } = await resolveProviderConfig(root);
const model = config.fastModel || config.strongModel;
if (!model) throw new Error('No active Provider model is configured');

const providerHealth = await readProviderHealth(config, model, { root });
if (providerHealth.status !== 'RECOVERY_VERIFIED' || providerHealth.healthStatus !== 'HEALTHY') {
  throw new Error(`Provider is not RECOVERY_VERIFIED/HEALTHY yet: ${providerHealth.status} / ${providerHealth.healthStatus}`);
}

const resumed = [];
for (const target of targets) {
  const result = await resumeOneBatchAfterProviderRecovery({ root, batchId: target, providerHealth });
  resumed.push({
    target,
    batchId: result.batch.id,
    taskNumber: result.batch.taskNumber,
    workflowVersion: result.batch.workflowVersion,
    status: result.batch.status,
    queueKey: result.task.key,
  });
}

console.log(JSON.stringify({ providerScope: providerHealth.scope, verifiedAt: providerHealth.verifiedAt || null, resumedBatchCount: resumed.length, resumed }, null, 2));
