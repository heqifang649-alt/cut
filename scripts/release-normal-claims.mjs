import path from "node:path";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { readJson, withFileLock, writeJsonAtomic } from "../lib/atomic-json.mjs";
import { getBatch, mutateBatch } from "../lib/store.ts";
import { resolveBatchArtifactRecord } from "../lib/work-paths.mjs";
import { resolveProviderConfig } from "../lib/ai-provider-config.mjs";
import { readProviderHealth } from "../lib/provider-incident.mjs";
import { readQueue, holdQueuedStageForBatch } from "../worker/service-queue.mjs";
import { fleetRuntimeIsHealthy } from "../worker/fleet-availability.mjs";
import { loadRuntimeConfig } from "../worker/runtime-config.mjs";
import { preflightRuntime } from "../worker/runtime-preflight.mjs";

const root = process.cwd();
const historicalId = "b8662d6f-12e3-450d-bcc3-a606de4dffb3";
const targetId = process.argv.find(arg => arg.startsWith("--target="))?.slice(9);
const apply = process.argv.includes("--apply");
if (!targetId || targetId === historicalId) throw new Error("Specify the newly submitted --target=<batch-id>");
const canaryPath = path.join(root, "data", "multi-batch-canary.json");
const [canary, fleet, queue, governor, runtime, production, historical, target] = await Promise.all([
  readJson(canaryPath, null), readJson(path.join(root, "data", "fleet-runtime.json"), null), readQueue(root),
  readJson(path.join(root, "data", "resource-governor.json"), null), loadRuntimeConfig(root),
  readJson(path.join(root, "data", "production-path.json"), null), getBatch(historicalId), getBatch(targetId),
]);
const ids = canary?.batchIds || [];
if (canary?.status !== "running" || ids.length !== 3 || new Set(ids).size !== 3 || canary.fairSchedulerEnabled !== true
  || !fleetRuntimeIsHealthy(fleet) || fleet.claimsEnabled !== false || fleet.runtimeConfigHash !== runtime.runtimeConfigHash
  || fleet.canaryBatchIds?.length !== 3 || ids.some(id => !fleet.canaryBatchIds.includes(id))
  || queue.tasks.some(task => task.status === "leased") || Object.keys(governor?.render?.active || {}).length
  || production?.mode !== "hybrid" || production.controlA !== false) throw new Error("Frozen Canary, Fleet, runtime or no-active-work gate changed");
const evidenceRoot = path.join(root, ".project-governance", "evidence", "multi-batch-canary");
if (path.dirname(path.resolve(canary.evidenceDir || "")) !== evidenceRoot) throw new Error("Canary evidence path is outside the expected root");
const acceptance = await readJson(path.join(canary.evidenceDir, "human-review-acceptance.json"), null);
const deliveryEvidence = await readJson(path.join(canary.evidenceDir, "scoped-delivery-verification.json"), null);
if (acceptance?.runId !== canary.runId || acceptance.batchIds?.length !== 3 || ids.some(id => !acceptance.batchIds.includes(id))
  || deliveryEvidence?.currentRunId !== canary.runId) throw new Error("Independent review or scoped delivery evidence is missing");
const completed = await Promise.all(ids.map(getBatch));
const requiredGates = ["productConsistency", "originalSpeed", "decodeCheck", "uniqueMusic"];
if (completed.some(batch => !batch || batch.status !== "completed" || batch.delivery?.status !== "delivered"
  || batch.execution?.state !== "review_ready" || batch.renderSummary?.productVisualReview?.status !== "passed"
  || batch.renderSummary.renderedOutputs !== batch.renderSummary.requestedOutputs
  || batch.files.filter(file => file.kind === "output").length !== batch.renderSummary.renderedOutputs
  || requiredGates.some(gate => batch.renderSummary.qualityGates?.[gate] !== "passed"))) throw new Error("Accepted Canary Batch state or quality evidence changed");
const queued = queue.tasks.filter(task => task.status === "queued");
const oldTask = queued.find(task => task.batchId === historicalId);
const newTask = queued.find(task => task.batchId === targetId);
if (queued.length !== 2 || !oldTask || !newTask || oldTask.stage !== "analyze" || oldTask.operation !== "quality"
  || oldTask.workflowVersion !== historical?.workflowVersion || historical?.status !== "editing"
  || newTask.stage !== "analyze" || newTask.operation !== "reference" || newTask.workflowVersion !== target?.workflowVersion
  || target?.status !== "reference_queued" || target.execution?.state !== "queued" || !target.files?.some(file => file.kind === "products")
  || !completed.every(batch => batch.ownerId === target.ownerId)) throw new Error("Queued task scope changed; refusing global claim release");
