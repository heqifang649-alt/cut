import path from "node:path";
import { access } from "node:fs/promises";
import { readJson, writeJsonAtomic } from "../lib/atomic-json.mjs";
import { getBatch, mutateBatch } from "../lib/store.ts";
import { batchWorkspacePath } from "../lib/tenant-paths.mjs";
import { taskNumberForBatch } from "../lib/task-number.mjs";
import { resolveProviderConfig } from "../lib/ai-provider-config.mjs";
import { readProviderHealth } from "../lib/provider-incident.mjs";
import { enqueueStage, readQueue, resetBatchStagesForExplicitRetry } from "../worker/service-queue.mjs";

const root = process.cwd();
const canary = await readJson(path.join(root, "data", "multi-batch-canary.json"), null);
if (canary?.status !== "running" || canary.batchIds?.length !== 3) throw new Error("Expected active three-Batch Canary");
const { config } = await resolveProviderConfig(root);
const model = config.fastModel || config.candidateModels?.[0] || config.strongModel;
const provider = await readProviderHealth(config, model, { root });
if (!["OPEN_WAITING_PROVIDER", "PENDING_RECOVERY"].includes(provider.status)) throw new Error("Provider Incident is not open");
const queue = await readQueue(root);
if (queue.tasks.some((task) => task.status === "leased")) throw new Error("Active lease prevents controlled requeue");
const batches = [];
for (const id of canary.batchIds) {
  const batch = await getBatch(id);
  const manual = queue.tasks.findLast((task) => task.batchId === id && task.operation === "quality" && task.status === "manual" && Number(task.workflowVersion) === Number(batch?.workflowVersion));
  if (batch?.status !== "failed" || !manual || !/SEMANTIC_INCOMPLETE|Provider Incident is open/.test(batch.error || "")) throw new Error(`Batch is not an incident-misclassified quality task: ${id}`);
  if (await access(path.join(batchWorkspacePath(root, batch), "cancel.request")).then(() => true, () => false)) throw new Error(`Cancellation marker found: ${id}`);
  batches.push({ id, workflowVersion: batch.workflowVersion, priorError: batch.error });
}
if (!process.argv.includes("--apply")) { process.stdout.write(`${JSON.stringify({ dryRun: true, providerStatus: provider.status, batches }, null, 2)}\n`); process.exit(0); }
const at = new Date().toISOString();
const retryAt = new Date(Date.now() + 60_000).toISOString();
const reason = "PROVIDER_INCIDENT_OPEN";
for (const { id, workflowVersion } of batches) {
  await resetBatchStagesForExplicitRetry({ root, batchId: id, reason });
  const batch = await mutateBatch(id, (item) => {
    if (item.status !== "failed" || Number(item.workflowVersion) !== Number(workflowVersion)) throw new Error(`Batch changed during requeue: ${id}`);
    item.status = "batch_queued";
    item.error = undefined;
    item.renderingLabel = "Provider Incident 已隔离，等待 A–D 恢复检查；任务与已完成证据已保留";
    item.execution = { state: "backpressured", stage: "analyze", reason, retryAt, updatedAt: at };
  });
  await enqueueStage({ root, batchId: id, stage: "analyze", operation: "quality", priority: batch.priority, workflowVersion, taskNumber: taskNumberForBatch(batch), reason, notBefore: retryAt });
}
await writeJsonAtomic(path.join(canary.evidenceDir, "provider-incident-backpressure.json"), { at, providerStatus: provider.status, reason, retryAt, batches, externalRequestsSent: 0 });
process.stdout.write(`${JSON.stringify({ status: "backpressured", providerStatus: provider.status, retryAt, batchIds: canary.batchIds }, null, 2)}\n`);
