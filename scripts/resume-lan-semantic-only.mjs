import path from "node:path";
import { readJson, writeJsonAtomic } from "../lib/atomic-json.mjs";
import { getBatch, mutateBatch } from "../lib/store.ts";
import { batchWorkspacePath } from "../lib/tenant-paths.mjs";
import { taskNumberForBatch } from "../lib/task-number.mjs";
import { loadShotPool } from "../worker/ai-ingest.mjs";
import { assertAutoOotdQuality } from "../worker/libtv-auto-quality.mjs";
import { runSemanticShadow } from "../worker/semantic-shadow.mjs";
import { enqueueStage, readQueue, resetBatchStagesForExplicitRetry } from "../worker/service-queue.mjs";

const root = process.cwd();
const batchId = process.argv.find((arg) => arg.startsWith("--batch="))?.slice(8);
const apply = process.argv.includes("--apply");
if (!batchId) throw new Error("--batch is required");
const batch = await getBatch(batchId);
if (!batch || batch.status !== "failed" || batch.error !== "New Scheduler requires semantic-evidence.v1.json") {
  throw new Error("Batch is not at the expected missing-Semantic checkpoint");
}
const canary = await readJson(path.join(root, "data", "multi-batch-canary.json"), null);
const allowed = canary?.batchIds || [];
if (canary?.status !== "running" || !allowed.includes(batchId) || allowed.length !== 2) throw new Error("Dual Canary scope is not active");
const queue = await readQueue(root);
if (queue.tasks.some((task) => task.batchId === batchId && ["queued", "leased", "retry_wait"].includes(task.status))) throw new Error("Target has live work");
const batchDir = batchWorkspacePath(root, batch);
const shotPool = await loadShotPool(batchId, batchDir);
await assertAutoOotdQuality({ root, batch, batchDir });
if (shotPool.shots.length !== 2) throw new Error("Expected two admitted READY shots");
const summary = { batchId, apply, shotIds: shotPool.shots.map((shot) => shot.id), workflowVersion: batch.workflowVersion };
if (!apply) { process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`); process.exit(0); }

const runtime = await readJson(path.join(root, "config", "cutflow-runtime.json"), null);
const productionPath = await readJson(path.join(root, "data", "production-path.json"), null);
for (const [key, value] of Object.entries(productionPath?.flags || {})) process.env[key] = String(value);
process.env.CUT_WORK_ROOT = runtime.workRoot;
const semantic = await runSemanticShadow({ root, batch, batchDir, shotPool, ffmpeg: runtime.ffmpegExecutable,
  onProgress: async (progress) => writeJsonAtomic(path.join(batchDir, "semantic-operator-progress.json"), progress) });
if (semantic?.continuation || semantic?.complete === false && semantic?.partial !== true) throw new Error("Semantic did not reach a schedulable checkpoint");
const evidence = await readJson(path.join(batchDir, "semantic-evidence.v1.json"), null);
if (!Array.isArray(evidence?.records) || evidence.records.length !== 2
    || evidence.records.some((record) => !["scored", "cache_hit", "evidence_reuse"].includes(record.status))) {
  throw new Error("Semantic Evidence is incomplete");
}
const at = new Date().toISOString();
await resetBatchStagesForExplicitRetry({ root, batchId, reason: "semantic_only_checkpoint_complete", allowedBatchIds: allowed });
const recovered = await mutateBatch(batchId, (item) => {
  if (item.status !== "failed" || Number(item.workflowVersion) !== Number(batch.workflowVersion)) throw new Error("Batch changed during Semantic");
  item.status = "editing";
  item.progress = 45;
  item.error = undefined;
  item.bridgeErrorCode = undefined;
  item.renderingLabel = "Semantic 已完成：从 Scheduler checkpoint 接续";
  item.execution = { state: "queued", stage: "clip", reason: "semantic_only_checkpoint_complete", updatedAt: at };
}, { allowedBatchIds: allowed });
await writeJsonAtomic(path.join(batchDir, "service-stage.json"), { schemaVersion: 1, next: "clip", operation: "edit",
  workflowVersion: recovered.workflowVersion, queuedAt: at, resumeReason: "semantic_only_checkpoint_complete" });
const task = await enqueueStage({ root, batchId, stage: "clip", operation: "edit", priority: recovered.priority,
  workflowVersion: recovered.workflowVersion, reason: "semantic_only_checkpoint_complete", taskNumber: taskNumberForBatch(recovered), allowedBatchIds: allowed });
process.stdout.write(`${JSON.stringify({ ...summary, apply: true, semanticStatus: evidence.status, records: evidence.records.map((r) => ({ shotId: r.shotId, status: r.status, usage: r.telemetry?.usage })), task }, null, 2)}\n`);
