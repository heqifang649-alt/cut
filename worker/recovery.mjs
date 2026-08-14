import path from "node:path";
import { mkdir } from "node:fs/promises";
import { readJson, withFileLock, writeJsonAtomic } from "../lib/atomic-json.mjs";
import { batchWorkspacePath, batchWorkspacePathForId } from "../lib/tenant-paths.mjs";

export const MAX_RECOVERY_ATTEMPTS = 3;
export const MAX_CODEX_INACTIVITY_ATTEMPTS = 2;
export const MAX_CODEX_CONCURRENCY_ATTEMPTS = 5;

const RETRY_DELAYS_MS = [5_000, 15_000, 30_000];
const CODEX_CONCURRENCY_DELAYS_MS = [60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000, 15 * 60_000];
const RECOVERY_FILE = "recovery-log.json";
const CODEX_CONTROL_FILE = "codex-execution-control.json";
const CODEX_SLOT_TTL_MS = Math.max(60_000, Number(process.env.CUTFLOW_CODEX_SLOT_TTL_MS) || 2 * 60_000);
const CODEX_CAPACITY_WAIT_MS = Math.max(5_000, Number(process.env.CUTFLOW_CODEX_CAPACITY_WAIT_MS) || 30_000);
const CODEX_PROBE_FRESH_MS = Math.max(30_000, Number(process.env.CUTFLOW_CODEX_PROBE_FRESH_MS) || 5 * 60_000);
const MAX_RECENT_CODEX_FAILURES = 12;

export async function recoveryFileFor(root, batch) {
  const batchDir = typeof batch === "object" && batch ? batchWorkspacePath(root, batch) : await batchWorkspacePathForId(root, batch);
  return path.join(batchDir, RECOVERY_FILE);
}

function codexControlFileFor(root) {
  return path.join(root, "data", CODEX_CONTROL_FILE);
}

function codexConcurrencyLimit() {
  return Math.max(1, Math.floor(Number(process.env.CUTFLOW_CODEX_MAX_CONCURRENCY) || 1));
}

function nowIso() {
  return new Date().toISOString();
}

function parseTime(value) {
  const time = new Date(value || 0).getTime();
  return Number.isFinite(time) ? time : 0;
}

// Keep the retry implementation's existing `kind` values stable while
// exposing a precise, user-visible Codex failure class in diagnostics.
export function codexFailureClassFor(value) {
  const kind = String(typeof value === "object" && value ? value.failureClass || value.kind || "" : value || "").toLowerCase();
  if (["healthy", "normal"].includes(kind)) return "healthy";
  if (["stream_disconnected", "codex_stream_disconnected", "reconnect"].includes(kind)) return "stream_disconnected";
  if (["executor_stalled", "codex_executor_stalled", "codex_executor_incomplete"].includes(kind)) return "executor_stalled";
  if (["executor_crashed", "codex_executor_crashed"].includes(kind)) return "executor_crashed";
  if (["inactivity_timeout", "codex_inactivity", "codex_turn_inactivity_timeout"].includes(kind)) return "inactivity_timeout";
  if (["rate_limited", "codex_rate_limit", "codex_concurrency", "concurrency_limited"].includes(kind)) return "rate_limited";
  if (["auth_failed", "codex_authentication"].includes(kind)) return "auth_failed";
  if (["service_unavailable", "codex_service_unavailable"].includes(kind)) return "service_unavailable";
  return undefined;
}

function initialCodexControl() {
  return {
    schemaVersion: 1,
    circuit: { state: "closed", consecutiveFailures: 0 },
    slots: [],
    runtime: {
      modelServiceReachable: null,
      codexExecutorAlive: null,
      sdkTurnActive: false,
      sdkTurnCompleted: false,
      authenticationValid: null,
      status: "normal",
      failureClass: "healthy",
      currentTurn: null,
      lastTurn: null,
      lastSdkEventAt: null,
      lastCompletedAt: null,
      failedRequests: 0,
      rateLimitErrors: 0,
      concurrencyErrors: 0,
      recentFailures: [],
    },
  };
}

function pruneExpiredSlots(control, currentTime = Date.now()) {
  control.slots = (Array.isArray(control.slots) ? control.slots : []).filter((slot) => parseTime(slot.expiresAt) > currentTime);
}

