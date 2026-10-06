import path from "node:path";
import { readJson, writeJsonAtomic } from "../lib/atomic-json.mjs";
import { getBatch, mutateBatch } from "../lib/store.ts";
import { batchWorkspacePath } from "../lib/tenant-paths.mjs";
import { taskNumberForBatch } from "../lib/task-number.mjs";
import { enqueueStage, readQueue, resetBatchStagesForExplicitRetry } from "../worker/service-queue.mjs";

const root = process.cwd();
const id = process.argv.find((arg) => arg.startsWith("--batch="))?.slice(8);
const apply = process.argv.includes("--apply");
if (!id) throw new Error("--batch is required");
const canary = await readJson(path.join(root, "data", "multi-batch-canary.json"), null);
if (canary?.status !== "running" || !canary.batchIds?.includes(id)) throw new Error("Batch is outside the running Canary scope");
const batch = await getBatch(id);
if (batch?.status !== "failed" || !/SEMANTIC_INCOMPLETE/.test(batch.error || "")) throw new Error("Batch is not a failed semantic analysis");
const queue = await readQueue(root);
const active = queue.tasks.filter((task) => task.batchId === id && ["queued", "leased"].includes(task.status));
const manual = queue.tasks.find((task) => task.batchId === id && task.operation === "quality" && task.status === "manual" && Number(task.workflowVersion) === Number(batch.workflowVersion));
if (active.length || !manual) throw new Error("Queue state is not a single terminal quality task");
const dir = batchWorkspacePath(root, batch);
const attempts = await readJson(path.join(dir, "semantic-attempts.v1.json"), null);
const performance = await readJson(path.join(dir, "semantic-performance.v1.json"), null);
const segmentFile = path.join(dir, "semantic-segment.v1.json");
const segment = await readJson(segmentFile, null);
const failed = attempts?.records?.filter((record) => record.status === "error") || [];
if (!segment?.identity || segment.waitingForContinuation || !failed.length || performance?.summary?.totalShots !== attempts.records.length) throw new Error("Semantic checkpoint is not recoverable");
const evaluationCounts = failed.map((record) => ({ shotId: record.shotId, code: record.error?.code, count: performance.evaluations.filter((item) => item.shotId === record.shotId && item.cacheKey === record.cacheKey).length }));
if (evaluationCounts.some((item) => !["SEMANTIC_SHOT_BUDGET_EXCEEDED", "PROVIDER_TIMEOUT"].includes(item.code) || item.count < 1 || item.count >= 3)) throw new Error("At least one Shot exhausted its bounded retry allowance");
const summary = { batchId: id, workflowVersion: batch.workflowVersion, completed: performance.summary.successfulShots, total: attempts.records.length, segment: segment.segment, failedShots: evaluationCounts, dryRun: !apply };
if (!apply) { process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`); process.exit(0); }

const reason = "semantic_late_transient_recovery";
const at = new Date().toISOString();
await writeJsonAtomic(path.join(dir, `semantic-late-shot-recovery-v${batch.workflowVersion}.json`), { ...summary, dryRun: false, reason, at });
await writeJsonAtomic(segmentFile, { ...segment, waitingForContinuation: true, updatedAt: at, recoveryReason: reason });
await resetBatchStagesForExplicitRetry({ root, batchId: id, reason });
const recovered = await mutateBatch(id, (item) => {
  if (item.status !== "failed" || Number(item.workflowVersion) !== Number(batch.workflowVersion)) throw new Error("Batch changed during recovery");
  item.status = "batch_queued";
  item.progress = 40;
  item.error = undefined;
  item.renderingLabel = "语义分析按 Shot 续跑，已完成评分保持复用";
  item.execution = { state: "queued", stage: "analyze", reason, updatedAt: at };
});
await enqueueStage({ root, batchId: id, stage: "analyze", operation: "quality", priority: recovered.priority, workflowVersion: recovered.workflowVersion, taskNumber: taskNumberForBatch(recovered), reason });
process.stdout.write(`${JSON.stringify({ ...summary, dryRun: false, queuedAt: at }, null, 2)}\n`);
