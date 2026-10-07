import path from "node:path";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { readJson, withFileLock, writeJsonAtomic } from "../lib/atomic-json.mjs";

export const SERVICE_STAGES = ["analyze", "clip", "render"];
export const QUEUE_PRIORITIES = ["HIGH", "NORMAL", "LOW"];

const PRIORITY_WEIGHT = { HIGH: 0, NORMAL: 1, LOW: 2 };
const FAIR_PRIORITY_CREDIT = { HIGH: 4, NORMAL: 2, LOW: 1 };
const NORMAL_TO_HIGH_AGE_MS = 15 * 60_000;
const LOW_TO_NORMAL_AGE_MS = 10 * 60_000;
const LOW_TO_HIGH_AGE_MS = 30 * 60_000;
const RETRY_DELAYS_MS = [5_000, 15_000, 30_000];
const DEFAULT_MAX_ATTEMPTS = 3;
const NO_CHANGE = Symbol("service-queue-no-change");

const queuePath = (root) => path.join(root, "data", "service-queue.json");
const freshQueue = () => ({ schemaVersion: 2, nextReadySequence: 0, tasks: [], scheduler: {} });
const taskKey = (batchId, stage, operation = "default") => `${batchId}:${stage}:${operation}`;
const now = () => new Date().toISOString();
const latestTaskForKey = (tasks, key) => tasks.findLast((task) => task.key === key);

export async function readQueue(root) {
  const file = queuePath(root);
  try {
    const queue = await readJson(file, freshQueue());
    if (queue && Array.isArray(queue.tasks)) return queue;
  } catch {
    // A Windows in-place replacement can briefly expose a truncated/NUL-filled
    // queue to lock-free readers. Try the newest valid replacement snapshot.
  }

  try {
    const directory = path.dirname(file);
    const names = (await readdir(directory))
      .filter((name) => name.startsWith("service-queue.json.replace-fallback."));
    const candidates = await Promise.all(names.map(async (name) => {
      const candidate = path.join(directory, name);
      const info = await stat(candidate).catch(() => null);
      return info ? { candidate, mtimeMs: info.mtimeMs } : null;
    }));
    candidates.sort((a, b) => (b?.mtimeMs || 0) - (a?.mtimeMs || 0));
    for (const item of candidates.slice(0, 20)) {
      if (!item) continue;
      try {
        const parsed = JSON.parse((await readFile(item.candidate, "utf8")).replace(/^\uFEFF/, ""));
        if (parsed && Array.isArray(parsed.tasks)) return parsed;
      } catch {
        // Replacement markers can also be incomplete; keep looking.
      }
    }
  } catch {
    // No usable snapshot exists.
  }
  return freshQueue();
}

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

function fairEnabled(value) {
  if (typeof value === "boolean") return value;
  return process.env.ENABLE_FAIR_MULTI_BATCH_SCHEDULER === "true";
}

function normalizeQueueMetadata(queue) {
  queue.schemaVersion = Math.max(2, Number(queue.schemaVersion) || 1);
  queue.scheduler = queue.scheduler && typeof queue.scheduler === "object" ? queue.scheduler : {};
  let sequence = Math.max(0, Number(queue.nextReadySequence) || 0);
  for (const task of queue.tasks || []) {
    if (!Number.isSafeInteger(Number(task.readySequence)) || Number(task.readySequence) <= 0) task.readySequence = ++sequence;
    else sequence = Math.max(sequence, Number(task.readySequence));
    task.executionState ||= task.status === "leased" ? "running" : task.status === "retry" ? "retry_wait" : task.status;
    task.readyAt ||= task.notBefore || task.enqueuedAt;
  }
  queue.nextReadySequence = sequence;
  return queue;
}

function effectivePriority(task, currentTime) {
  const priority = normalizePriority(task.priority);
  const readySince = new Date(task.readyAt || task.enqueuedAt || 0).getTime();
  const age = Number.isFinite(readySince) ? Math.max(0, currentTime - readySince) : 0;
  if (priority === "LOW" && age >= LOW_TO_HIGH_AGE_MS) return "HIGH";
  if (priority === "LOW" && age >= LOW_TO_NORMAL_AGE_MS) return "NORMAL";
  if (priority === "NORMAL" && age >= NORMAL_TO_HIGH_AGE_MS) return "HIGH";
  return priority;
}