async function mutateCodexControl(root, change) {
  const file = codexControlFileFor(root);
  await mkdir(path.dirname(file), { recursive: true });
  return withFileLock(file, async () => {
    const control = await readJson(file, initialCodexControl());
    control.schemaVersion = 1;
    control.circuit ??= { state: "closed", consecutiveFailures: 0 };
    control.runtime ??= initialCodexControl().runtime;
    pruneExpiredSlots(control);
    const result = await change(control);
    control.updatedAt = nowIso();
    await writeJsonAtomic(file, control);
    return result;
  });
}

export async function readCodexExecutionState(root) {
  const control = await readJson(codexControlFileFor(root), initialCodexControl());
  const account = await readJson(path.join(root, "data", "codex-account-state.json"), null);
  const accountProbeFresh = Boolean(account && parseTime(account.checkedAt) >= Date.now() - CODEX_PROBE_FRESH_MS);
  const runtime = {
    ...initialCodexControl().runtime,
    ...(control.runtime || {}),
    ...(accountProbeFresh ? {
      modelServiceReachable: account.apiReady === true,
      codexExecutorAlive: account.executorReady === true,
      // A fresh probe can confirm a healthy account, but must never overwrite
      // a later real-Turn authentication failure recorded by a worker.
      authenticationValid: control.runtime?.authenticationValid === false || account.authenticationValid === false
        ? false
        : account.apiReady === true ? true : null,
    } : {}),
  };
  const slots = (Array.isArray(control.slots) ? control.slots : []).filter((slot) => parseTime(slot.expiresAt) > Date.now());
  const circuit = control.circuit || { state: "closed", consecutiveFailures: 0 };
  const queueFile = path.join(root, "data", "service-queue.json");
  let queue = { waiting: 0, running: 0, failed: 0, retry: 0, tasks: [] };
  try {
    const serviceQueue = await readJson(queueFile, { tasks: [] });
    for (const task of Array.isArray(serviceQueue.tasks) ? serviceQueue.tasks : []) {
      if (!isCodexServiceTask(task?.stage, task?.operation)) continue;
      if (task.status === "queued") queue.waiting += 1;
      if (task.status === "leased") queue.running += 1;
      if (task.status === "retry") { queue.waiting += 1; queue.retry += 1; }
      if (task.status === "manual") queue.failed += 1;
      if (["queued", "leased", "retry", "manual"].includes(task.status)) {
        queue.tasks.push({
          key: task.key,
          stage: task.stage,
          operation: task.operation,
          status: task.status,
          attempt: Number(task.attempt || 0),
          notBefore: task.notBefore || null,
          reason: task.reason || null,
          lease: task.lease ? {
            workerId: task.lease.workerId,
            leaseId: task.lease.leaseId,
            heartbeatAt: task.lease.heartbeatAt,
            expiresAt: task.lease.expiresAt,
          } : null,
        });
      }
    }
  } catch (error) {
    queue.readError = String(error instanceof Error ? error.message : error).slice(-300);
  }
  const status = runtime.authenticationValid === false
    ? "auth_invalid"
    : circuit.state === "open" || circuit.state === "half_open" || circuit.state === "manual"
      ? "backoff"
      : runtime.sdkTurnActive
        ? "running"
        : ["auth_invalid", "backoff", "unresponsive"].includes(runtime.status)
          ? runtime.status
        : runtime.modelServiceReachable === true && runtime.codexExecutorAlive === true
          ? "normal"
          : "unresponsive";
  return {
    ...runtime,
    status,
    circuit,
    slots,
    concurrencyLimit: codexConcurrencyLimit(),
    activeSlotCount: slots.length,
    currentTurn: runtime.currentTurn || null,
    lastTurn: runtime.lastTurn || null,
    queue,
    probe: account ? {
      checkedAt: account.checkedAt || null,
      fresh: accountProbeFresh,
      response: account.response || null,
      failureClass: account.failureClass || null,
      error: account.error || null,
      sdkEventCount: Number(account.sdkEventCount || 0),
      lastSdkEventType: account.lastSdkEventType || null,
      threadId: account.threadId || null,
    } : null,
  };
}

