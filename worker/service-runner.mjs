import path from "node:path";
import { access, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  assertLease,
  claimStage,
  completeStage,
  deferStage,
  enqueueStage,
  heartbeatLease,
  manualStageForBatch,
  promoteRetries,
  retryStage,
} from "./service-queue.mjs";
import {
  analyzeReference,
  detectProducts,
  readBatches,
  runAnalyzeQuality,
  runBatchEdit,
  runRenderBatch,
  runRevision,
  update,
  isCanceled,
  setFailureContext,
  setLeaseGuard,
} from "./processor.mjs";
import {
  MAX_RECOVERY_ATTEMPTS,
  acquireCodexExecution,
  classifyRecoveryError,
  codexInactivityManualMessage,
  heartbeatCodexExecution,
  isCodexServiceTask,
  markFatalFailure,
  markManualRequired,
  markRecoveryRetryReady,
  markRecoverySucceeded,
  readRecoveryState,
  recoveryAttemptLimit,
  releaseCodexExecution,
  retryDelayFor,
  scheduleRecovery,
  tripCodexConcurrencyCircuit,
} from "./recovery.mjs";
import { readJson, writeJsonAtomic } from "../lib/atomic-json.mjs";
import { recordBatchFailure } from "./failure-diagnostics.mjs";
import { batchWorkspacePath } from "../lib/tenant-paths.mjs";
import { taskMatchesBatchVersion, taskMayOperate, workflowVersionOf } from "./task-fence.mjs";

const ROOT = process.cwd();
const SERVICE = process.argv.find((arg) => arg.startsWith("--service="))?.slice("--service=".length) || process.env.CUTFLOW_SERVICE || "analyze";
const SERVICE_STAGES = { analyze: "analyze", clip: "clip", render: "render" };
const STAGE = SERVICE_STAGES[SERVICE];
const WORKER_ID = process.argv.find((arg) => arg.startsWith("--instance="))?.slice("--instance=".length) || process.env.CUTFLOW_SERVICE_INSTANCE || `${SERVICE}-${process.pid}`;
const ONCE = process.argv.includes("--once");
const IDLE_MS = Math.max(500, Number(process.env.CUTFLOW_SERVICE_POLL_MS) || 1500);
const LEASE_MS = Math.max(30_000, Number(process.env.CUTFLOW_SERVICE_LEASE_MS) || 120_000);
const HEARTBEAT_MS = Math.min(30_000, Math.max(5_000, Math.floor(LEASE_MS / 3)));
const DERIVED_ACTIVE_BATCH_STATUSES = new Set([
  "reference_queued", "analyzing_reference", "creating_proxies", "detecting_products",
  "regroup_queued", "batch_queued", "editing", "revision_queued", "revising",
]);

if (!STAGE) throw new Error(`Unsupported service: ${SERVICE}`);

const stageFile = (batch) => path.join(batchWorkspacePath(ROOT, batch), "service-stage.json");
const cancelFile = (batch) => path.join(batchWorkspacePath(ROOT, batch), "cancel.request");
const heartbeatFile = path.join(ROOT, "data", "service-heartbeats", `${SERVICE}-${WORKER_ID}.json`);

async function fileExists(file) {
  try { await access(file); return true; } catch { return false; }
}

async function writeServiceHeartbeat() {
  await mkdir(path.dirname(heartbeatFile), { recursive: true });
  await writeFile(heartbeatFile, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, service: SERVICE, workerId: WORKER_ID }), "utf8");
}

async function markStage(root, batch, next, operation) {
  await writeJsonAtomic(stageFile(batch), { schemaVersion: 1, next, operation, workflowVersion: workflowVersionOf(batch), updatedAt: new Date().toISOString() });
}

async function taskStillCurrent(task) {
  const batch = await loadBatch(task.batchId);
  if (!batch) return false;
  const marker = await readJson(stageFile(batch), null);
  return taskMayOperate(task, batch, marker);
}

