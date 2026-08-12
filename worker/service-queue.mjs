import path from "node:path";
import { mkdir } from "node:fs/promises";
import { readJson, withFileLock, writeJsonAtomic } from "../lib/atomic-json.mjs";

export const SERVICE_STAGES = ["analyze", "clip", "render"];
export const QUEUE_PRIORITIES = ["HIGH", "NORMAL", "LOW"];

const PRIORITY_WEIGHT = { HIGH: 0, NORMAL: 1, LOW: 2 };
const RETRY_DELAYS_MS = [5_000, 15_000, 30_000];
const DEFAULT_MAX_ATTEMPTS = 3;

const queuePath = (root) => path.join(root, "data", "service-queue.json");
const freshQueue = () => ({ schemaVersion: 1, tasks: [] });
const taskKey = (batchId, stage, operation = "default") => `${batchId}:${stage}:${operation}`;
const now = () => new Date().toISOString();
const latestTaskForKey = (tasks, key) => tasks.findLast((task) => task.key === key);

function normalizePriority(priority) {
  return QUEUE_PRIORITIES.includes(priority) ? priority : "NORMAL";
}

function ordered(tasks) {
  return tasks.sort((a, b) => {
    const priority = PRIORITY_WEIGHT[a.priority] - PRIORITY_WEIGHT[b.priority];
    if (priority) return priority;
    return a.enqueuedAt.localeCompare(b.enqueuedAt);
  });
}

async function mutate(root, change) {
  const file = queuePath(root);
  await mkdir(path.dirname(file), { recursive: true });
  return withFileLock(file, async () => {
    const queue = await readJson(file, freshQueue());
    queue.tasks ??= [];
    const result = await change(queue);
    queue.updatedAt = now();
    await writeJsonAtomic(file, queue);
    return result;
  });
}

export async function enqueueStage({ root, batchId, stage, operation = "default", priority = "NORMAL", reason, notBefore, workflowVersion }) {
  if (!SERVICE_STAGES.includes(stage)) throw new TypeError(`Unsupported service stage: ${stage}`);
  return mutate(root, (queue) => {
    const key = taskKey(batchId, stage, operation);
    // A manual task is terminal until an explicit human recovery action
    // changes it. Periodic state discovery must never silently reset its
    // attempt counter by inserting a second task with the same key.
    let existing = latestTaskForKey(queue.tasks, key);
    if (existing && ["completed", "canceled"].includes(existing.status)) {
      // Keep completed/canceled records as audit history; they must never
      // become the live task selected by subsequent lease operations.
      existing = undefined;
    }
    if (existing) {
      // A user-created workflow version is a fencing token. Do not let an old
      // reference/clip task survive into a new attempt for the same Batch.
      if (Number.isSafeInteger(Number(workflowVersion)) && Number(workflowVersion) > 0 && Number(existing.workflowVersion || 1) !== Number(workflowVersion)) {
        existing.status = "canceled";
        existing.canceledAt = now();
        existing.reason = "Superseded by newer Batch workflow version";
        existing.lease = undefined;
      } else {
        existing.priority = normalizePriority(priority);
        existing.reason = reason || existing.reason;
        // A periodic stage scan may rediscover a Batch while it is waiting for
        // its bounded recovery delay. Preserve retry state and notBefore so the
        // scan cannot bypass backoff or starve other queued Batches.
        if (existing.status !== "retry") existing.notBefore = notBefore || existing.notBefore;
        return { ...existing };
      }
    }
    const task = {
      key,
      batchId,
      stage,
      operation,
      priority: normalizePriority(priority),
      status: "queued",
      attempt: 0,
      enqueuedAt: now(),
      notBefore: notBefore || undefined,
      reason: reason || undefined,
      workflowVersion: Number.isSafeInteger(Number(workflowVersion)) && Number(workflowVersion) > 0 ? Number(workflowVersion) : 1,
      lease: undefined,
    };
    queue.tasks.push(task);
    return { ...task };
  });
}

export async function cancelBatchStages({ root, batchId }) {
  return mutate(root, (queue) => {
    const changed = [];
    for (const task of queue.tasks.filter((item) => item.batchId === batchId && !["completed", "manual", "canceled"].includes(item.status))) {
      task.status = "canceled";
      task.canceledAt = now();
      task.lease = undefined;
      changed.push({ ...task });
    }
    return changed;
  });
}

