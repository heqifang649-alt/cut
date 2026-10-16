import path from "node:path";
import { mkdir } from "node:fs/promises";
import { readJson, writeJsonAtomic } from "../lib/atomic-json.mjs";
import { getBatch, mutateBatch } from "../lib/store.ts";
import { batchWorkspacePath } from "../lib/tenant-paths.mjs";
import { taskNumberForBatch } from "../lib/task-number.mjs";
import { enqueueStage, resetBatchStagesForExplicitRetry } from "../worker/service-queue.mjs";

const root = process.cwd();
const stateFile = path.join(root, "data", "multi-batch-canary.json");
const canary = await readJson(stateFile, null);
if (canary?.status !== "running" || !Array.isArray(canary.batchIds)) throw new Error("No running production canary found.");
const replacementIds = process.argv.filter((arg) => arg.startsWith("--batch=")).map((arg) => arg.slice("--batch=".length));
if (replacementIds.length < 3 || replacementIds.length > 5 || new Set(replacementIds).size !== replacementIds.length) {
  throw new Error("Replacement requires 3-5 unique Batch ids.");
}
const replacements = await Promise.all(replacementIds.map((id) => getBatch(id)));
for (const batch of replacements) {
  if (!batch || batch.status !== "uploading" || !batch.referenceProfile || !batch.templateId) throw new Error(`Replacement Batch is not untouched and ready: ${batch?.id || "missing"}`);
  if (!batch.files?.some((file) => file.kind === "products")) throw new Error(`${taskNumberForBatch(batch)} has no product videos.`);
}

const at = new Date().toISOString();
await writeJsonAtomic(path.join(canary.evidenceDir, `replacement-input-${at.replaceAll(":", "-").replaceAll(".", "-")}.json`), replacements);
const prepared = [];
for (const original of replacements) {
  await resetBatchStagesForExplicitRetry({ root, batchId: original.id, reason: `production_canary_replacement:${canary.runId}` });
  const batch = await mutateBatch(original.id, (item) => {
    item.workflowVersion = Math.max(1, Number(item.workflowVersion) || 1) + 1;
    item.targetOutputsPerBatch = canary.targetOutputsPerBatch;
    item.coveragePolicy = canary.coveragePolicy;
    item.status = "regroup_queued";
    item.progress = 24;
    item.error = undefined;
    item.renderingLabel = "生产 Canary：等待产品识别";
    item.execution = { state: "queued", stage: "analyze", reason: `production_canary_replacement:${canary.runId}`, updatedAt: at };
  });
  const batchDir = batchWorkspacePath(root, batch);
  await mkdir(batchDir, { recursive: true });
  await writeJsonAtomic(path.join(batchDir, "reference-profile.json"), batch.referenceProfile);
  await writeJsonAtomic(path.join(batchDir, "service-stage.json"), { schemaVersion: 1, next: "analyze", operation: "regroup", workflowVersion: batch.workflowVersion, queuedAt: at, canaryRunId: canary.runId });
  await enqueueStage({ root, batchId: batch.id, stage: "analyze", operation: "regroup", priority: batch.priority, workflowVersion: batch.workflowVersion, reason: `production_canary_replacement:${canary.runId}`, taskNumber: taskNumberForBatch(batch) });
  prepared.push({ id: batch.id, taskNumber: taskNumberForBatch(batch), name: batch.name, workflowVersion: batch.workflowVersion });
}

const excluded = canary.batchIds.map((batchId) => ({ batchId, at, reason: "coverage_mismatch_six_renderable_variants_for_target_five" }));
const next = {
  ...canary,
  batchIds: replacementIds,
  prepared,
  excludedBatches: [...(Array.isArray(canary.excludedBatches) ? canary.excludedBatches : []), ...excluded],
  replacementEvents: [...(Array.isArray(canary.replacementEvents) ? canary.replacementEvents : []), { at, excluded, prepared }],
};
await writeJsonAtomic(stateFile, next);
await writeJsonAtomic(path.join(canary.evidenceDir, `replacement-${at.replaceAll(":", "-").replaceAll(".", "-")}.json`), { at, excluded, prepared });
process.stdout.write(`${JSON.stringify({ runId: canary.runId, at, excluded, prepared }, null, 2)}\n`);