const { config } = await resolveProviderConfig(root);
const providerHealth = await readProviderHealth(config, config.strongModel, { root });
if (!config.fastModel || config.fastModel !== config.strongModel || production.modelStrong !== config.strongModel
  || providerHealth.status !== "RECOVERY_VERIFIED" || providerHealth.healthStatus !== "HEALTHY") throw new Error("Production Provider/model is not recovery-verified");
for (const capability of ["web", "analyze", "clip", "render", "delivery"]) await preflightRuntime({ root, capability, config: runtime });
const web = await fetch("http://127.0.0.1:3001/", { signal: AbortSignal.timeout(10_000) });
if (!web.ok) throw new Error(`Web gate failed: ${web.status}`);

async function sha256(file) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}
let verifiedOutputs = 0;
for (const batch of completed) {
  const delivered = deliveryEvidence.batches?.find(item => item.batchId === batch.id);
  if (!delivered || delivered.files?.length !== batch.renderSummary.renderedOutputs || delivered.deliveryPath !== batch.delivery.path) throw new Error(`Delivery manifest changed: ${batch.id}`);
  for (const file of batch.files.filter(item => item.kind === "output")) {
    const source = resolveBatchArtifactRecord(root, batch, file.storagePath);
    const destination = path.join(delivered.deliveryPath, file.name);
    const [sourceStat, deliveredStat] = await Promise.all([stat(source), stat(destination)]);
    if (!sourceStat.isFile() || !deliveredStat.isFile() || sourceStat.size !== deliveredStat.size || sourceStat.size !== file.size
      || (await sha256(source)) !== (await sha256(destination))) throw new Error(`Delivered file mismatch: ${batch.id}/${file.name}`);
    verifiedOutputs++;
  }
}
const plan = { targetId, historicalId, canaryRunId: canary.runId, acceptedBatches: completed.length,
  hashVerifiedOutputs: verifiedOutputs, providerModel: config.strongModel, runtimeRevision: runtime.runtimeRevision,
  action: "manual-hold historical task, close completed Canary, then restart Fleet with normal claims; Quality Gate unchanged" };
if (!apply) { process.stdout.write(`${JSON.stringify({ applied: false, ...plan })}\n`); process.exit(0); }

const at = new Date().toISOString();
await holdQueuedStageForBatch({ root, batchId: historicalId, stage: "analyze", operation: "quality", workflowVersion: historical.workflowVersion,
  reason: "HISTORICAL_OPERATOR_HOLD_NORMAL_CLAIMS_RELEASE" });
await mutateBatch(historicalId, batch => {
  if (batch.status !== "editing" || batch.workflowVersion !== historical.workflowVersion) throw new Error("Historical Batch changed during hold");
  batch.execution = { state: "manual_hold", stage: "analyze", reason: "HISTORICAL_OPERATOR_HOLD_NORMAL_CLAIMS_RELEASE", updatedAt: at };
  batch.renderingLabel = "历史任务已人工隔离，不会随正常提交自动续跑；须明确恢复后才可继续";
  batch.lastWorkerActivityAt = at;
});
const updatedQueue = await readQueue(root);
if (updatedQueue.tasks.filter(task => task.status === "queued").length !== 1
  || updatedQueue.tasks.find(task => task.batchId === targetId && task.status === "queued")?.key !== newTask.key) throw new Error("Post-hold queue changed; Canary remains isolated");
await withFileLock(canaryPath, async () => {
  const current = await readJson(canaryPath, null);
  if (current?.runId !== canary.runId || current.status !== "running") throw new Error("Canary changed before closure");
  const release = { schemaVersion: 1, at, ...plan, releaseMode: "normal_claims_guarded", guardedProductAutoConfirm: false };
  await writeJsonAtomic(path.join(canary.evidenceDir, "normal-claims-release.json"), release);
  await writeJsonAtomic(canaryPath, { ...current, status: "completed", endedAt: at, terminalReason: "human_accepted_and_delivered_normal_claims_release", normalClaimsRelease: path.join(canary.evidenceDir, "normal-claims-release.json") });
});
process.stdout.write(`${JSON.stringify({ applied: true, ...plan, restartRequired: true })}\n`);
