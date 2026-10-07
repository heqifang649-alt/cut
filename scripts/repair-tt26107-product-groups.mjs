// One-time, evidence-reviewed correction for TT26.10.7-1. Dry-run by default.
// The source detection and this correction remain in the Batch audit record.
import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { getBatch, mutateBatch } from "../lib/store.ts";
import { readQueue, enqueueStage } from "../worker/service-queue.mjs";
import { preflightRuntime } from "../worker/runtime-preflight.mjs";
import { batchWorkspacePath, resolveBatchFile } from "../lib/tenant-paths.mjs";
import { writeJsonAtomic } from "../lib/atomic-json.mjs";
import { buildProductGroupsArtifact } from "../lib/product-confirmation.mjs";
import { countRenderableProducts, resolveOutputAllocation, setTargetToDetectedProductCount } from "../lib/output-allocation.mjs";
import { taskNumberForBatch } from "../lib/task-number.mjs";

const root = process.cwd();
const batchId = "38413c0e-6fe9-46ba-ad2e-b6dec5c5aeb7";
const apply = process.argv.includes("--apply");
if (process.argv.slice(2).some(arg => !["--apply"].includes(arg))) throw new Error("Only --apply is supported");
const current = await getBatch(batchId);
if (!current || current.status !== "reference_ready" || current.workflowVersion !== 2 || current.productDetection?.humanConfirmation) throw new Error("Batch is not at the expected review boundary");
const detection = current.productDetection;
if (detection?.groupingMethod !== "visual" || detection.groups?.length !== 6 || JSON.stringify(detection.unassigned) !== JSON.stringify(["3.6.mp4"])) throw new Error("Source detection changed; do not apply stale correction");
const expected = [
  ["P001", ["1.1.mp4", "1.2.mp4", "1.3.mp4"], ["1 (1).jpeg", "1 (2).jpeg"]],
  ["P002", ["2.1.mp4", "2.2.mp4"], ["2 (1).jpg", "2 (2).jpg"]],
  ["P003", ["3.1.mp4", "3.2.mp4", "3.3.mp4", "3.4.mp4", "3.5.mp4", "3.6.mp4", "3.7.mp4"], ["3 (2).jpeg", "3.jpeg"]],
  ["P004", ["4.1.mp4", "4.2.mp4", "4.3.mp4", "4.4.mp4", "4.5.mp4"], ["4 (1).jpeg", "4 (2).jpeg"]],
  ["P005", ["5.1 (2).mp4", "5.1 (3).mp4", "5.1 (4).mp4", "5.1.mp4", "5.2 (2).mp4", "5.2 (3).mp4", "5.2 (4).mp4", "5.2 (5).mp4", "5.2 (6).mp4", "5.2 (7).mp4", "5.2 (8).mp4", "5.2.mp4"], ["5 (1).jpeg", "5 (2).jpeg"]],
];
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const original = detection.groups;
for (const [id, files] of [["P001", expected[0][1]], ["P002", expected[1][1]], ["P005", expected[3][1]], ["P006", expected[4][1]]]) {
  if (!same(original.find(group => group.id === id)?.files || [], files)) throw new Error(`Original group ${id} changed`);
}
if (!same([...original.find(group => group.id === "P003")?.files || [], ...original.find(group => group.id === "P004")?.files || [], ...detection.unassigned], expected[2][1])) throw new Error("Pink-cardigan source membership changed");
const allVideoNames = current.files.filter(file => file.kind === "products").map(file => file.relativePath);
const allReferenceNames = current.files.filter(file => file.kind === "product_refs").map(file => file.relativePath);
if (!same(expected.flatMap(([, files]) => files), allVideoNames) || !same(expected.flatMap(([, , refs]) => refs), allReferenceNames)) throw new Error("Correction does not cover every video and reference exactly once");
for (const file of current.files.filter(file => ["products", "product_refs"].includes(file.kind))) {
  if (!existsSync(resolveBatchFile(root, current, file))) throw new Error(`Source missing: ${file.relativePath}`);
}
const queue = await readQueue(root);
if (queue.tasks.some(task => task.batchId === batchId && ["queued", "leased", "retry"].includes(task.status))) throw new Error("Batch has an active queue task");
const groups = expected.map(([id, files, refs], index) => {
  const source = original.find(group => group.id === (["P001", "P002", "P003", "P005", "P006"][index]));
  return {
    ...source,
    id,
    files,
    productReferenceFiles: refs,
    ...(id === "P003" ? {
      label: "粉色山水图案 V 领开衫",
      signature: "粉色 V 领四颗棕色纽扣开衫，左前片山峰与蓝色波浪，右前片彩色浪花；背面同款山水图案。",
      notes: "负责人逐帧核对 3.1–3.7.mp4：七段均为同款开衫；3.6.mp4 展示背面。3.jpeg 为正面，3 (2).jpeg 为背面。原 P003/P004 是误拆；原记录提到的 3.2.jpeg 并不存在。",
      confidence: Math.min(original.find(group => group.id === "P003").confidence, original.find(group => group.id === "P004").confidence),
    } : {}),
  };
});
const now = new Date().toISOString();
const corrected = {
  ...detection,
  groups,
  unassigned: [],
  excluded: [],
  summary: "逐帧及真实参考图核对：29 段视频归属 5 款产品，每款目标 1 条。粉色开衫误拆合并，3.6.mp4 归入该款。",
  operatorCorrection: {
    at: now,
    by: "platform-owner-visual-evidence-review",
    reason: "模型将同一粉色开衫误拆并漏归背面片段，且引用不存在的商品图；按原片和真实正背面图纠正。",
    originalGroups: original,
    originalUnassigned: detection.unassigned,
    evidence: {
      sourceFolder: "\\\\192.168.120.60\\新成片交付\\批量剪辑素材\\TT\\9.18",
      reviewedFrameDirectory: "E:\\cutflow批量\\worker-scratch\\review-38413c0e-3x",
      reviewedVideoFrames: ["3.1.mp4", "3.2.mp4", "3.3.mp4", "3.4.mp4", "3.5.mp4", "3.6.mp4", "3.7.mp4"],
      reviewedReferences: ["3.jpeg", "3 (2).jpeg"],
    },
  },
  humanConfirmation: { at: now, by: "platform-owner-visual-evidence-review", sourceVersion: 3, assignments: [{ file: "3.6.mp4", groupId: "P003" }] },
};
const { batch: targetBatch, adjustment } = setTargetToDetectedProductCount(current, countRenderableProducts(groups));
resolveOutputAllocation(targetBatch, groups.map(group => ({ product_id: group.id, product: group })));
if (targetBatch.targetOutputsPerBatch !== 5) throw new Error("Corrected target is not 5");
if (adjustment) corrected.targetOutputAdjustment = { ...adjustment, at: now };
const report = { batchId, taskNumber: taskNumberForBatch(current), dryRun: !apply, at: now, originalGroupCount: original.length, correctedGroupCount: groups.length, videoCount: allVideoNames.length, referenceCount: allReferenceNames.length, targetFrom: current.targetOutputsPerBatch, targetTo: targetBatch.targetOutputsPerBatch };
if (!apply) { process.stdout.write(`${JSON.stringify(report, null, 2)}\n`); process.exit(0); }
await preflightRuntime({ root, capability: "render" });
const evidenceDir = path.join(root, ".project-governance", "evidence", "product-group-correction");
await mkdir(evidenceDir, { recursive: true });
await writeJsonAtomic(path.join(evidenceDir, `${batchId}.json`), { ...report, dryRun: false, correction: corrected.operatorCorrection, groups });
const batch = await mutateBatch(batchId, item => {
  if (item.status !== "reference_ready" || item.workflowVersion !== 2 || item.productDetection?.humanConfirmation) throw new Error("Batch changed during correction");
  item.productDetection = corrected;
  item.targetOutputsPerBatch = targetBatch.targetOutputsPerBatch;
  item.workflowVersion = 3;
  item.status = "batch_queued";
  item.progress = 35;
  item.error = undefined;
  item.execution = { state: "queued", stage: "analyze", updatedAt: now };
});
await writeJsonAtomic(path.join(batchWorkspacePath(root, batch), "product-groups.json"), buildProductGroupsArtifact(corrected, groups, []));
await enqueueStage({ root, batchId, stage: "analyze", operation: "quality", priority: batch.priority, workflowVersion: batch.workflowVersion, taskNumber: taskNumberForBatch(batch) });
process.stdout.write(`${JSON.stringify({ ...report, dryRun: false, status: batch.status, workflowVersion: batch.workflowVersion }, null, 2)}\n`);