// A user may explicitly restart a task that reached a terminal manual state
// after correcting its prerequisites. This is deliberately separate from
// enqueueStage: periodic discovery must never reopen a manual task on its own.
export async function resetBatchStagesForExplicitRetry({ root, batchId, reason = "explicit_manual_retry" }) {
  return mutate(root, (queue) => {
    const changed = [];
    for (const task of queue.tasks.filter((item) => item.batchId === batchId && !["completed", "canceled"].includes(item.status))) {
      task.status = "canceled";
      task.canceledAt = now();
      task.reason = reason;
      task.notBefore = undefined;
      task.lease = undefined;
      changed.push({ ...task });
    }
    return changed;
  });
}

export async function cancelStage({ root, batchId, stage, operation }) {
  if (!SERVICE_STAGES.includes(stage)) throw new TypeError(`Unsupported service stage: ${stage}`);
  return mutate(root, (queue) => {
    const changed = [];
    for (const task of queue.tasks.filter((item) => item.batchId === batchId && item.stage === stage && (!operation || item.operation === operation) && !["completed", "manual", "canceled"].includes(item.status))) {
      task.status = "canceled";
      task.canceledAt = now();
      task.lease = undefined;
      changed.push({ ...task });
    }
    return changed;
  });
}

export async function manualStageForBatch({ root, batchId, workflowVersion }) {
  const queue = await readJson(queuePath(root), freshQueue());
  return queue.tasks.find((task) => task.batchId === batchId && task.status === "manual" && (workflowVersion === undefined || Number(task.workflowVersion || 1) === Number(workflowVersion))) || null;
}

export async function claimStage({ root, stage, workerId, leaseMs = 90_000 }) {
  if (!SERVICE_STAGES.includes(stage)) throw new TypeError(`Unsupported service stage: ${stage}`);
  return mutate(root, (queue) => {
    const currentTime = Date.now();
    for (const task of queue.tasks) {
      if (task.status === "leased" && task.lease && new Date(task.lease.expiresAt).getTime() <= currentTime) {
        // Never hand an expired lease straight to another worker. The first
        // worker may still be alive but partitioned; an immediate re-claim can
        // start a duplicate Codex turn or render. Put it through the same
        // bounded retry path and let lease fencing reject stale writes.
        const attempt = Number(task.attempt || 0) + 1;
        task.attempt = attempt;
        task.reason = "Worker lease expired before completion";
        task.lease = undefined;
        task.leaseExpiredAt = now();
        if (attempt >= DEFAULT_MAX_ATTEMPTS) {
          task.status = "manual";
          task.manualAt = now();
          task.notBefore = undefined;
        } else {
          task.status = "retry";
          task.notBefore = new Date(currentTime + RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)]).toISOString();
          task.retryAt = now();
        }
      }
    }
    // A worker instance owns at most one live lease. This protects the queue
    // when a supervisor restart, duplicate launcher, or overlapping poll
    // cycle races inside the same worker id.
    const workerBusy = queue.tasks.some((item) =>
      item.status === "leased" &&
      item.lease?.workerId === workerId &&
      new Date(item.lease.expiresAt).getTime() > currentTime,
    );
    if (workerBusy) return null;
    const task = ordered(queue.tasks.filter((item) => item.stage === stage && item.status === "queued" && (!item.notBefore || new Date(item.notBefore).getTime() <= currentTime)))[0];
    if (!task) return null;
    const version = Number(task.leaseVersion || 0) + 1;
    task.leaseVersion = version;
    task.status = "leased";
    task.startedAt ??= now();
    task.lease = {
      leaseId: crypto.randomUUID(),
      version,
      workerId,
      claimedAt: now(),
      heartbeatAt: now(),
      expiresAt: new Date(currentTime + leaseMs).toISOString(),
    };
    return structuredClone(task);
  });
}

export async function heartbeatLease({ root, task, leaseMs = 90_000 }) {
  return mutate(root, (queue) => {
    const current = latestTaskForKey(queue.tasks, task.key);
    if (!current || current.status !== "leased" || current.lease?.leaseId !== task.lease?.leaseId || current.lease?.version !== task.lease?.version) return false;
    current.lease.heartbeatAt = now();
    current.lease.expiresAt = new Date(Date.now() + leaseMs).toISOString();
    return true;
  });
}

export async function assertLease({ root, task }) {
  return mutate(root, (queue) => {
    const current = latestTaskForKey(queue.tasks, task.key);
    return Boolean(current && current.status === "leased" && current.lease?.leaseId === task.lease?.leaseId && current.lease?.version === task.lease?.version && new Date(current.lease.expiresAt).getTime() > Date.now());
  });
}

export async function completeStage({ root, task }) {
  return mutate(root, (queue) => {
    const current = latestTaskForKey(queue.tasks, task.key);
    if (!current || current.status !== "leased" || current.lease?.leaseId !== task.lease?.leaseId || current.lease?.version !== task.lease?.version) return false;
    current.status = "completed";
    current.completedAt = now();
    current.lease = undefined;
    return true;
  });
}