function taskMayFinalize(task, batch, marker) {
  if (!taskMatchesBatchVersion(task, batch)) return false;
  if (taskMayOperate(task, batch, marker)) return true;
  const finishedStates = {
    reference: ["reference_ready", "batch_queued"],
    regroup: ["reference_ready", "batch_queued"],
    quality: ["editing"],
    edit: ["editing"],
    revision: ["revising"],
    render: ["review", "failed"],
  };
  return Boolean(finishedStates[task.operation]?.includes(batch.status));
}

async function taskCanFinalize(task) {
  const batch = await loadBatch(task.batchId);
  if (!batch) return false;
  const marker = await readJson(stageFile(batch), null);
  return taskMayFinalize(task, batch, marker);
}

async function syncDerivedTasks() {
  const batches = await readBatches();
  for (const batch of batches) {
    if (await fileExists(cancelFile(batch))) continue;
    const version = workflowVersionOf(batch);
    const manualTask = await manualStageForBatch({ root: ROOT, batchId: batch.id, workflowVersion: version });
    if (manualTask) {
      // A lease can expire while the child process is partitioned rather than
      // crashed. The queue has already exhausted its bounded retry policy;
      // mirror that terminal state to the Batch before any derived-task scan.
      if (DERIVED_ACTIVE_BATCH_STATUSES.has(batch.status)) {
        await update(batch.id, (item) => {
          item.status = "failed";
          item.error = item.error || `自动恢复连续失败 ${manualTask.attempt} 次：${manualTask.reason || "服务租约已过期"}`;
          item.renderingLabel = "等待人工处理";
          item.lastWorkerActivityAt = new Date().toISOString();
        });
      }
      continue;
    }
    if (STAGE === "analyze") {
      if (["reference_queued", "analyzing_reference", "creating_proxies", "detecting_products"].includes(batch.status)) {
        await enqueueStage({ root: ROOT, batchId: batch.id, stage: "analyze", operation: "reference", priority: batch.priority, workflowVersion: version });
      } else if (batch.status === "regroup_queued") {
        await enqueueStage({ root: ROOT, batchId: batch.id, stage: "analyze", operation: "regroup", priority: batch.priority, workflowVersion: version });
      } else if (batch.status === "batch_queued") {
        await enqueueStage({ root: ROOT, batchId: batch.id, stage: "analyze", operation: "quality", priority: batch.priority, workflowVersion: version });
      }
    }
    if (STAGE === "clip") {
      if (batch.status === "revision_queued") {
        await enqueueStage({ root: ROOT, batchId: batch.id, stage: "clip", operation: "revision", priority: batch.priority, workflowVersion: version });
      }
      const marker = await readJson(stageFile(batch), null);
      if (batch.status === "editing" && marker?.next === "clip" && marker.operation === "edit" && (!marker.workflowVersion || workflowVersionOf(marker) === version)) {
        await enqueueStage({ root: ROOT, batchId: batch.id, stage: "clip", operation: "edit", priority: batch.priority, workflowVersion: version });
      }
    }
    if (STAGE === "render") {
      const marker = await readJson(stageFile(batch), null);
      if (["editing", "revising"].includes(batch.status) && marker?.next === "render" && ["render", "revision"].includes(marker.operation) && (!marker.workflowVersion || workflowVersionOf(marker) === version)) {
        await enqueueStage({ root: ROOT, batchId: batch.id, stage: "render", operation: "render", priority: batch.priority, workflowVersion: version });
      }
    }
  }
}

async function loadBatch(batchId) {
  return (await readBatches()).find((batch) => batch.id === batchId) || null;
}

