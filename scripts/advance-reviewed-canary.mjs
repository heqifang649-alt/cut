import path from "node:path";
import { mkdir } from "node:fs/promises";
import { readJson, withFileLock, writeJsonAtomic } from "../lib/atomic-json.mjs";
import { resolveProviderConfig } from "../lib/ai-provider-config.mjs";
import { readProviderHealth } from "../lib/provider-incident.mjs";

const root = process.cwd();
const stateFile = path.join(root, "data", "multi-batch-canary.json");
const args = process.argv.slice(2);
const value = (name) => args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
const targetIds = args.filter((arg) => arg.startsWith("--batch=")).map((arg) => arg.slice(8));
const priorRunId = value("--prior-run-id");
const expectedModel = value("--expected-model");
const apply = args.includes("--apply");
if (value("--review-accepted") !== "yes" || !priorRunId || !expectedModel || targetIds.length !== 3 || new Set(targetIds).size !== 3) {
  throw new Error("Require --review-accepted=yes --prior-run-id=<id> --expected-model=<model> and exactly three distinct --batch=<id>");
}

const { config } = await resolveProviderConfig(root);
if (config.fastModel !== expectedModel || config.strongModel !== expectedModel) throw new Error("Approved Provider model changed");
const health = await readProviderHealth(config, expectedModel, { root });
if (health.status !== "RECOVERY_VERIFIED" || health.healthStatus !== "HEALTHY") throw new Error("Provider is not recovery-verified and healthy");

const transition = await withFileLock(stateFile, async () => {
  const prior = await readJson(stateFile, null);
  const fleet = await readJson(path.join(root, "data", "fleet-runtime.json"), null);
  const queue = await readJson(path.join(root, "data", "service-queue.json"), null);
  const governor = await readJson(path.join(root, "data", "resource-governor.json"), null);
  const batches = await readJson(path.join(root, "data", "batches.json"), []);
  const sameIds = (left, right) => Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((id) => right.includes(id));
  if (prior?.status !== "running" || prior.runId !== priorRunId || prior.fairSchedulerEnabled !== true || prior.batchIds?.length !== 3) throw new Error("Reviewed Canary state changed");
  if (fleet?.status !== "running" || fleet.claimsEnabled !== false || !sameIds(fleet.canaryBatchIds, prior.batchIds) || fleet.members?.length !== 12) throw new Error("Fleet is not isolated to the reviewed Canary");
  if (queue?.tasks?.some((task) => task.status === "leased") || Object.keys(governor?.render?.active || {}).length) throw new Error("Active work or render permit exists");
  const reviewed = prior.batchIds.map((id) => batches.find((batch) => batch.id === id));
  const requiredGates = ["productConsistency", "originalSpeed", "decodeCheck", "uniqueMusic"];
  if (reviewed.some((batch) => batch?.status !== "completed" || batch.execution?.state !== "review_ready"
    || batch.renderSummary?.renderedOutputs !== batch.renderSummary?.requestedOutputs
    || batch.renderSummary?.renderedOutputs !== batch.files?.filter((file) => file.kind === "output").length
    || batch.renderSummary?.productVisualReview?.status !== "passed"
    || requiredGates.some((gate) => batch.renderSummary?.qualityGates?.[gate] !== "passed"))) {
    throw new Error("Reviewed Canary Batch outputs or Quality Gates changed");
  }
  const targets = targetIds.map((id) => batches.find((batch) => batch.id === id));
  if (targets.some((batch) => !batch || prior.batchIds.includes(batch.id) || batch.ownerId !== reviewed[0].ownerId
    || batch.status !== "reference_queued" || batch.execution?.state !== "queued"
    || batch.coveragePolicy !== "all_products_required" || !batch.referenceProfile
    || !batch.files?.some((file) => file.kind === "products"))) throw new Error("Target Batch is not an untouched queued Batch in the same owner scope");
  if (targets.some((batch) => queue.tasks.filter((task) => task.batchId === batch.id && task.status === "queued"
    && task.stage === "analyze" && task.operation === "reference" && task.workflowVersion === batch.workflowVersion).length !== 1)) {
    throw new Error("Target Batch has no unique matching queued reference task");
  }
  const at = new Date().toISOString();
  const runId = `multi-batch-canary-${at.replaceAll(":", "-").replaceAll(".", "-")}`;
  const evidenceRoot = path.join(root, ".project-governance", "evidence", "multi-batch-canary");
  if (path.dirname(path.resolve(prior.evidenceDir || "")) !== evidenceRoot) throw new Error("Prior Canary evidence directory is outside the expected root");
  const evidenceDir = path.join(evidenceRoot, runId);
  const next = {
    schemaVersion: 1, runId, status: "running", startedAt: at, featureFlagDefaultChanged: false,
    fairSchedulerEnabled: true, batchIds: targetIds, targetPolicy: "detected_products",
    coveragePolicy: "all_products_required", evidenceDir, parentRunId: prior.runId,
    prepared: targets.map((batch) => ({ id: batch.id, taskNumber: batch.taskNumber, workflowVersion: batch.workflowVersion,
      targetOutputsPerBatch: batch.targetOutputsPerBatch, coveragePolicy: batch.coveragePolicy })),
  };
  if (apply) {
    await mkdir(evidenceDir, { recursive: true });
    await writeJsonAtomic(path.join(evidenceDir, "canary-start.json"), next);
    await writeJsonAtomic(path.join(prior.evidenceDir, "canary-reviewed.json"), {
      runId: prior.runId, reviewedAt: at, status: "human_review_accepted", batchIds: prior.batchIds,
      outputCounts: reviewed.map((batch) => ({ id: batch.id, renderedOutputs: batch.renderSummary.renderedOutputs })),
      nextRunId: runId,
    });
    await writeJsonAtomic(stateFile, next);
  }
  return { applied: apply, priorRunId: prior.runId, runId: apply ? runId : null, batchIds: targetIds,
    preservedOutsideQueue: queue.tasks.filter((task) => task.status === "queued" && !targetIds.includes(task.batchId)).map((task) => task.batchId) };
});
process.stdout.write(`${JSON.stringify(transition)}\n`);
