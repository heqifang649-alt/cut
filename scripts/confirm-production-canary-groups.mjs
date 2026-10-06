import path from "node:path";
import { readJson, writeJsonAtomic } from "../lib/atomic-json.mjs";
import { getBatch, mutateBatch } from "../lib/store.ts";
import { batchWorkspacePath } from "../lib/tenant-paths.mjs";
import { taskNumberForBatch } from "../lib/task-number.mjs";
import { buildProductGroupsArtifact } from "../lib/product-confirmation.mjs";
import { enqueueStage } from "../worker/service-queue.mjs";
import { countRenderableProducts } from "../lib/output-allocation.mjs";

const root = process.cwd();
const canary = await readJson(path.join(root, "data", "multi-batch-canary.json"), null);
if (canary?.status !== "running" || !Array.isArray(canary.batchIds)) throw new Error("No running production canary found.");
const confirmedAt = new Date().toISOString();
const confirmed = [];
for (const batchId of canary.batchIds) {
  const current = await getBatch(batchId);
  if (!current || current.status !== "reference_ready") throw new Error(`${batchId} is not ready for product confirmation.`);
  const detection = current.productDetection;
  if (!detection || detection.groupingMethod !== "filename" || Number(detection.confidence) !== 1) throw new Error(`${taskNumberForBatch(current)} is not deterministic filename grouping.`);
  if (!Array.isArray(detection.unassigned) || detection.unassigned.length) throw new Error(`${taskNumberForBatch(current)} still has unassigned product media.`);
  if (!Array.isArray(detection.groups) || !detection.groups.length) throw new Error(`${taskNumberForBatch(current)} has no product groups.`);
  if (current.coveragePolicy === "all_products_required" && Number(current.targetOutputsPerBatch) < countRenderableProducts(detection.groups)) {
    throw new Error(`${taskNumberForBatch(current)} target output count is lower than its renderable product count.`);
  }
  const expected = current.files.filter((file) => file.kind === "products").map((file) => file.relativePath).sort();
  const grouped = detection.groups.flatMap((group) => group.files || []).sort();
  if (new Set(grouped).size !== grouped.length || JSON.stringify(expected) !== JSON.stringify(grouped)) throw new Error(`${taskNumberForBatch(current)} product coverage is not exact.`);

  const sourceVersion = Number(current.workflowVersion) || 1;
  const batch = await mutateBatch(batchId, (item) => {
    item.productDetection = {
      ...item.productDetection,
      unassigned: [],
      excluded: [],
      humanConfirmation: { at: confirmedAt, by: "production-canary-operator", sourceVersion: sourceVersion + 1, assignments: [] },
    };
    item.workflowVersion = sourceVersion + 1;
    item.status = "batch_queued";
    item.progress = 35;
    item.error = undefined;
    item.execution = { state: "queued", stage: "analyze", updatedAt: confirmedAt };
  });
  await writeJsonAtomic(path.join(batchWorkspacePath(root, batch), "product-groups.json"), buildProductGroupsArtifact(batch.productDetection, batch.productDetection.groups, []));
  await enqueueStage({ root, batchId, stage: "analyze", operation: "quality", priority: batch.priority, workflowVersion: batch.workflowVersion, taskNumber: taskNumberForBatch(batch) });
  confirmed.push({ batchId, taskNumber: taskNumberForBatch(batch), workflowVersion: batch.workflowVersion, groups: batch.productDetection.groups.length, productFiles: grouped.length });
}
await writeJsonAtomic(path.join(canary.evidenceDir, `group-confirmation-${confirmedAt.replaceAll(":", "-").replaceAll(".", "-")}.json`), { confirmedAt, confirmed });
process.stdout.write(`${JSON.stringify({ runId: canary.runId, confirmedAt, confirmed }, null, 2)}\n`);
