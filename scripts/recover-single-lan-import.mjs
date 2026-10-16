import path from "node:path";
import { mkdir } from "node:fs/promises";
import { readJson, writeJsonAtomic } from "../lib/atomic-json.mjs";
import { getBatch, mutateBatch } from "../lib/store.ts";
import { batchWorkspacePath } from "../lib/tenant-paths.mjs";
import { taskNumberForBatch } from "../lib/task-number.mjs";
import { enqueueStage, resetBatchStagesForExplicitRetry } from "../worker/service-queue.mjs";

const root = process.cwd();
const args = process.argv.slice(2);
const value = (name) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const batchId = value("batch");
const handoffId = value("handoff");
const manifestSha256 = value("manifest");
const apply = args.includes("--apply");
if (!batchId || !handoffId || !manifestSha256) {
  throw new Error("Require --batch=<uuid> --handoff=<handoff-id> --manifest=<sha256>; add --apply to repair and resume");
}

const batches = await readJson(path.join(root, "data", "batches.json"), []);
const receipts = await readJson(path.join(root, "data", "libtv-receipts.json"), []);
const queue = await readJson(path.join(root, "data", "service-queue.json"), { tasks: [] });
const canary = await readJson(path.join(root, "data", "multi-batch-canary.json"), null);
const fleet = await readJson(path.join(root, "data", "fleet-runtime.json"), null);
const matches = batches.filter((item) => item.id === batchId || item.libtvSource?.handoffId === handoffId
  || item.libtvSource?.manifestSha256 === manifestSha256);
if (matches.length !== 1 || matches[0].id !== batchId) throw new Error("Expected exactly one matching Batch");
const batch = matches[0];
const receiptMatches = receipts.filter((item) => item.handoffId === handoffId || item.batchId === batchId
  || item.manifestSha256 === manifestSha256);
if (receiptMatches.length !== 1) throw new Error("Expected exactly one matching receipt");
const receipt = receiptMatches[0];
if (receipt.batchId !== batchId || receipt.manifestSha256 !== manifestSha256 || receipt.status !== "ready") {
  throw new Error("Receipt identity or ready state does not match");
}
if (batch.libtvSource?.handoffId !== handoffId || batch.libtvSource?.manifestSha256 !== manifestSha256) {
  throw new Error("Batch LAN provenance does not match");
}
if (batch.productDetection?.sourcePolicy?.confirmation !== "source_policy"
    || batch.productDetection.sourcePolicy.handoffId !== handoffId
    || batch.productDetection.sourcePolicy.manifestSha256 !== manifestSha256
    || !Array.isArray(batch.productDetection.groups) || batch.productDetection.groups.length !== 1) {
  throw new Error("Confirmed source-policy product grouping is missing or inconsistent");
}
if (!batch.referenceProfile || !batch.templateId) throw new Error("Reference profile or template is missing");
const templates = await readJson(path.join(root, "data", "templates.json"), []);
const template = templates.find((item) => item.id === batch.templateId && item.ownerId === batch.ownerId
  && item.status === "ready" && item.profile);
if (!template || JSON.stringify(template.profile) !== JSON.stringify(batch.referenceProfile)) {
  throw new Error("Ready template profile does not match the Batch");
}
if (canary?.status !== "running" || JSON.stringify(canary.batchIds) !== JSON.stringify([batchId])) {
  throw new Error("Control Canary is not scoped only to the target Batch");
}
if (fleet?.status !== "running" || fleet.claimsEnabled !== false
    || JSON.stringify(fleet.canaryBatchIds) !== JSON.stringify([batchId])) {
  throw new Error("Fleet is not running in global NoClaim with the target-only Canary scope");
}
const targetTasks = (queue.tasks || []).filter((item) => item.batchId === batchId);
const live = targetTasks.filter((item) => !["completed", "manual", "canceled"].includes(item.status));
if (live.length) throw new Error("Target Batch still has a live queue task");
if ((queue.tasks || []).some((item) => item.batchId !== batchId && item.lease)) {
  throw new Error("A non-target Batch has a live lease");
}
const manualClip = targetTasks.filter((item) => item.stage === "clip" && item.operation === "edit" && item.status === "manual");
if (manualClip.length !== 1 || manualClip[0].reason !== "New Scheduler requires confirmed product-groups.json") {
  throw new Error("Expected the single known missing-artifact Clip failure");
}

const batchDir = batchWorkspacePath(root, batch);
const report = {
  batchId,
  handoffId,
  manifestSha256,
  apply,
  canaryRunId: canary.runId,
  completedQualityTasks: targetTasks.filter((item) => item.stage === "analyze" && item.status === "completed").length,
  manualClipTasks: manualClip.length,
};
if (!apply) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(0);
}

const at = new Date().toISOString();
await mkdir(batchDir, { recursive: true });
await writeJsonAtomic(path.join(batchDir, "reference-profile.json"), batch.referenceProfile);
await writeJsonAtomic(path.join(batchDir, "product-groups.json"), {
  ...batch.productDetection,
  policyVersion: batch.productDetection.sourcePolicy.version,
});
await resetBatchStagesForExplicitRetry({
  root,
  batchId,
  reason: "lan_import_artifact_repair",
  allowedBatchIds: [batchId],
});
const resumed = await mutateBatch(batchId, (item) => {
  item.status = "editing";
  item.progress = Math.max(45, Number(item.progress) || 0);
  item.error = undefined;
  item.renderingLabel = "LAN 单批 Canary：从 Clip 断点恢复";
  item.execution = { state: "queued", stage: "clip", reason: "lan_import_artifact_repair", updatedAt: at };
}, { allowedBatchIds: [batchId] });
await writeJsonAtomic(path.join(batchDir, "service-stage.json"), {
  schemaVersion: 1,
  next: "clip",
  operation: "edit",
  workflowVersion: resumed.workflowVersion,
  queuedAt: at,
  canaryRunId: canary.runId,
  resumeReason: "lan_import_artifact_repair",
});
const task = await enqueueStage({
  root,
  batchId,
  stage: "clip",
  operation: "edit",
  priority: resumed.priority,
  workflowVersion: resumed.workflowVersion,
  reason: "lan_import_artifact_repair",
  taskNumber: taskNumberForBatch(resumed),
  allowedBatchIds: [batchId],
});
await writeJsonAtomic(path.join(canary.evidenceDir, `lan-import-recovery-${at.replaceAll(":", "-").replaceAll(".", "-")}.json`), {
  ...report,
  appliedAt: at,
  task,
});
process.stdout.write(`${JSON.stringify({ ...report, appliedAt: at, task }, null, 2)}\n`);