export async function updateCodexRuntime(root, change) {
  return mutateCodexControl(root, (control) => {
    control.runtime = { ...initialCodexControl().runtime, ...(control.runtime || {}), ...change };
    return structuredClone(control.runtime);
  });
}

export async function recordCodexTurnStart({ root, turnId, threadId, taskKey, service, slotId, queueLeaseId }) {
  return updateCodexRuntime(root, {
    sdkTurnActive: true,
    sdkTurnCompleted: false,
    codexExecutorAlive: true,
    status: "running",
    failureClass: "healthy",
    currentTurn: { turnId, threadId, taskKey, service, slotId, queueLeaseId, startedAt: nowIso(), eventCount: 0 },
  });
}

export async function recordCodexSdkEvent({ root, turnId, event }) {
  const at = nowIso();
  return mutateCodexControl(root, (control) => {
    const runtime = { ...initialCodexControl().runtime, ...(control.runtime || {}) };
    if (runtime.currentTurn?.turnId && runtime.currentTurn.turnId !== turnId) return false;
    runtime.sdkTurnActive = true;
    runtime.sdkTurnCompleted = false;
    runtime.lastSdkEventAt = at;
    runtime.currentTurn = {
      ...(runtime.currentTurn || {}),
      turnId,
      ...(event?.thread_id ? { threadId: event.thread_id } : {}),
      eventCount: Number(runtime.currentTurn?.eventCount || 0) + 1,
      lastEventAt: at,
      lastEventType: event?.type || "unknown",
    };
    runtime.status = "running";
    control.runtime = runtime;
    return true;
  });
}

export async function recordCodexTurnCompleted({ root, turnId }) {
  const at = nowIso();
  return mutateCodexControl(root, (control) => {
    const runtime = { ...initialCodexControl().runtime, ...(control.runtime || {}) };
    if (runtime.currentTurn?.turnId && runtime.currentTurn.turnId !== turnId) return false;
    runtime.sdkTurnActive = false;
    runtime.sdkTurnCompleted = true;
    runtime.lastCompletedAt = at;
    runtime.lastSdkEventAt = at;
    runtime.status = "normal";
    runtime.failureClass = "healthy";
    runtime.lastTurn = runtime.currentTurn ? { ...runtime.currentTurn, completedAt: at, outcome: "completed" } : runtime.lastTurn;
    runtime.currentTurn = null;
    control.runtime = runtime;
    return true;
  });
}

export async function recordCodexTurnFailure({ root, turnId, kind, failureClass, message, diagnostic }) {
  return mutateCodexControl(root, (control) => {
    const runtime = { ...initialCodexControl().runtime, ...(control.runtime || {}) };
    runtime.sdkTurnActive = false;
    runtime.sdkTurnCompleted = false;
    runtime.failedRequests = Number(runtime.failedRequests || 0) + 1;
    if (kind === "codex_concurrency") runtime.concurrencyErrors = Number(runtime.concurrencyErrors || 0) + 1;
    if (kind === "codex_rate_limit") runtime.rateLimitErrors = Number(runtime.rateLimitErrors || 0) + 1;
    const normalizedFailureClass = codexFailureClassFor(failureClass || kind);
    if (normalizedFailureClass === "auth_failed") runtime.authenticationValid = false;
    if (["executor_crashed", "executor_stalled"].includes(normalizedFailureClass)) runtime.codexExecutorAlive = false;
    runtime.status = normalizedFailureClass === "auth_failed"
      ? "auth_invalid"
      : ["inactivity_timeout", "stream_disconnected", "executor_stalled", "executor_crashed", "service_unavailable"].includes(normalizedFailureClass)
        ? "unresponsive"
        : normalizedFailureClass === "rate_limited" ? "backoff" : "normal";
    runtime.failureClass = normalizedFailureClass || "service_unavailable";
    const failure = {
      at: nowIso(),
      turnId,
      kind,
      failureClass: normalizedFailureClass,
      message: String(message || "").slice(-800),
      ...(diagnostic && typeof diagnostic === "object" ? { diagnostic: structuredClone(diagnostic) } : {}),
    };
    runtime.recentFailures = [failure, ...(Array.isArray(runtime.recentFailures) ? runtime.recentFailures : [])].slice(0, MAX_RECENT_CODEX_FAILURES);
    if (runtime.currentTurn?.turnId === turnId) {
      runtime.lastTurn = { ...runtime.currentTurn, failedAt: failure.at, errorKind: kind, error: failure.message, outcome: "failed" };
      runtime.currentTurn = null;
    }
    control.runtime = runtime;
    return structuredClone(runtime);
  });
}

