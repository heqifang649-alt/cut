import path from "node:path";
import { mkdir } from "node:fs/promises";
import { readJson, writeJsonAtomic } from "../lib/atomic-json.mjs";

const ROOT = process.cwd();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HANDOFF = /^handoff-([0-9a-f-]{36})$/i;
const HASH = /^[0-9a-f]{64}$/i;
const TERMINAL_BATCH_STATUSES = new Set(["failed", "completed", "canceled"]);

function argument(name) {
  return process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function sameValues(left, right) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

const handoffId = argument("handoff");
const batchId = argument("batch");
const manifestSha256 = argument("manifest");
const expectedPriorBatchIds = process.argv
  .filter((item) => item.startsWith("--replace-batch="))
  .map((item) => item.slice("--replace-batch=".length));
const apply = process.argv.includes("--apply");

if (!HANDOFF.test(handoffId || "") || !UUID.test(HANDOFF.exec(handoffId)?.[1] || "")) {
  throw new Error("A valid --handoff is required");
}
if (!UUID.test(batchId || "")) throw new Error("A valid --batch is required");
if (!HASH.test(manifestSha256 || "")) throw new Error("A valid --manifest is required");
if (!expectedPriorBatchIds.length || expectedPriorBatchIds.some((id) => !UUID.test(id))) {
  throw new Error("At least one valid --replace-batch is required");
}

const [receipts, batches, queue, canary, fleet] = await Promise.all([
  readJson(path.join(ROOT, "data", "libtv-receipts.json"), []),
  readJson(path.join(ROOT, "data", "batches.json"), []),
  readJson(path.join(ROOT, "data", "service-queue.json"), { tasks: [] }),
  readJson(path.join(ROOT, "data", "multi-batch-canary.json"), null),
  readJson(path.join(ROOT, "data", "fleet-runtime.json"), null),
]);

const matchingReceipts = receipts.filter((item) => item.handoffId === handoffId);
if (matchingReceipts.length !== 1) throw new Error(`Expected one receipt, found ${matchingReceipts.length}`);
const receipt = matchingReceipts[0];
if (receipt.contractVersion !== "libtv-cut-lan/1" || receipt.manifestSha256 !== manifestSha256
    || receipt.batchId !== batchId || receipt.status !== "ready" || receipt.errorCode) {
  throw new Error("Receipt is not a ready, exact LAN import for the requested Batch");
}

const matchingBatches = batches.filter((item) => item.id === batchId
  || item.libtvSource?.handoffId === handoffId
  || item.libtvSource?.manifestSha256 === manifestSha256);
if (matchingBatches.length !== 1) throw new Error(`Expected one idempotent Batch mapping, found ${matchingBatches.length}`);
const batch = matchingBatches[0];
if (batch.id !== batchId || batch.libtvSource?.handoffId !== handoffId
    || batch.libtvSource?.manifestSha256 !== manifestSha256 || batch.status !== "batch_queued") {
  throw new Error("Imported Batch identity or pre-production state changed");
}

if (canary?.status !== "running" || !Array.isArray(canary.batchIds)
    || !sameValues(canary.batchIds, expectedPriorBatchIds)) {
  throw new Error("Active Canary scope changed from the expected prior Batch set");
}

const replacedBatches = expectedPriorBatchIds.map((id) => batches.find((item) => item.id === id));
if (replacedBatches.some((item) => !item || !TERMINAL_BATCH_STATUSES.has(item.status))) {
  throw new Error("Every replaced Canary Batch must be terminal");
}

const scopedIds = new Set([...expectedPriorBatchIds, batchId]);
const liveTasks = (queue.tasks || []).filter((task) => scopedIds.has(task.batchId)
  && task.status === "leased" && task.lease
  && new Date(task.lease.expiresAt).getTime() > Date.now());
if (liveTasks.length) throw new Error("A target or replaced Batch still has a live lease");

if (processIsAlive(Number(fleet?.pid))) {
  throw new Error(`Fleet supervisor ${fleet.pid} is still running; stop it before switching scope`);
}

const at = new Date().toISOString();
const runId = `simple-lan-${handoffId}-${at.replaceAll(":", "-").replaceAll(".", "-")}`;
const evidenceDir = path.join(ROOT, ".project-governance", "evidence", "multi-batch-canary", runId);
const next = {
  schemaVersion: 1,
  runId,
  status: "running",
  startedAt: at,
  featureFlagDefaultChanged: false,
  fairSchedulerEnabled: true,
  batchIds: [batchId],
  targetPolicy: "source_policy_single_source",
  coveragePolicy: "all_products_required",
  evidenceDir,
  prepared: [{ id: batchId, workflowVersion: Number(batch.workflowVersion || 1) }],
  replacedCanary: {
    runId: canary.runId,
    batchIds: [...canary.batchIds],
    reason: "superseded_lan_handoff",
  },
};

const result = {
  apply,
  handoffId,
  manifestSha256,
  batchId,
  priorRunId: canary.runId,
  priorBatchIds: [...canary.batchIds],
  nextRunId: runId,
  nextBatchIds: [batchId],
  liveLeaseCount: liveTasks.length,
  receiptStatus: receipt.status,
  batchStatus: batch.status,
};

if (apply) {
  await mkdir(evidenceDir, { recursive: true });
  await writeJsonAtomic(path.join(evidenceDir, "scope-switch-input.json"), {
    at,
    receipt,
    batch: {
      id: batch.id,
      status: batch.status,
      workflowVersion: batch.workflowVersion,
      ownerId: batch.ownerId,
      templateId: batch.templateId,
      libtvSource: batch.libtvSource,
    },
    priorCanary: canary,
    replacedBatches: replacedBatches.map((item) => ({ id: item.id, status: item.status, workflowVersion: item.workflowVersion })),
  });
  await writeJsonAtomic(path.join(ROOT, "data", "multi-batch-canary.json"), next);
  await writeJsonAtomic(path.join(evidenceDir, "canary-start.json"), next);
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
