import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import { getBatch, mutateBatch } from "../lib/store.ts";
import { writeJsonAtomic } from "../lib/atomic-json.mjs";
import { batchWorkspacePath } from "../lib/tenant-paths.mjs";
import { enqueueStage, resetBatchStagesForExplicitRetry } from "../worker/service-queue.mjs";
import { taskNumberForBatch } from "../lib/task-number.mjs";

const ROOT = process.cwd();

export async function prepareProductionCanary({ batchIds } = {}) {
  if (!Array.isArray(batchIds) || batchIds.length < 3 || batchIds.length > 5) throw new Error("Canary requires 3-5 explicit Batch ids");
  const uniqueIds = [...new Set(batchIds)];
  if (uniqueIds.length !== batchIds.length) throw new Error("Canary Batch ids must be unique");
  const batches = await Promise.all(uniqueIds.map((id) => getBatch(id)));
  if (batches.some((batch) => !batch)) throw new Error("One or more Canary Batches do not exist");
  for (const batch of batches) {
    if (batch.status !== "uploading") throw new Error(`${taskNumberForBatch(batch)} is ${batch.status}; only untouched uploading Batches may enter this Canary`);
    if (!batch.referenceProfile || !batch.templateId) throw new Error(`${taskNumberForBatch(batch)} has no ready template profile`);
    if (!batch.files.some((file) => file.kind === "products")) throw new Error(`${taskNumberForBatch(batch)} has no product videos`);
  }

  const runId = `multi-batch-canary-${new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-")}`;
  const evidenceDir = path.join(ROOT, ".project-governance", "evidence", "multi-batch-canary", runId);
  await mkdir(evidenceDir, { recursive: true });
  await writeJsonAtomic(path.join(evidenceDir, "initial-batches.json"), batches);
  const prepared = [];
  for (const original of batches) {
    const batchDir = batchWorkspacePath(ROOT, original);
    await resetBatchStagesForExplicitRetry({ root: ROOT, batchId: original.id, reason: `production_canary:${runId}` });
    const batch = await mutateBatch(original.id, (item) => {
      item.workflowVersion = Math.max(1, Number(item.workflowVersion) || 1) + 1;
      item.coveragePolicy = "all_products_required";
      item.status = "reference_queued";
      item.progress = 10;
      item.error = undefined;
      item.renderingLabel = "生产 Canary：等待样片与产品识别";
      item.execution = { state: "queued", stage: "analyze", reason: `production_canary:${runId}`, updatedAt: new Date().toISOString() };
    });
    await mkdir(batchDir, { recursive: true });
    await writeJsonAtomic(path.join(batchDir, "reference-profile.json"), batch.referenceProfile);
    await writeJsonAtomic(path.join(batchDir, "service-stage.json"), { schemaVersion: 1, next: "analyze", operation: "reference", workflowVersion: batch.workflowVersion, queuedAt: new Date().toISOString(), canaryRunId: runId });
    await enqueueStage({ root: ROOT, batchId: batch.id, stage: "analyze", operation: "reference", priority: batch.priority, workflowVersion: batch.workflowVersion, reason: `production_canary:${runId}`, taskNumber: taskNumberForBatch(batch) });
    prepared.push({ id: batch.id, taskNumber: taskNumberForBatch(batch), name: batch.name, workflowVersion: batch.workflowVersion, targetOutputsPerBatch: batch.targetOutputsPerBatch, coveragePolicy: batch.coveragePolicy });
  }
  const state = { schemaVersion: 1, runId, status: "running", startedAt: new Date().toISOString(), featureFlagDefaultChanged: false, fairSchedulerEnabled: true, batchIds: uniqueIds, targetPolicy: "detected_products", coveragePolicy: "all_products_required", evidenceDir, prepared };
  await writeJsonAtomic(path.join(ROOT, "data", "multi-batch-canary.json"), state);
  await writeJsonAtomic(path.join(evidenceDir, "canary-start.json"), state);
  return state;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const batchIds = process.argv.filter((arg) => arg.startsWith("--batch=")).map((arg) => arg.slice("--batch=".length));
  const state = await prepareProductionCanary({ batchIds });
  process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
}