export async function retryStage({ root, task, reason, maxAttempts = DEFAULT_MAX_ATTEMPTS, delayMs }) {
  return mutate(root, (queue) => {
    const current = latestTaskForKey(queue.tasks, task.key);
    if (!current || current.status !== "leased" || current.lease?.leaseId !== task.lease?.leaseId || current.lease?.version !== task.lease?.version) return { state: "lost" };
    const attempt = Number(current.attempt || 0) + 1;
    current.attempt = attempt;
    current.reason = reason;
    current.lease = undefined;
    if (attempt >= maxAttempts) {
      current.status = "manual";
      current.manualAt = now();
      return { state: "manual", attempt };
    }
    current.status = "retry";
    const selectedDelay = Number.isFinite(Number(delayMs))
      ? Math.max(0, Number(delayMs))
      : RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)];
    current.notBefore = new Date(Date.now() + selectedDelay).toISOString();
    current.retryAt = now();
    return { state: "retry", attempt, notBefore: current.notBefore };
  });
}

// A global dependency can be temporarily unavailable even though this Batch
// did nothing wrong. Return the lease without incrementing its own retry
// counter so an account-level backoff cannot exhaust every queued Batch.
export async function deferStage({ root, task, reason, notBefore }) {
  if (!notBefore || !Number.isFinite(new Date(notBefore).getTime())) throw new TypeError("notBefore is required for deferred work");
  return mutate(root, (queue) => {
    const current = latestTaskForKey(queue.tasks, task.key);
    if (!current || current.status !== "leased" || current.lease?.leaseId !== task.lease?.leaseId || current.lease?.version !== task.lease?.version) return { state: "lost" };
    current.status = "retry";
    current.reason = reason;
    current.notBefore = notBefore;
    current.deferredAt = now();
    current.lease = undefined;
    return { state: "retry", attempt: Number(current.attempt || 0), notBefore };
  });
}

// A process can disappear before its task-level error handler runs. Do not
// leave that lease to be reclaimed forever: convert the abandoned work into
// the same bounded retry/manual state used for ordinary task failures.
export async function releaseWorkerLeases({ root, workerId, reason, maxAttempts = DEFAULT_MAX_ATTEMPTS }) {
  if (typeof workerId !== "string" || !workerId) throw new TypeError("workerId is required");
  return mutate(root, (queue) => {
    const released = [];
    for (const task of queue.tasks.filter((item) => item.status === "leased" && item.lease?.workerId === workerId)) {
      const attempt = Number(task.attempt || 0) + 1;
      task.attempt = attempt;
      task.reason = reason;
      task.lease = undefined;
      if (attempt >= maxAttempts) {
        task.status = "manual";
        task.manualAt = now();
        task.notBefore = undefined;
        released.push({ task: structuredClone(task), state: "manual", attempt });
        continue;
      }
      task.status = "retry";
      task.notBefore = new Date(Date.now() + RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)]).toISOString();
      task.retryAt = now();
      released.push({ task: structuredClone(task), state: "retry", attempt, notBefore: task.notBefore });
    }
    return released;
  });
}

export async function promoteRetries({ root, stage }) {
  return mutate(root, (queue) => {
    const currentTime = Date.now();
    let promoted = 0;
    for (const task of queue.tasks) {
      if (task.stage === stage && task.status === "retry" && (!task.notBefore || new Date(task.notBefore).getTime() <= currentTime)) {
        task.status = "queued";
        promoted += 1;
      }
    }
    return promoted;
  });
}

export async function queueOverview(root, allowedBatchIds) {
  const queue = await readJson(queuePath(root), freshQueue());
  const allowed = allowedBatchIds ? new Set(allowedBatchIds) : null;
  const result = Object.fromEntries(SERVICE_STAGES.map((stage) => [stage, { waiting: 0, running: 0, failed: 0, retry: 0, etaSeconds: null }]));
  const currentTime = Date.now();
  for (const task of queue.tasks || []) {
    if (allowed && !allowed.has(task.batchId)) continue;
    const stage = result[task.stage];
    if (!stage) continue;
    if (task.status === "queued") stage.waiting += 1;
    if (task.status === "leased") stage.running += 1;
    if (task.status === "retry") stage.retry += 1;
    if (task.status === "manual") stage.failed += 1;
  }
  for (const stage of Object.values(result)) {
    const averageSeconds = 90;
    stage.etaSeconds = stage.waiting ? Math.max(averageSeconds, stage.waiting * averageSeconds) : 0;
  }
  return { generatedAt: new Date(currentTime).toISOString(), stages: result };
}