export async function setCodexProbeState({ root, modelServiceReachable, codexExecutorAlive, authenticationValid, status, response, sdkTurnCompleted, failureClass }) {
  return mutateCodexControl(root, (control) => {
    const runtime = { ...initialCodexControl().runtime, ...(control.runtime || {}) };
    runtime.modelServiceReachable = modelServiceReachable;
    runtime.codexExecutorAlive = codexExecutorAlive;
    runtime.authenticationValid = authenticationValid;
    runtime.failureClass = failureClass || (status === "normal" ? "healthy" : runtime.failureClass);
    // An administrative probe may fail while a real Turn is still active. It
    // reports probe health, but must never erase the active Turn lifecycle.
    if (!runtime.sdkTurnActive) {
      runtime.status = status;
      runtime.sdkTurnCompleted = sdkTurnCompleted === true;
    }
    if (response) runtime.lastProbeResponse = String(response).slice(-800);
    runtime.checkedAt = nowIso();
    control.runtime = runtime;
    return structuredClone(runtime);
  });
}

export function isCodexServiceTask(stage, operation) {
  return (stage === "analyze" && ["reference", "regroup"].includes(operation))
    || (stage === "clip" && ["edit", "revision"].includes(operation));
}

export async function acquireCodexExecution({ root, task, service, workerId }) {
  const currentTime = Date.now();
  return mutateCodexControl(root, (control) => {
    const circuit = control.circuit;
    if (circuit.state === "manual") {
      return { state: "manual", message: circuit.lastError || "Codex concurrency backoff requires bounded manual requeue." };
    }

    if (circuit.state === "half_open") {
      if (parseTime(circuit.probe?.expiresAt) > currentTime) {
        return { state: "waiting", retryAt: circuit.probe.expiresAt, message: "Codex concurrency circuit is running one recovery probe." };
      }
      circuit.state = "open";
      circuit.probe = undefined;
      circuit.nextRetryAt = nowIso();
    }

    if (circuit.state === "open") {
      if (parseTime(circuit.nextRetryAt) > currentTime) {
        return { state: "waiting", retryAt: circuit.nextRetryAt, message: "Codex account concurrency backoff is active." };
      }
      circuit.state = "half_open";
      circuit.probe = {
        id: crypto.randomUUID(),
        taskKey: task.key,
        workerId,
        service,
        startedAt: nowIso(),
        expiresAt: new Date(currentTime + CODEX_SLOT_TTL_MS).toISOString(),
      };
      circuit.nextRetryAt = undefined;
    }

    const limit = codexConcurrencyLimit();
    if (control.slots.length >= limit) {
      // A due circuit must only become half-open if its probe actually gets a
      // slot. Otherwise a busy pre-existing slot would consume the probe window
      // without ever contacting Codex.
      if (circuit.state === "half_open" && circuit.probe?.taskKey === task.key) {
        circuit.state = "open";
        circuit.probe = undefined;
        circuit.nextRetryAt = nowIso();
      }
      return {
        state: "waiting",
        retryAt: new Date(currentTime + CODEX_CAPACITY_WAIT_MS).toISOString(),
        message: `Codex account safe concurrency limit (${limit}) is currently in use.`,
      };
    }

    const slot = {
      id: crypto.randomUUID(),
      taskKey: task.key,
      workerId,
      service,
      acquiredAt: nowIso(),
      heartbeatAt: nowIso(),
      expiresAt: new Date(currentTime + CODEX_SLOT_TTL_MS).toISOString(),
      probeId: circuit.probe?.taskKey === task.key ? circuit.probe.id : undefined,
    };
    control.slots.push(slot);
    return { state: "acquired", slot: structuredClone(slot), limit };
  });
}

export async function heartbeatCodexExecution({ root, slot }) {
  if (!slot?.id) return false;
  return mutateCodexControl(root, (control) => {
    const current = control.slots.find((item) => item.id === slot.id);
    if (!current) return false;
    current.heartbeatAt = nowIso();
    current.expiresAt = new Date(Date.now() + CODEX_SLOT_TTL_MS).toISOString();
    return true;
  });
}

