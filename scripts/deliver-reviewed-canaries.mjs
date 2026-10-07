import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { readJson, writeJsonAtomic } from "../lib/atomic-json.mjs";
import { isPathInside, tenantDeliveryRoot } from "../lib/tenant-paths.mjs";
import { resolveBatchArtifactRecord } from "../lib/work-paths.mjs";
import { loadRuntimeConfig } from "../worker/runtime-config.mjs";
import { preflightRuntime } from "../worker/runtime-preflight.mjs";

const root = process.cwd();
const apply = process.argv.includes("--apply");
const runtime = await loadRuntimeConfig(root);
await preflightRuntime({ root, capability: "delivery", config: runtime });
const canary = await readJson(path.join(root, "data", "multi-batch-canary.json"), null);
const fleet = await readJson(path.join(root, "data", "fleet-runtime.json"), null);
const queue = await readJson(path.join(root, "data", "service-queue.json"), null);
const governor = await readJson(path.join(root, "data", "resource-governor.json"), null);
const batches = await readJson(path.join(root, "data", "batches.json"), []);
const deliveriesFile = path.join(root, "data", "deliveries.json");
const deliveries = await readJson(deliveriesFile, []);
const evidenceRoot = path.join(root, ".project-governance", "evidence", "multi-batch-canary");
if (canary?.status !== "running" || !canary.parentRunId || path.dirname(path.resolve(canary.evidenceDir || "")) !== evidenceRoot
  || fleet?.status !== "running" || fleet.claimsEnabled !== false
  || fleet.canaryBatchIds?.length !== canary.batchIds?.length
  || canary.batchIds.some((id) => !fleet.canaryBatchIds.includes(id))
  || queue?.tasks?.some((task) => task.status === "leased")
  || Object.keys(governor?.render?.active || {}).length) throw new Error("Canary or no-active-work gate changed");
const prior = await readJson(path.join(evidenceRoot, canary.parentRunId, "canary-reviewed.json"), null);
const current = await readJson(path.join(canary.evidenceDir, "human-review-acceptance.json"), null);
const sameIds = (left, right) => Array.isArray(left) && Array.isArray(right)
  && left.length === right.length && left.every((id) => right.includes(id));
if (prior?.status !== "human_review_accepted" || prior.runId !== canary.parentRunId
  || !sameIds(current?.batchIds, canary.batchIds) || current.runId !== canary.runId) throw new Error("Human review evidence is missing or changed");
const ids = [...prior.batchIds, ...current.batchIds];
if (ids.length !== 6 || new Set(ids).size !== ids.length) throw new Error("Expected exactly six distinct accepted Batches");
const pendingOutsideScope = batches.filter((batch) => batch.status === "completed"
  && !deliveries.some((entry) => entry.batchId === batch.id && entry.status === "completed") && !ids.includes(batch.id));
if (pendingOutsideScope.length) throw new Error("Another completed Batch is pending delivery; scoped operation requires isolation");
for (const id of ids) {
  const batch = batches.find((item) => item.id === id);
  const outputs = batch?.files?.filter((file) => file.kind === "output") || [];
  if (batch?.status !== "completed" || batch.execution?.state !== "review_ready" || !outputs.length
    || outputs.length !== batch.renderSummary?.renderedOutputs
    || outputs.some((file) => file.qualityStatus !== "passed")
    || Object.values(batch.renderSummary?.qualityGates || {}).some((value) => value !== "passed")) throw new Error(`Accepted Batch or Quality Gate changed: ${id}`);
}

const sha256 = async (file) => {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
};
const verified = [];
if (apply) {
  for (const id of ids) {
    const already = (await readJson(deliveriesFile, [])).some((entry) => entry.batchId === id && entry.status === "completed");
    if (!already) {
      execFileSync(runtime.nodeExecutable, [path.join(root, "worker", "delivery-watcher.mjs"), "--once", `--batch=${id}`], {
        cwd: root, env: { ...process.env, CUTFLOW_CLAIM_ENABLED: "true", NODE_OPTIONS: "--openssl-legacy-provider" },
        windowsHide: true, timeout: 300_000, stdio: "pipe",
      });
    }
    const entry = (await readJson(deliveriesFile, [])).find((item) => item.batchId === id && item.status === "completed");
    const batch = (await readJson(path.join(root, "data", "batches.json"), [])).find((item) => item.id === id);
    const deliveryBase = tenantDeliveryRoot(runtime.deliveryRoot, batch.ownerId);
    if (!entry || batch?.delivery?.status !== "delivered" || !isPathInside(deliveryBase, entry.deliveryPath)) {
      throw new Error(`Scoped delivery did not complete: ${id}`);
    }
    const files = [];
    for (const output of batch.files.filter((file) => file.kind === "output")) {
      const source = resolveBatchArtifactRecord(root, batch, output.storagePath);
      const target = path.join(entry.deliveryPath, path.basename(output.name));
      const info = await stat(target).catch(() => null);
      if (!info?.isFile() || info.size !== output.size || await sha256(source) !== await sha256(target)) {
        throw new Error(`Delivered output differs from approved render: ${id}/${output.name}`);
      }
      files.push({ name: output.name, size: output.size });
    }
    if (entry.files.length !== files.length) throw new Error(`Delivery file count differs: ${id}`);
    verified.push({ batchId: id, deliveryPath: entry.deliveryPath, files });
  }
  await writeJsonAtomic(path.join(canary.evidenceDir, "scoped-delivery-verification.json"), {
    currentRunId: canary.runId, priorRunId: canary.parentRunId, verifiedAt: new Date().toISOString(), batches: verified,
  });
}
process.stdout.write(`${JSON.stringify({ applied: apply, batchIds: ids, delivered: verified.length })}\n`);