function fairTask(queue, tasks, stage, currentTime) {
  if (!tasks.length) return null;
  const priority = QUEUE_PRIORITIES.find((candidate) => tasks.some((task) => effectivePriority(task, currentTime) === candidate));
  const eligible = tasks.filter((task) => effectivePriority(task, currentTime) === priority);
  const byBatch = new Map();
  for (const task of eligible.sort((a, b) => Number(a.readySequence) - Number(b.readySequence))) {
    if (!byBatch.has(task.batchId)) byBatch.set(task.batchId, []);
    byBatch.get(task.batchId).push(task);
  }
  const state = queue.scheduler[stage] ||= { cursorBatchId: null, lastClaimedBatchId: null, consecutiveClaims: 0, ring: [], batches: {} };
  state.batches ||= {};
  state.ring = Array.isArray(state.ring) ? state.ring.filter((batchId) => typeof batchId === "string") : [];
  const batchIds = [...byBatch.keys()];
  for (const batchId of batchIds) if (!state.ring.includes(batchId)) state.ring.push(batchId);
  // Keep a persistent stage ring. If the cursor Batch just completed and is no
  // longer ready, its position still identifies the next Batch fairly.
  const cursor = state.ring.indexOf(state.cursorBatchId);
  const orderedRing = cursor >= 0
    ? [...state.ring.slice(cursor + 1), ...state.ring.slice(0, cursor + 1)]
    : state.ring;
  const ring = orderedRing.filter((batchId) => byBatch.has(batchId));
  const alternatives = batchIds.some((batchId) => batchId !== state.lastClaimedBatchId);
  let selected = null;
  for (let round = 0; round < 2 && !selected; round += 1) {
    for (const batchId of ring) {
      if (alternatives && batchId === state.lastClaimedBatchId && Number(state.consecutiveClaims || 0) >= 2) continue;
      const batchState = state.batches[batchId] ||= { deficit: 0, lastServedAt: null };
      batchState.deficit += FAIR_PRIORITY_CREDIT[priority];
      const candidate = byBatch.get(batchId)[0];
      const cost = Math.max(1, Number(candidate.estimatedCost) || 1);
      if (batchState.deficit < cost) continue;
      batchState.deficit -= cost;
      batchState.lastServedAt = now();
      selected = candidate;
      state.cursorBatchId = batchId;
      if (state.lastClaimedBatchId === batchId) state.consecutiveClaims = Number(state.consecutiveClaims || 0) + 1;
      else { state.lastClaimedBatchId = batchId; state.consecutiveClaims = 1; }
      const liveBatchIds = new Set((queue.tasks || []).filter((task) => !["completed", "manual", "canceled"].includes(task.status)).map((task) => task.batchId));
      state.ring = state.ring.filter((id) => liveBatchIds.has(id) || id === batchId);
      break;
    }
  }
  return selected || ordered(eligible)[0];
}

async function mutate(root, change) {
  const file = queuePath(root);
  await mkdir(path.dirname(file), { recursive: true });
  return withFileLock(file, async () => {
    const queue = await readQueue(root);
    queue.tasks ??= [];
    normalizeQueueMetadata(queue);
    const result = await change(queue);
    if (result && result[NO_CHANGE]) return result.value;
    queue.updatedAt = now();
    await writeJsonAtomic(file, queue);
    return result;
  });
}

function noChange(value) {
  return { [NO_CHANGE]: true, value };
}

function desiredWorkflowVersion(workflowVersion) {
  return Number.isSafeInteger(Number(workflowVersion)) && Number(workflowVersion) > 0 ? Number(workflowVersion) : 1;
}

function canReuseEnqueuedTask(task, { priority, reason, notBefore, workflowVersion, reopenCompletedAfterMs }) {
  if (!task || Number(task.workflowVersion || 1) !== desiredWorkflowVersion(workflowVersion)) return false;
  // Explicit recovery cancels the old terminal task before enqueuing the same
  // key. Never mistake a canceled record with matching options for live work.
  if (task.status === "canceled") return false;
  // Manual and completed tasks are terminal for one workflow version. Periodic
  // discovery must not append another copy while the Batch state catches up.
  if (task.status === "manual") return true;
  if (task.status === "completed") {
    const threshold = Number(reopenCompletedAfterMs);
    if (!Number.isFinite(threshold) || threshold < 0 || !task.completedAt) return true;
    return Date.now() - new Date(task.completedAt).getTime() < threshold;
  }
  const nextPriority = normalizePriority(priority);
  const nextReason = reason || task.reason;
  const nextNotBefore = task.status === "retry" ? task.notBefore : (notBefore || task.notBefore);
  return task.priority === nextPriority && task.reason === nextReason && task.notBefore === nextNotBefore;
}

