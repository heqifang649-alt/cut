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

function initialCodexControl() {
  return {
    schemaVersion: 1,
    circuit: { state: "closed", consecutiveFailures: 0 },
    slots: [],
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
    pruneExpiredSlots(control);
    const result = await change(control);
    control.updatedAt = nowIso();
    await writeJsonAtomic(file, control);
    return result;
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
      return { state: "manual", message: circuit.lastError || "Codex account concurrency circuit requires manual attention." };
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

export async function tripCodexConcurrencyCircuit({ root, message, task, service, workerId }) {
  return mutateCodexControl(root, (control) => {
    const previous = Number(control.circuit?.consecutiveFailures || 0);
    const attempt = previous + 1;
    const details = {
      lastError: String(message || "Codex concurrency limit exceeded").slice(-1200),
      lastFailureAt: nowIso(),
      lastTaskKey: task?.key,
      lastService: service,
      lastWorkerId: workerId,
      consecutiveFailures: attempt,
    };
    if (attempt >= MAX_CODEX_CONCURRENCY_ATTEMPTS) {
      control.circuit = { state: "manual", ...details, manualAt: nowIso() };
      return { state: "manual", attempt };
    }
    const delayMs = retryDelayFor(attempt, { kind: "codex_concurrency" });
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
  if (errorCode === "codex_turn_inactivity_timeout") {
    return { category: "recoverable", kind: "codex_inactivity", recoverable: true, label: "Codex 长时间无事件，正在重新连接" };
  }
  if (
    errorCode === "codex_concurrency_limit"
    || /concurrency limit exceeded|too many concurrent|rate limit|http\s*429|status\s*429/.test(message)
  ) {
    return { category: "recoverable", kind: "codex_concurrency", recoverable: true, label: "Codex 账户并发受限，正在全局退避" };
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
    /connection refused|connection reset|network timeout|network path|network name/,
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
  if (classification?.kind === "codex_concurrency") return MAX_CODEX_CONCURRENCY_ATTEMPTS;
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
  const delays = classification?.kind === "codex_concurrency" ? CODEX_CONCURRENCY_DELAYS_MS : RETRY_DELAYS_MS;
  return delays[Math.min(Math.max(0, Number(attempt || 1) - 1), delays.length - 1)];
}

export async function scheduleRecovery({ root, batchId, attempt, stage, classification, message }) {
  const nextRetryAt = new Date(Date.now() + retryDelayFor(attempt, classification)).toISOString();
  return appendRecoveryEvent(root, batchId, {
    attempts: attempt,
    state: "recovering",
    stage,
    issue: classification.kind,
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
