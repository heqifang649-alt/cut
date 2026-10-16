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

const reason = process.argv.find((arg) => arg.startsWith("--reason="))?.slice("--reason=".length) || "canary_operator_resume";
const resumedAt = new Date().toISOString();
const resumed = [];
for (const batchId of canary.batchIds) {
  const original = await getBatch(batchId);
  if (!original) throw new Error(`Canary Batch not found: ${batchId}`);
  await resetBatchStagesForExplicitRetry({ root, batchId, reason });
  const batch = await mutateBatch(batchId, (item) => {
    item.workflowVersion = Math.max(1, Number(item.workflowVersion) || 1) + 1;
    item.status = "regroup_queued";
    item.progress = 24;
    item.error = undefined;
    item.recoveryAttempts = 0;
    item.renderingLabel = "生产 Canary：从已缓存 Evidence 恢复产品识别";
    item.execution = { state: "queued", stage: "analyze", reason, updatedAt: resumedAt };
  });
  const batchDir = batchWorkspacePath(root, batch);
  await mkdir(batchDir, { recursive: true });
  await writeJsonAtomic(path.join(batchDir, "service-stage.json"), {
    schemaVersion: 1,
    next: "analyze",
    operation: "regroup",
    workflowVersion: batch.workflowVersion,
    queuedAt: resumedAt,
    canaryRunId: canary.runId,
    resumeReason: reason,
  });
  await enqueueStage({
    root,
    batchId,
    stage: "analyze",
    operation: "regroup",
    priority: batch.priority,
    workflowVersion: batch.workflowVersion,
    reason,
    taskNumber: taskNumberForBatch(batch),
  });
  resumed.push({ batchId, workflowVersion: batch.workflowVersion });
}

const next = {
  ...canary,
  resumeEvents: [...(Array.isArray(canary.resumeEvents) ? canary.resumeEvents : []), { at: resumedAt, reason, batches: resumed }],
};
await writeJsonAtomic(stateFile, next);
await writeJsonAtomic(path.join(canary.evidenceDir, `resume-${resumedAt.replaceAll(":", "-").replaceAll(".", "-")}.json`), { at: resumedAt, reason, resumed });
process.stdout.write(`${JSON.stringify({ runId: canary.runId, at: resumedAt, reason, resumed }, null, 2)}\n`);
