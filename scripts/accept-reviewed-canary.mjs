import path from "node:path";
import { stat } from "node:fs/promises";
import { readJson, writeJsonAtomic } from "../lib/atomic-json.mjs";
import { getBatch, mutateBatch } from "../lib/store.ts";
import { resolveBatchArtifactRecord } from "../lib/work-paths.mjs";
import { loadRuntimeConfig } from "../worker/runtime-config.mjs";
import { preflightRuntime } from "../worker/runtime-preflight.mjs";

const root = process.cwd();
const runtime = await loadRuntimeConfig(root);
const args = process.argv.slice(2);
const value = (name) => args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
const runId = value("--run-id");
const apply = args.includes("--apply");
if (value("--review-accepted") !== "yes" || !runId) {
  throw new Error("Require --review-accepted=yes --run-id=<active-run-id>");
}

const canary = await readJson(path.join(root, "data", "multi-batch-canary.json"), null);
const fleet = await readJson(path.join(root, "data", "fleet-runtime.json"), null);
const queue = await readJson(path.join(root, "data", "service-queue.json"), null);
const governor = await readJson(path.join(root, "data", "resource-governor.json"), null);
const ids = canary?.batchIds || [];
if (canary?.status !== "running" || canary.runId !== runId || ids.length !== 3 || new Set(ids).size !== 3
  || fleet?.status !== "running" || fleet.claimsEnabled !== false
  || ids.some((id) => !fleet.canaryBatchIds?.includes(id)) || fleet.canaryBatchIds.length !== ids.length
  || queue?.tasks?.some((task) => task.status === "leased")
  || Object.keys(governor?.render?.active || {}).length) throw new Error("Canary scope or no-active-work gate changed");
const evidenceRoot = path.join(root, ".project-governance", "evidence", "multi-batch-canary");
if (path.dirname(path.resolve(canary.evidenceDir || "")) !== evidenceRoot) throw new Error("Canary evidence directory is outside the expected root");
await preflightRuntime({ root, capability: "delivery", config: runtime });

const requiredGates = ["productConsistency", "originalSpeed", "decodeCheck", "uniqueMusic"];
const reviewed = [];
for (const id of ids) {
  const batch = await getBatch(id);
  const outputs = batch?.files?.filter((file) => file.kind === "output") || [];
  if (!batch || !["review", "completed"].includes(batch.status) || batch.execution?.state !== "review_ready"
    || batch.coveragePolicy !== "all_products_required" || outputs.length !== batch.targetOutputsPerBatch
    || outputs.length !== batch.renderSummary?.requestedOutputs || outputs.length !== batch.renderSummary?.renderedOutputs
    || batch.renderSummary?.productVisualReview?.status !== "passed" || batch.renderSummary?.excludedProducts?.some((item) => !String(item.reason || "").startsWith("alternate_model_session:"))
    || requiredGates.some((gate) => batch.renderSummary?.qualityGates?.[gate] !== "passed")
    || outputs.some((file) => file.qualityStatus !== "passed")
    || new Set(outputs.map((file) => file.productId)).size !== outputs.length) throw new Error(`Batch review gate changed: ${id}`);
  for (const file of outputs) {
    const info = await stat(resolveBatchArtifactRecord(root, batch, file.storagePath)).catch(() => null);
    if (!info?.isFile() || info.size !== file.size || info.size <= 500_000) throw new Error(`Output missing or changed: ${id}/${file.name}`);
  }
  reviewed.push({ id, taskNumber: batch.taskNumber, updatedAt: batch.updatedAt, outputs: outputs.map((file) => ({ id: file.id, productId: file.productId, name: file.name, size: file.size })) });
}

if (apply) {
  for (const item of reviewed) {
    await mutateBatch(item.id, (batch) => {
      if (batch.status === "completed" && ["pending", "copying", "delivered"].includes(batch.delivery?.status)) return;
      if (batch.status !== "review" || batch.updatedAt !== item.updatedAt || batch.execution?.state !== "review_ready") {
        throw new Error(`Batch changed before acceptance: ${item.id}`);
      }
      batch.status = "completed";
      batch.progress = 100;
      batch.error = undefined;
      batch.delivery = { status: "pending" };
    });
  }
  await writeJsonAtomic(path.join(canary.evidenceDir, "human-review-acceptance.json"), {
    runId, acceptedAt: new Date().toISOString(), source: "user_explicit_2026-10-07", batchIds: ids,
    reviewedOutputs: reviewed,
  });
}
process.stdout.write(`${JSON.stringify({ applied: apply, runId, batchIds: ids, outputCount: reviewed.reduce((count, item) => count + item.outputs.length, 0) })}\n`);
