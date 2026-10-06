import path from "node:path";
import { readJson, writeJsonAtomic } from "../lib/atomic-json.mjs";
import { getBatch, mutateBatch } from "../lib/store.ts";
import { batchWorkspacePath } from "../lib/tenant-paths.mjs";
import { alignTargetWithDetectedProducts, countRenderableProducts } from "../lib/output-allocation.mjs";
import { buildProductGroupsArtifact } from "../lib/product-confirmation.mjs";
import { groupProductsByFilename } from "../worker/filename-product-grouper.mjs";

const root = process.cwd();
const args = process.argv.slice(2);
const value = (name) => args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
const batchId = value("--batch");
const expectedProducts = Number(value("--expected-products"));
const expectedSessions = Number(value("--expected-sessions"));
const apply = args.includes("--apply");
if (!batchId || !Number.isSafeInteger(expectedProducts) || !Number.isSafeInteger(expectedSessions)) {
  throw new Error("Require --batch=<id> --expected-products=<count> --expected-sessions=<count>; --apply writes the guarded reconciliation");
}
const canary = await readJson(path.join(root, "data", "multi-batch-canary.json"), null);
const queue = await readJson(path.join(root, "data", "service-queue.json"), null);
if (canary?.status !== "running" || !canary.batchIds?.includes(batchId) || queue?.tasks?.some((task) => task.batchId === batchId && task.status === "leased")) {
  throw new Error("Batch is not an idle member of the current Canary");
}
const current = await getBatch(batchId);
if (current?.status !== "reference_ready" || current.productDetection?.groupingMethod !== "filename"
  || current.productDetection?.humanConfirmation || current.productDetection?.unassigned?.length) throw new Error("Batch is not awaiting deterministic filename-group confirmation");
const detected = current.productDetection;
const recalculated = groupProductsByFilename(current.files.filter((file) => file.kind === "products"));
if (detected.groups.length !== expectedSessions || recalculated.groups.length !== expectedSessions || recalculated.unassigned.length) throw new Error("Session coverage changed");
const byId = new Map(recalculated.groups.map((group) => [group.id, group]));
for (const group of detected.groups) {
  const fresh = byId.get(group.id);
  if (!fresh || JSON.stringify([...group.files].sort()) !== JSON.stringify([...fresh.files].sort())) throw new Error("Filename groups no longer match the detected file assignment");
}
const groups = detected.groups.map((group) => ({ ...group, productKey: byId.get(group.id).productKey }));
if (countRenderableProducts(groups) !== expectedProducts) throw new Error("Detected Product count does not match the reviewed expectation");
const aligned = alignTargetWithDetectedProducts(current, { ...detected, groups });
const result = { applied: apply, batchId, fromTarget: current.targetOutputsPerBatch,
  toTarget: aligned.batch.targetOutputsPerBatch, sessions: groups.length, products: expectedProducts,
  productKeys: groups.map((group) => ({ session: group.id, product: group.productKey })) };
if (apply) {
  const at = new Date().toISOString();
  const updated = await mutateBatch(batchId, (item) => {
    if (item.status !== "reference_ready" || item.workflowVersion !== current.workflowVersion || item.productDetection?.humanConfirmation) throw new Error("Batch changed before reconciliation");
    item.productDetection = aligned.detection;
    item.targetOutputsPerBatch = aligned.batch.targetOutputsPerBatch;
    item.workflowVersion = (Number(item.workflowVersion) || 1) + 1;
    item.renderingLabel = `已识别 ${expectedProducts} 款产品（${expectedSessions} 个模特 Session），等待分组确认`;
    item.updatedAt = at;
  });
  await writeJsonAtomic(path.join(batchWorkspacePath(root, updated), "product-groups.json"), buildProductGroupsArtifact(updated.productDetection, updated.productDetection.groups, []));
  await writeJsonAtomic(path.join(canary.evidenceDir, `product-key-reconciliation-${batchId}.json`), {
    ...result, at, workflowVersion: updated.workflowVersion,
    reviewNote: "TT5-M1 and TT5-M2 front frames show the same black-and-white Namaste jersey design; model Sessions remain isolated and only one Product output is allocated.",
  });
}
process.stdout.write(`${JSON.stringify(result)}\n`);