async function runTask(task) {
  const batch = await loadBatch(task.batchId);
  if (!batch) throw new Error(`Batch not found: ${task.batchId}`);
  if (await isCanceled(batch.id)) return { canceled: true };
  if (!(await assertLease({ root: ROOT, task }))) return { lost: true };
  const marker = await readJson(stageFile(batch), null);
  // Queue records carry a Batch workflow version. A stale task is completed
  // without calling Codex or writing Batch state.
  if (!taskMayOperate(task, batch, marker)) return { completed: true, skipped: true };
  if (task.stage === "analyze" && ["reference", "regroup"].includes(task.operation)) {
    const account = await readJson(path.join(ROOT, "data", "codex-account-state.json"), null);
    if (account?.ready !== true) throw new Error("Codex disconnect");
  }
  let codexSucceeded = false;
  if (isCodexServiceTask(task.stage, task.operation)) {
    const execution = await acquireCodexExecution({ root: ROOT, task, service: SERVICE, workerId: WORKER_ID });
    if (execution.state === "waiting") {
      await update(batch.id, (item) => {
        item.error = undefined;
        item.renderingLabel = `Codex 账户并发保护中，将在 ${new Date(execution.retryAt).toLocaleTimeString("zh-CN", { hour12: false })} 重试`;
        item.lastWorkerActivityAt = new Date().toISOString();
      });
      return { deferred: true, retryAt: execution.retryAt, reason: execution.message };
    }
    if (execution.state === "manual") {
      const error = new Error(execution.message);
      error.code = "CODEX_CIRCUIT_MANUAL";
      throw error;
    }
    task.codexSlot = execution.slot;
  }

  try {
    let outcome;
    if (task.operation === "reference") outcome = await analyzeReference(batch);
    else if (task.operation === "regroup") outcome = await detectProducts(batch, null, batch.groupCommands?.at(-1)?.text || "");
    else if (task.operation === "quality") outcome = await runAnalyzeQuality(batch);
    else if (task.operation === "edit") outcome = await runBatchEdit(batch, { includeAnalyze: false, render: false });
    else if (task.operation === "revision") outcome = await runRevision(batch, { render: false });
    else if (task.operation === "render") outcome = await runRenderBatch(batch);
    else throw new Error(`Unsupported ${task.stage} operation: ${task.operation}`);
    codexSucceeded = Boolean(task.codexSlot);

    if (!(await assertLease({ root: ROOT, task })) || !(await taskCanFinalize(task))) return { lost: true };
    if (outcome?.skipped) return { completed: true, skipped: true };
    // Artifact analysis failure is a manual-quality state, not a worker failure.
    // Do not advance it to clip/render or send it into recovery retries.
    if (outcome?.artifactReviewRequired) return { completed: true, artifactReviewRequired: true };
    if (task.stage === "analyze" && task.operation === "quality") {
      await markStage(ROOT, batch, "clip", "edit");
      await enqueueStage({ root: ROOT, batchId: batch.id, stage: "clip", operation: "edit", priority: task.priority, workflowVersion: workflowVersionOf(batch) });
    } else if (task.stage === "clip" && ["edit", "revision"].includes(task.operation)) {
      if (outcome?.renderReady !== true) {
        const error = new Error("Edit Plan Not Ready: clip stage completed without a render-ready edit plan.");
        error.code = "EDIT_PLAN_NOT_READY";
        throw error;
      }
      await markStage(ROOT, batch, "render", "render");
      await enqueueStage({ root: ROOT, batchId: batch.id, stage: "render", operation: "render", priority: task.priority, workflowVersion: workflowVersionOf(batch) });
    } else if (task.stage === "render") {
      await markStage(ROOT, batch, null, "render");
    }
    return { completed: true };
  } finally {
    if (task.codexSlot) {
      await releaseCodexExecution({ root: ROOT, slot: task.codexSlot, succeeded: codexSucceeded }).catch(() => undefined);
      delete task.codexSlot;
    }
  }
}