export async function releaseCodexExecution({ root, slot, succeeded = false }) {
  if (!slot?.id) return false;
  return mutateCodexControl(root, (control) => {
    const index = control.slots.findIndex((item) => item.id === slot.id);
    if (index < 0) return false;
    control.slots.splice(index, 1);
    if (succeeded && control.circuit.state === "half_open" && control.circuit.probe?.id === slot.probeId) {
      control.circuit = { state: "closed", consecutiveFailures: 0, closedAt: nowIso(), lastSuccessAt: nowIso() };
    }
    return true;
  });
}

export async function tripCodexConcurrencyCircuit({ root, message, task, service, workerId, kind = "codex_concurrency" }) {
  return mutateCodexControl(root, (control) => {
    const previous = Number(control.circuit?.consecutiveFailures || 0);
    const attempt = previous + 1;
    const details = {
      lastError: String(message || "Codex concurrency limit exceeded").slice(-1200),
      lastFailureAt: nowIso(),
      lastTaskKey: task?.key,
      lastService: service,
      lastWorkerId: workerId,
      lastKind: kind,
      consecutiveFailures: attempt,
    };
    // Keep all five documented account-level backoff windows (1/2/5/10/15
    // minutes). Only the following failure requires manual intervention.
    if (attempt > MAX_CODEX_CONCURRENCY_ATTEMPTS) {
      control.circuit = { state: "manual", ...details, manualAt: nowIso() };
      return { state: "manual", attempt };
    }
    const delayMs = retryDelayFor(attempt, { kind });
    control.circuit = {
      state: "open",
      ...details,
      probe: undefined,
      nextRetryAt: new Date(Date.now() + delayMs).toISOString(),
    };
    return { state: "open", attempt, delayMs, nextRetryAt: control.circuit.nextRetryAt };
  });
}