/**
 * @param {{ root: any, batchId: any, stage: any, operation?: string, priority?: string, reason?: any, notBefore?: any, workflowVersion?: any, taskNumber?: any, reopenCompletedAfterMs?: number }} options
 */
export async function enqueueStage({ root, batchId, stage, operation = "default", priority = "NORMAL", reason, notBefore, workflowVersion, taskNumber, reopenCompletedAfterMs }) {
  if (!SERVICE_STAGES.includes(stage)) throw new TypeError(`Unsupported service stage: ${stage}`);
  const key = taskKey(batchId, stage, operation);
  // Dedup is decided authoritatively under the file lock below. A pre-lock
  // snapshot read here could hand back a stale "reusable" task if the queue
  // changed in the meantime (e.g. the matching task was just canceled),
  // leaving the caller believing the batch was enqueued when no live task
  // exists. Always re-evaluate inside the lock instead.
  return mutate(root, (queue) => {
    // A manual task is terminal until an explicit human recovery action
    // changes it. Periodic state discovery must never silently reset its
    // attempt counter by inserting a second task with the same key.
    let existing = latestTaskForKey(queue.tasks || [], key);
    if (existing) {
      // A user-created workflow version is a fencing token. Do not let an old
      // reference/clip task survive into a new attempt for the same Batch.
      if (Number(existing.workflowVersion || 1) !== desiredWorkflowVersion(workflowVersion)) {
        existing.status = "canceled";
        existing.canceledAt = now();
        existing.reason = "Superseded by newer Batch workflow version";
        existing.lease = undefined;
        existing = undefined;
      } else {
        if (canReuseEnqueuedTask(existing, { priority, reason, notBefore, workflowVersion, reopenCompletedAfterMs })) return noChange(structuredClone(existing));
        if (["completed", "canceled"].includes(existing.status)) existing = undefined;
      }
      if (existing) {
        existing.priority = normalizePriority(priority);
        existing.reason = reason || existing.reason;
        // A periodic stage scan may rediscover a Batch while it is waiting for
        // its bounded recovery delay. Preserve retry state and notBefore so the
        // scan cannot bypass backoff or starve other queued Batches.
        if (existing.status !== "retry") existing.notBefore = notBefore || existing.notBefore;
        return structuredClone(existing);
      }
    }
    const task = {
      key,
      batchId,
      stage,
      operation,
      priority: normalizePriority(priority),
      status: "queued",
      executionState: "queued",
      attempt: 0,
      enqueuedAt: now(),
      readyAt: notBefore || now(),
      readySequence: ++queue.nextReadySequence,
      notBefore: notBefore || undefined,
      reason: reason || undefined,
      workflowVersion: desiredWorkflowVersion(workflowVersion),
      taskNumber: taskNumber || undefined,
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
    return changed.length ? changed : noChange(changed);
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
    return changed.length ? changed : noChange(changed);
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
    return changed.length ? changed : noChange(changed);
  });
}

export async function manualStageForBatch({ root, batchId, workflowVersion }) {
  const queue = await readQueue(root);
  return queue.tasks.find((task) => task.batchId === batchId && task.status === "manual" && (workflowVersion === undefined || Number(task.workflowVersion || 1) === Number(workflowVersion))) || null;
}

// Explicit, reversible operator hold for a known historical task. Periodic
// discovery preserves manual tasks; only an explicit retry may reopen them.
export async function holdQueuedStageForBatch({ root, batchId, stage, operation, workflowVersion, reason }) {
  if (!batchId || !SERVICE_STAGES.includes(stage) || !operation || !reason || !Number.isSafeInteger(Number(workflowVersion))) throw new TypeError("A precise queued task and hold reason are required");
  return mutate(root, (queue) => {
    const task = latestTaskForKey(queue.tasks, taskKey(batchId, stage, operation));
    if (!task || task.status !== "queued" || Number(task.workflowVersion || 1) !== Number(workflowVersion)) throw new Error("Historical hold target changed or is not queued");
    if (queue.tasks.some((item) => item.batchId === batchId && item.status === "leased")) throw new Error("Cannot hold a Batch with a live lease");
    task.status = "manual";
    task.executionState = "manual";
    task.reason = reason;
    task.manualAt = now();
    task.notBefore = undefined;
    task.lease = undefined;
    return structuredClone(task);
  });
}

export async function claimStage({ root, stage, workerId, leaseMs = 90_000, fairMultiBatch, allowedBatchIds }) {
  if (!SERVICE_STAGES.includes(stage)) throw new TypeError(`Unsupported service stage: ${stage}`);
  return mutate(root, (queue) => {
    const currentTime = Date.now();
    let changed = false;
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
        changed = true;
        if (attempt >= DEFAULT_MAX_ATTEMPTS) {
          task.status = "manual";
          task.executionState = "manual";
          task.manualAt = now();
          task.notBefore = undefined;
        } else {
          task.status = "retry";
          task.executionState = "retry_wait";
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
    if (workerBusy) return changed ? null : noChange(null);
    const busyBatchIds = new Set(queue.tasks
      .filter((item) => item.status === "leased" && item.lease && new Date(item.lease.expiresAt).getTime() > currentTime)
      .map((item) => item.batchId));
    const allowed = allowedBatchIds ? new Set(allowedBatchIds) : null;
    const candidates = queue.tasks.filter((item) =>
      item.stage === stage &&
      item.status === "queued" &&
      (!allowed || allowed.has(item.batchId)) &&
      !busyBatchIds.has(item.batchId) &&
      (!item.notBefore || new Date(item.notBefore).getTime() <= currentTime),
    );
    const task = fairEnabled(fairMultiBatch) ? fairTask(queue, candidates, stage, currentTime) : ordered(candidates)[0];
    if (!task) return changed ? null : noChange(null);
    const version = Number(task.leaseVersion || 0) + 1;
    task.leaseVersion = version;
    task.status = "leased";
    task.executionState = "running";
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
  const queue = await readQueue(root);
  const current = latestTaskForKey(queue.tasks || [], task.key);
  return Boolean(current && current.status === "leased" && current.lease?.leaseId === task.lease?.leaseId && current.lease?.version === task.lease?.version && new Date(current.lease.expiresAt).getTime() > Date.now());
}

export async function completeStage({ root, task }) {
  return mutate(root, (queue) => {
    const current = latestTaskForKey(queue.tasks, task.key);
    if (!current || current.status !== "leased" || current.lease?.leaseId !== task.lease?.leaseId || current.lease?.version !== task.lease?.version) return false;
    current.status = "completed";
    current.executionState = "completed";
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
      current.executionState = "manual";
      current.manualAt = now();
      return { state: "manual", attempt };
    }
    current.status = "retry";
    current.executionState = "retry_wait";
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
export async function deferStage({ root, task, reason, notBefore, fairMultiBatch }) {
  if (!notBefore || !Number.isFinite(new Date(notBefore).getTime())) throw new TypeError("notBefore is required for deferred work");
  return mutate(root, (queue) => {
    const current = latestTaskForKey(queue.tasks, task.key);
    if (!current || current.status !== "leased" || current.lease?.leaseId !== task.lease?.leaseId || current.lease?.version !== task.lease?.version) return { state: "lost" };
    current.status = "retry";
    current.executionState = String(reason || "").endsWith("BACKPRESSURE")
      ? "backpressured"
      : String(reason || "").startsWith("SEMANTIC_")
        ? "waiting_continuation"
        : "retry_wait";
    current.reason = reason;
    current.notBefore = notBefore;
    current.readyAt = notBefore;
    if (fairEnabled(fairMultiBatch)) current.readySequence = ++queue.nextReadySequence;
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
      task.executionState = "retry_wait";
      task.notBefore = new Date(Date.now() + RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)]).toISOString();
      task.retryAt = now();
      released.push({ task: structuredClone(task), state: "retry", attempt, notBefore: task.notBefore });
    }
    return released.length ? released : noChange(released);
  });
}

export async function promoteRetries({ root, stage }) {
  return mutate(root, (queue) => {
    const currentTime = Date.now();
    let promoted = 0;
    for (const task of queue.tasks) {
      if (task.stage === stage && task.status === "retry" && (!task.notBefore || new Date(task.notBefore).getTime() <= currentTime)) {
        task.status = "queued";
        task.executionState = "queued";
        promoted += 1;
      }
    }
    return promoted || noChange(promoted);
  });
}

export async function queueOverview(root, allowedBatchIds) {
  const queue = await readQueue(root);
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
