import path from "node:path";
import { access } from "node:fs/promises";
import { readJson, writeJsonAtomic } from "../lib/atomic-json.mjs";
import { resolveProviderConfig } from "../lib/ai-provider-config.mjs";
import { readProviderHealth } from "../lib/provider-incident.mjs";
import { getBatch, mutateBatch } from "../lib/store.ts";
import { batchWorkspacePath } from "../lib/tenant-paths.mjs";
import { taskNumberForBatch } from "../lib/task-number.mjs";
import { enqueueStage, resetBatchStagesForExplicitRetry } from "../worker/service-queue.mjs";

const root = process.cwd();
const args = process.argv.slice(2);
const batchId = args.find((arg) => arg.startsWith("--batch="))?.slice(8);
const apply = args.includes("--apply");
if (!batchId) throw new Error("Require --batch=<id>; --apply performs the guarded resume");
const canary = await readJson(path.join(root, "data", "multi-batch-canary.json"), null);
const queue = await readJson(path.join(root, "data", "service-queue.json"), null);
const fleet = await readJson(path.join(root, "data", "fleet-runtime.json"), null);
if (canary?.status !== "running" || !canary.batchIds?.includes(batchId) || fleet?.claimsEnabled !== false
  || !fleet.canaryBatchIds?.includes(batchId)) throw new Error("Batch is outside the active isolated Canary");
const batch = await getBatch(batchId);
const directory = batch && batchWorkspacePath(root, batch);
const diagnostics = directory && await readJson(path.join(directory, "failure-diagnostics.json"), null);
const marker = directory && await readJson(path.join(directory, "service-stage.json"), null);
const task = queue?.tasks?.find((item) => item.batchId === batchId && item.status === "manual" && item.operation === "reference");
if (batch?.status !== "failed" || !/Concurrency limit exceeded for user/.test(batch.error || "")
  || diagnostics?.latest?.errorCode !== "PROVIDER_REQUEST_FAILED" || !task
  || marker?.operation !== "reference" || marker.next !== "analyze"
  || await access(path.join(directory, "cancel.request")).then(() => true, () => false)) {
  throw new Error("Batch is not the uncanceled Provider-capacity reference failure under review");
}
const { config } = await resolveProviderConfig(root);
if (config.fastModel !== "gpt-6-sol" || config.strongModel !== "gpt-6-sol") throw new Error("Approved model changed");
const health = await readProviderHealth(config, config.strongModel, { root });
if (health.status !== "RECOVERY_VERIFIED" || health.healthStatus !== "HEALTHY") throw new Error("Provider Incident is not healthy");
const result = { applied: apply, batchId, operation: "reference", cachedVisualEvidencePreserved: true,
  fromWorkflowVersion: batch.workflowVersion, toWorkflowVersion: batch.workflowVersion + 1 };
if (apply) {
  const at = new Date().toISOString();
  const resumed = await mutateBatch(batchId, (item) => {
    if (item.status !== "failed" || item.workflowVersion !== batch.workflowVersion) throw new Error("Batch changed before recovery");
    item.workflowVersion = batch.workflowVersion + 1;
    item.status = "reference_queued";
    item.progress = 10;
    item.error = undefined;
    item.recoveryAttempts = 0;
    item.renderingLabel = "Provider 容量恢复：沿用已缓存素材分析继续识别";
    item.execution = { state: "queued", stage: "analyze", reason: "provider_capacity_recovery", updatedAt: at };
  });
  await resetBatchStagesForExplicitRetry({ root, batchId, reason: "provider_capacity_recovery" });
  await writeJsonAtomic(path.join(directory, "service-stage.json"), {
    ...marker, next: "analyze", operation: "reference", workflowVersion: resumed.workflowVersion,
    queuedAt: at, reason: "provider_capacity_recovery", canaryRunId: canary.runId,
  });
  await enqueueStage({ root, batchId, stage: "analyze", operation: "reference", priority: resumed.priority,
    workflowVersion: resumed.workflowVersion, taskNumber: taskNumberForBatch(resumed), reason: "provider_capacity_recovery" });
  await writeJsonAtomic(path.join(canary.evidenceDir, `provider-capacity-resume-${batchId}.json`), { ...result, at,
    priorFailureCode: diagnostics.latest.errorCode });
}
process.stdout.write(`${JSON.stringify(result)}\n`);