export function classifyRecoveryError(error, context = {}) {
  const message = String(error instanceof Error ? error.message : error || "").toLowerCase();
  const errorCode = String(error && typeof error === "object" ? error.code || "" : "").toLowerCase();
  if (context.canceled) return { category: "fatal", kind: "canceled", recoverable: false, label: "任务已取消" };
  if (errorCode === "codex_circuit_manual") {
    return { category: "business", kind: "codex_circuit_manual", recoverable: false, label: "Codex 并发熔断等待人工处理" };
  }
  if (errorCode === "edit_plan_not_ready") {
    return { category: "business", kind: "edit_plan_not_ready", recoverable: false, label: "剪辑计划未生成，等待人工处理" };
  }
  if (errorCode === "codex_executor_incomplete" || /(?:executor|codex).*?(?:ended|exited).*?(?:without|missing).*?(?:turn\.)?completed|without a completed turn event/.test(message)) {
    return { category: "recoverable", kind: "codex_executor_stalled", failureClass: "executor_stalled", recoverable: true, label: "Codex executor did not complete its Turn; rebuilding executor" };
  }
  if (errorCode === "codex_executor_crashed" || /codex exec exited with (?:code|signal)|child process has no (?:stdin|stdout)/.test(message)) {
    return { category: "recoverable", kind: "codex_executor_crashed", failureClass: "executor_crashed", recoverable: true, label: "Codex executor exited; rebuilding executor" };
  }
  if (errorCode === "codex_turn_inactivity_timeout") {
    // Keep the established bounded inactivity retry policy, while recording
    // the stable public failure class separately from the legacy retry kind.
    return { category: "recoverable", kind: "codex_inactivity", recoverable: true, label: "Codex 长时间无事件，正在重新连接" };
  }
  if (
    errorCode === "codex_service_unavailable"
    || /country,? region,? or territory not supported|region not supported|model service (?:is )?(?:unavailable|unreachable)|service unavailable|upstream request failed/.test(message)
    || /\b(?:500|502|503|504)\b/.test(message)
  ) {
    return { category: "recoverable", kind: "codex_service_unavailable", failureClass: "service_unavailable", recoverable: true, label: "Codex model service is temporarily unavailable; backing off" };
  }
  if (
    errorCode === "codex_authentication"
    || /\b401\b|unauthori[sz]ed|invalid api key|authentication failed|auth expired|credential(?:s)? (?:is )?missing|missing (?:api )?(?:credential|token|key)/.test(message)
    || /\b403\b.*(?:api key|credential|access token|authentication)/.test(message)
  ) {
    return { category: "business", kind: "codex_authentication", failureClass: "auth_failed", recoverable: false, label: "Codex authentication requires reconnect" };
  }
  if (
    errorCode === "codex_rate_limit"
    || /\b429\b|too many requests|usage limit|hit your usage|rate limit/.test(message)
  ) {
    return { category: "recoverable", kind: "codex_rate_limit", recoverable: true, label: "Codex rate limit backoff is active" };
  }
  if (
    errorCode === "codex_concurrency_limit"
    || /concurrency limit exceeded|too many concurrent/.test(message)
  ) {
    return { category: "recoverable", kind: "codex_concurrency", recoverable: true, label: "Codex 账户并发受限，正在全局退避" };
  }

  if (
    errorCode === "codex_stream_disconnected"
    || /stream disconnected|stream.*?(?:closed|ended|reset)|connection reset|econnreset|socket hang up/.test(message)
  ) {
    return { category: "recoverable", kind: "codex_stream_disconnected", recoverable: true, label: "Codex stream disconnected; rebuilding Turn" };
  }

  const manualResources = [
    /render resource (?:missing|invalid|unavailable)/,
    /runtime configuration (?:is )?(?:missing|invalid)/,
    /(?:music|bgm|lut|\.cube|subtitle|text[ -]?layout|hook\.png|cvr\.png|overlay).*?(?:missing|not found|enoent|unavailable|empty|invalid)/,
    /(?:missing|not found|enoent|unavailable|empty|invalid).*?(?:music|bgm|lut|\.cube|subtitle|text[ -]?layout|hook\.png|cvr\.png|overlay)/,
  ];
  if (manualResources.some((rule) => rule.test(message))) {
    return { category: "business", kind: "manual_resource", recoverable: false, label: "渲染资源待人工补充" };
  }

  const business = [
    /(?:batch-edl\.json.*?(enoent|no such file|missing|不存在|缺失)|(?:enoent|no such file).*?batch-edl\.json)/,
    /batch-edl\.json.*?(no|without|没有|无).*?(renderable|可渲染).*?(product|产品)|no renderable product/,
    /product view.*?(empty|missing|为空|缺失)|产品视图.*?(为空|缺失)|productview.*?(empty|missing|为空|缺失)/,
    /schedule failed|排片失败/,
    /no (source )?(material|media|video|clip)s?|没有素材|无素材/,
    /render\s*plan.*?(empty|missing|invalid|not ready|no renderable)|(?:cannot|unable)\s+(?:generate\s+)?render\s*plan|无法生成\s*renderplan|无\s*renderplan/,
    /schedule-result\.json.*?(empty|missing|invalid|no renderable)/,
  ];
  if (business.some((rule) => rule.test(message))) return { category: "business", kind: "business", recoverable: false, label: "业务条件未满足，需要人工处理" };

  const fatal = [
    /enoent|no such file|文件不存在|视频不存在|找不到.*原片/,
    /invalid data|invalid input|corrupt|损坏|非法格式|unsupported|不支持的格式/,
    /missing .*?(file|video)|素材.*缺失|原片.*不存在/,
  ];
  if (fatal.some((rule) => rule.test(message)) && !/network path|network name|网络路径|nas.*暂时|暂不可用/.test(message)) {
    return { category: "fatal", kind: "fatal", recoverable: false, label: "致命错误，任务失败" };
  }

  const reconnect = [
    /worker.*(?:disconnect|crash)/,
    /econnrefused|econnreset|ehostunreach|enetunreach|eai_again/,
    /connection refused|connection reset|network timeout|network path|network name|upstream request failed|stream disconnected before completion/,
    /worker.*disconnect|codex.*disconnect|heartbeat.*(lost|missing)|nas.*(unavailable|temporarily|不可读)/,
    /连接被拒绝|连接断开|网络超时|网络路径.*不可用|心跳.*丢失/,
  ];
  if (reconnect.some((rule) => rule.test(message))) return { category: "recoverable", kind: "reconnect", recoverable: true, label: "正在重新连接" };

  const retryable = [
    /timeout|timed out|etimedout|temporar|eio|i\/o error|ffmpeg|编码|渲染|读写|io错误|超时/,
  ];
  if (retryable.some((rule) => rule.test(message))) return { category: "recoverable", kind: "retry", recoverable: true, label: "正在自动重试" };
  return { category: "fatal", kind: "fatal", recoverable: false, label: "致命错误，任务失败" };
}