async function handleFailure(task, error) {
  const message = error instanceof Error ? error.message : String(error);
  const classification = classifyRecoveryError(error);
  let codexCircuit = null;
  await recordBatchFailure({
    root: ROOT,
    batchId: task.batchId,
    service: SERVICE,
    stage: task.operation ? `${task.stage}/${task.operation}` : task.stage,
    workerInstance: task.lease?.workerId || WORKER_ID,
    error,
    context: {
      operation: task.operation,
      attempt: Number(task.attempt || 0) + 1,
      leaseId: task.lease?.leaseId,
      recoverable: classification.recoverable,
      ...(error?.codexTurn ? { codexTurn: error.codexTurn } : {}),
      ...(error?.readiness ? { editPlanReadiness: error.readiness } : {}),
    },
  }).catch(() => undefined);

  // Lease loss is a normal ownership hand-off. Once a task is reclaimed, the
  // old service instance must not write Batch state or terminate the process.
  if (!(await assertLease({ root: ROOT, task }).catch(() => false)) || !(await taskStillCurrent(task).catch(() => false))) {
    console.warn(`[${SERVICE}/${WORKER_ID}] Lease lost while handling ${task.key}; waiting for the next task.`);
    return { state: "lost", lost: true };
  }
  if (classification.kind === "codex_concurrency") {
    codexCircuit = await tripCodexConcurrencyCircuit({ root: ROOT, message, task, service: SERVICE, workerId: WORKER_ID }).catch(() => null);
  }

  const writeBatchState = async (change) => {
    try {
      await update(task.batchId, change);
      return true;
    } catch (writeError) {
      if (/lease lost/i.test(String(writeError instanceof Error ? writeError.message : writeError))) {
        console.warn(`[${SERVICE}/${WORKER_ID}] Lease lost while recording ${task.key}; Batch write skipped.`);
      } else {
        console.error(`[${SERVICE}/${WORKER_ID}] Could not record failure for ${task.key}:`, writeError);
      }
      return false;
    }
  };

  const releaseAsManual = async (state, label, recoveryMarker) => {
    if (!(await writeBatchState((item) => { item.status = "failed"; item.error = message; item.renderingLabel = label; }))) return { state: "lost", lost: true };
    await recoveryMarker({ root: ROOT, batchId: task.batchId, stage: task.stage, message }).catch(() => undefined);
    return retryStage({ root: ROOT, task, reason: message, maxAttempts: 0 }).catch((queueError) => {
      console.error(`[${SERVICE}/${WORKER_ID}] Could not release ${task.key}:`, queueError);
      return { state };
    });
  };

  if (classification.category === "business") return releaseAsManual("manual", classification.kind === "edit_plan_not_ready" ? "Clip 未生成可渲染 EDL" : "等待人工处理", markManualRequired);
  if (classification.category === "fatal") return releaseAsManual("failed", "任务失败", markFatalFailure);
  if (classification.recoverable) {
    const attempt = Number(task.attempt || 0) + 1;
    const attemptLimit = recoveryAttemptLimit(classification);
    const inactivityTimeout = classification.kind === "codex_inactivity";
    const circuitManual = codexCircuit?.state === "manual";
    if (attempt >= attemptLimit || circuitManual) {
      if (!(await writeBatchState((item) => {
        item.status = "failed";
        item.error = `自动恢复连续失败 ${MAX_RECOVERY_ATTEMPTS} 次：${message}`;
        if (inactivityTimeout) item.error = codexInactivityManualMessage();
        item.recoveryAttempts = attempt;
        if (classification.kind === "codex_concurrency") item.error = `Codex 账户并发限制已连续触发 ${attemptLimit} 次：${message}`;
        if (circuitManual) item.error = "Codex 账户并发限制已连续触发 5 次，等待人工检查账户并发或配额。";
        item.renderingLabel = "等待人工处理";
        item.lastWorkerActivityAt = new Date().toISOString();
        if (inactivityTimeout) item.codexTurn = { ...item.codexTurn, state: "manual_required", turnId: undefined };
      }))) return { state: "lost", lost: true };
      await markManualRequired({ root: ROOT, batchId: task.batchId, stage: task.stage, message: inactivityTimeout ? codexInactivityManualMessage() : (circuitManual ? "Codex 账户并发限制已连续触发 5 次。" : message) }).catch(() => undefined);
    } else {
      await scheduleRecovery({ root: ROOT, batchId: task.batchId, attempt, stage: task.stage, classification, message }).catch(() => undefined);
      if (!(await writeBatchState((item) => {
        item.recoveryAttempts = attempt;
        item.error = undefined;
        item.renderingLabel = `自动恢复中：${classification.label}，第 ${attempt} 次尝试`;
        item.lastWorkerActivityAt = new Date().toISOString();
        if (inactivityTimeout) item.codexTurn = { ...item.codexTurn, state: "retrying", turnId: undefined };
      }))) return { state: "lost", lost: true };
    }
    return retryStage({ root: ROOT, task, reason: message, maxAttempts: circuitManual ? 0 : attemptLimit, delayMs: retryDelayFor(attempt, classification) }).catch((queueError) => {
      console.error(`[${SERVICE}/${WORKER_ID}] Could not retry ${task.key}:`, queueError);
      return { state: attempt >= attemptLimit || circuitManual ? "manual" : "retry", attempt };
    });
  }
  if (classification.category === "business") {
    await retryStage({ root: ROOT, task, reason: error instanceof Error ? error.message : String(error), maxAttempts: 0 });
    await markManualRequired({ root: ROOT, batchId: task.batchId, stage: task.stage, message: error instanceof Error ? error.message : String(error) });
    await update(task.batchId, (item) => { item.status = "failed"; item.error = error instanceof Error ? error.message : String(error); item.renderingLabel = "等待人工处理"; });
    return { state: "manual" };
  }
  if (classification.category === "fatal") {
    await retryStage({ root: ROOT, task, reason: error instanceof Error ? error.message : String(error), maxAttempts: 0 });
    await markFatalFailure({ root: ROOT, batchId: task.batchId, stage: task.stage, message: error instanceof Error ? error.message : String(error) });
    await update(task.batchId, (item) => { item.status = "failed"; item.error = error instanceof Error ? error.message : String(error); item.renderingLabel = "任务失败"; });
    return { state: "failed" };
  }
  if (classification.recoverable) {
    const result = await retryStage({ root: ROOT, task, reason: error instanceof Error ? error.message : String(error) });
    const attempt = result.attempt || task.attempt + 1;
    if (result.state === "manual") {
      await markManualRequired({ root: ROOT, batchId: task.batchId, stage: task.stage, message: error instanceof Error ? error.message : String(error) });
      await update(task.batchId, (item) => { item.status = "failed"; item.error = "自动恢复连续失败 3 次，请人工处理"; item.renderingLabel = "等待人工处理"; });
    } else {
      await scheduleRecovery({ root: ROOT, batchId: task.batchId, attempt, stage: task.stage, classification, message: error instanceof Error ? error.message : String(error) });
      await update(task.batchId, (item) => { item.error = undefined; item.renderingLabel = `自动恢复中：${classification.label}，第${attempt}次尝试`; });
    }
    return result;
  }
  await retryStage({ root: ROOT, task, reason: error instanceof Error ? error.message : String(error), maxAttempts: 0 });
  await markManualRequired({ root: ROOT, batchId: task.batchId, stage: task.stage, message: error instanceof Error ? error.message : String(error) });
  await update(task.batchId, (item) => { item.status = "failed"; item.error = error instanceof Error ? error.message : String(error); item.renderingLabel = "等待人工处理"; });
  return { state: "manual" };
}

