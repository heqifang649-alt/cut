import path from "node:path";
import { stat } from "node:fs/promises";
import { readJson, writeJsonAtomic } from "../lib/atomic-json.mjs";
import { getBatch, mutateBatch } from "../lib/store.ts";
import { batchWorkspacePath } from "../lib/tenant-paths.mjs";
import { taskNumberForBatch } from "../lib/task-number.mjs";
import { buildProductGroupsArtifact, validateConfirmation } from "../lib/product-confirmation.mjs";
import { countRenderableProducts, resolveOutputAllocation } from "../lib/output-allocation.mjs";
import { preflightRuntime } from "../worker/runtime-preflight.mjs";
import { enqueueStage } from "../worker/service-queue.mjs";
import { groupProductsByFilename } from "../worker/filename-product-grouper.mjs";

const root = process.cwd();
const args = process.argv.slice(2);
const value = (name) => args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
const batchId = value("--batch");
const expectedProducts = Number(value("--expected-products"));
const expectedSessions = Number(value("--expected-sessions"));
const expectedMethod = value("--expected-method");
const apply = args.includes("--apply");
if (value("--operator-reviewed") !== "yes" || !batchId || !["filename", "visual"].includes(expectedMethod)
  || !Number.isSafeInteger(expectedProducts) || !Number.isSafeInteger(expectedSessions)) {
  throw new Error("Require --operator-reviewed=yes --batch=<id> --expected-method=filename|visual --expected-products=<count> --expected-sessions=<count>");
}
const canary = await readJson(path.join(root, "data", "multi-batch-canary.json"), null);
const queue = await readJson(path.join(root, "data", "service-queue.json"), null);
if (canary?.status !== "running" || !canary.batchIds?.includes(batchId) || queue?.tasks?.some((task) => task.batchId === batchId && task.status === "leased")) {
  throw new Error("Batch is not idle in the active Canary");
}
const current = await getBatch(batchId);
const detection = current?.productDetection;
if (current?.status !== "reference_ready" || detection?.groupingMethod !== expectedMethod
  || detection.humanConfirmation || detection.unassigned?.length || detection.groups?.length !== expectedSessions
  || current.coveragePolicy !== "all_products_required" || current.targetOutputsPerBatch !== expectedProducts
  || countRenderableProducts(detection.groups) !== expectedProducts) throw new Error("Product confirmation contract changed");
if (detection.groups.some((group) => Number(group.confidence) < (expectedMethod === "visual" ? 0.95 : 1))) throw new Error("A product group is below the reviewed confidence floor");
const expectedFiles = current.files.filter((file) => file.kind === "products").map((file) => file.relativePath).sort();
const groupedFiles = detection.groups.flatMap((group) => group.files).sort();
if (new Set(groupedFiles).size !== groupedFiles.length || JSON.stringify(expectedFiles) !== JSON.stringify(groupedFiles)) throw new Error("Product file coverage is not exact");
validateConfirmation({ detection, assignments: [], currentVersion: current.workflowVersion, providedVersion: current.workflowVersion });
resolveOutputAllocation(current, detection.groups.map((group) => ({ product: group })));
if (expectedMethod === "filename") {
  const fresh = groupProductsByFilename(current.files.filter((file) => file.kind === "products"));
  if (fresh.groups.length !== expectedSessions || fresh.groups.some((group) => detection.groups.find((item) => item.id === group.id)?.productKey !== group.productKey)) {
    throw new Error("Filename Product keys changed since operator review");
  }
} else {
  const evidence = await readJson(path.join(batchWorkspacePath(root, current), "group-evidence.v1.json"), null);
  const hasProductReferences = current.files.some((file) => file.kind === "product_refs");
  if (evidence?.groups?.length !== expectedSessions || evidence.groups.some((group) => !group.video?.thumbnailPath || (hasProductReferences && !group.productImage?.thumbnailPath)
    || !detection.groups.some((item) => item.id === group.groupId))) throw new Error("Visual group evidence is incomplete");
  for (const group of evidence.groups) {
    if (!(await stat(group.video.thumbnailPath).catch(() => null))?.isFile()
      || (hasProductReferences && !(await stat(group.productImage.thumbnailPath).catch(() => null))?.isFile())) {
      throw new Error("Visual group evidence thumbnails are unavailable");
    }
  }
}
await preflightRuntime({ root, capability: "render" });
const result = { applied: apply, batchId, method: expectedMethod, products: expectedProducts, sessions: expectedSessions,
  groupIds: detection.groups.map((group) => group.id) };
if (apply) {
  const at = new Date().toISOString();
  const batch = await mutateBatch(batchId, (item) => {
    if (item.status !== "reference_ready" || item.workflowVersion !== current.workflowVersion || item.productDetection?.humanConfirmation) throw new Error("Batch changed before operator confirmation");
    item.productDetection = { ...item.productDetection, unassigned: [], excluded: [],
      humanConfirmation: { at, by: "production-canary-operator", sourceVersion: current.workflowVersion + 1, assignments: [] } };
    item.workflowVersion = current.workflowVersion + 1;
    item.status = "batch_queued";
    item.progress = 35;
    item.error = undefined;
    item.renderingLabel = "受控灰度：产品分组已核对，等待质量分析";
    item.execution = { state: "queued", stage: "analyze", reason: "canary_operator_group_review", updatedAt: at };
  });
  await writeJsonAtomic(path.join(batchWorkspacePath(root, batch), "product-groups.json"),
    buildProductGroupsArtifact(batch.productDetection, batch.productDetection.groups, []));
  await enqueueStage({ root, batchId, stage: "analyze", operation: "quality", priority: batch.priority,
    workflowVersion: batch.workflowVersion, taskNumber: taskNumberForBatch(batch), reason: "canary_operator_group_review" });
  await writeJsonAtomic(path.join(canary.evidenceDir, `group-review-${batchId}.json`), { ...result, at,
    workflowVersion: batch.workflowVersion, reviewType: "operator_visual_or_deterministic_review_not_independent_final_acceptance" });
}
process.stdout.write(`${JSON.stringify(result)}\n`);