export function recoveryAttemptLimit(classification) {
  if (classification?.kind === "codex_inactivity") return MAX_CODEX_INACTIVITY_ATTEMPTS;
  if (["codex_concurrency", "codex_rate_limit"].includes(classification?.kind)) return MAX_CODEX_CONCURRENCY_ATTEMPTS;
  return MAX_RECOVERY_ATTEMPTS;
}

export function codexInactivityManualMessage() {
  return "Codex SDK inactivity timeout，连续2次未产生事件";
}

function initialState() {
  return { schemaVersion: 1, attempts: 0, state: "idle", events: [] };
}

export async function readRecoveryState(root, batchId) {
  return readJson(await recoveryFileFor(root, batchId), initialState());
}

export async function appendRecoveryEvent(root, batchId, event) {
  const file = await recoveryFileFor(root, batchId);
  await mkdir(path.dirname(file), { recursive: true });
  return withFileLock(file, async () => {
    const current = await readJson(file, initialState());
    const next = {
      ...current,
      ...event,
      events: [...(Array.isArray(current.events) ? current.events : []), {
        at: event.at || nowIso(),
        message: event.message,
        tone: event.tone || "active",
      }].slice(-100),
      updatedAt: nowIso(),
    };
    await writeJsonAtomic(file, next);
    return next;
  });
}

export function retryDelayFor(attempt, classification) {
  const delays = ["codex_concurrency", "codex_rate_limit"].includes(classification?.kind) ? CODEX_CONCURRENCY_DELAYS_MS : RETRY_DELAYS_MS;
  return delays[Math.min(Math.max(0, Number(attempt || 1) - 1), delays.length - 1)];
}

export async function scheduleRecovery({ root, batchId, attempt, stage, classification, message }) {
  const nextRetryAt = new Date(Date.now() + retryDelayFor(attempt, classification)).toISOString();
  return appendRecoveryEvent(root, batchId, {
    attempts: attempt,
    state: "recovering",
    stage,
    issue: classification.failureClass || codexFailureClassFor(classification) || classification.kind,
    nextRetryAt,
    sourceError: String(message || "").slice(-1200),
    message: `自动恢复中：${classification.label}，第 ${attempt} 次尝试`,
    tone: "active",
  });
}

export async function markRecoveryRetryReady({ root, batchId, stage }) {
  const current = await readRecoveryState(root, batchId);
  if (current.state !== "recovering") return current;
  return appendRecoveryEvent(root, batchId, {
    attempts: current.attempts,
    state: "retry_ready",
    stage,
    issue: undefined,
    nextRetryAt: undefined,
    message: "恢复等待结束，正在重新执行当前阶段",
    tone: "waiting",
  });
}

export async function markRecoverySucceeded({ root, batchId, stage, evidence }) {
  const current = await readRecoveryState(root, batchId);
  if (current.state !== "retry_ready") return current;
  return appendRecoveryEvent(root, batchId, {
    attempts: 0,
    state: "recovered",
    stage,
    issue: undefined,
    nextRetryAt: undefined,
    evidence,
    message: `业务恢复成功：${evidence}`,
    tone: "success",
  });
}

export async function markManualRequired({ root, batchId, stage, message }) {
  return appendRecoveryEvent(root, batchId, {
    state: "manual_required",
    stage,
    nextRetryAt: undefined,
    message: `等待人工处理：${message}`,
    tone: "failed",
  });
}

export async function markFatalFailure({ root, batchId, stage, message }) {
  return appendRecoveryEvent(root, batchId, {
    state: "failed",
    stage,
    nextRetryAt: undefined,
    message: `任务失败：${message}`,
    tone: "failed",
  });
}

export function isRetryDue(state, now = Date.now()) {
  if (state?.state !== "recovering") return true;
  return !state.nextRetryAt || new Date(state.nextRetryAt).getTime() <= now;
}