async function markServiceRecoveryReady(task) {
  if (Number(task.attempt || 0) <= 0) return;
  const recovery = await readRecoveryState(ROOT, task.batchId);
  if (recovery.state !== "recovering") return;
  await markRecoveryRetryReady({ root: ROOT, batchId: task.batchId, stage: task.stage });
  await update(task.batchId, (item) => {
    item.renderingLabel = "恢复等待结束，正在重新执行当前阶段";
    item.lastWorkerActivityAt = new Date().toISOString();
  });
}

async function markServiceRecoverySucceeded(task) {
  if (Number(task.attempt || 0) <= 0) return;
  const recovery = await readRecoveryState(ROOT, task.batchId);
  if (recovery.state !== "retry_ready") return;
  await markRecoverySucceeded({ root: ROOT, batchId: task.batchId, stage: task.stage, evidence: "服务已成功完成当前阶段" });
  // Successful operations commonly move to a terminal/new stage before this
  // bookkeeping runs. Do not let a stale service write the old status back.
  if (!(await taskStillCurrent(task))) return;
  await update(task.batchId, (item) => {
    item.recoveryAttempts = 0;
    item.error = undefined;
    item.renderingLabel = "业务恢复成功，服务已完成当前阶段";
    item.lastWorkerActivityAt = new Date().toISOString();
  });
}

async function processOnce() {
  let task;
  try {
    await promoteRetries({ root: ROOT, stage: STAGE });
    await syncDerivedTasks();
    task = await claimStage({ root: ROOT, stage: STAGE, workerId: WORKER_ID, leaseMs: LEASE_MS });
  } catch (error) {
    console.error(`[${SERVICE}/${WORKER_ID}] Queue cycle failed; continuing to listen:`, error);
    return false;
  }
  if (!task) return false;
  const heartbeat = setInterval(() => {
    heartbeatLease({ root: ROOT, task, leaseMs: LEASE_MS }).catch(() => undefined);
    if (task.codexSlot) heartbeatCodexExecution({ root: ROOT, slot: task.codexSlot }).catch(() => undefined);
  }, HEARTBEAT_MS);
  setLeaseGuard(async () => (await assertLease({ root: ROOT, task })) && (await taskStillCurrent(task)));
  setFailureContext({
    service: SERVICE,
    workerInstance: task.lease?.workerId || WORKER_ID,
    context: { operation: task.operation, leaseId: task.lease?.leaseId },
  });
  try {
    await markServiceRecoveryReady(task);
    const result = await runTask(task);
    if (result.deferred) {
      await deferStage({ root: ROOT, task, reason: result.reason, notBefore: result.retryAt });
      return true;
    }
    if (result.canceled || result.lost) return true;
    // A completed business operation is valid evidence for recovery. Record it
    // before completing the stage, because completeStage intentionally clears
    // the lease and all Batch writes are lease guarded.
    await markServiceRecoverySucceeded(task);
    const completed = await completeStage({ root: ROOT, task });
    if (!completed) {
      console.warn(`[${SERVICE}/${WORKER_ID}] Lease lost before completing ${task.key}; waiting for the next task.`);
      return true;
    }
  } catch (error) {
    if (await isCanceled(task.batchId).catch(() => false)) return true;
    try {
      await handleFailure(task, error);
    } catch (failureError) {
      // Failure handling is itself isolated: no single Batch can ever take
      // down the long-running service process.
      console.error(`[${SERVICE}/${WORKER_ID}] Failure handler crashed for ${task.key}; continuing to listen:`, failureError);
    }
  } finally {
    setFailureContext(null);
    setLeaseGuard(null);
    clearInterval(heartbeat);
  }
  return true;
}

async function main() {
  await writeServiceHeartbeat();
  const timer = setInterval(() => writeServiceHeartbeat().catch(() => undefined), 5000);
  do {
    let worked = false;
    try {
      worked = await processOnce();
    } catch (error) {
      console.error(`[${SERVICE}/${WORKER_ID}] Unhandled service cycle error; continuing to listen:`, error);
    }
    if (ONCE) break;
    await new Promise((resolve) => setTimeout(resolve, worked ? 250 : IDLE_MS));
  } while (true);
  clearInterval(timer);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

export { main, processOnce, syncDerivedTasks };
