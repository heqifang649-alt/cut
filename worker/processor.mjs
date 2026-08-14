import { existsSync } from "node:fs";
import { access, copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isNewRendererEnabled, renderBatchFromEdl, renderBatchFromRenderPlans } from "./batch-renderer.mjs";
import { importBatchToShotPool, isNewShotPoolEnabled, loadShotPool } from "./ai-ingest.mjs";
import { isNewValidatorEnabled, validateVideo } from "./ai-video-validator.mjs";
import { isArtifactGateEnabled, validateWithArtifactGate } from "./artifact-gate.mjs";
import { createProductViews, isNewSchedulerEnabled, scheduleProductView } from "./shot-scheduler.mjs";
import { isSemanticShadowEnabled, runSemanticShadow } from "./semantic-shadow.mjs";
import { groupProductsByFilename, groupProductsByProductDirectory } from "./filename-product-grouper.mjs";
import { readJson, withFileLock, writeJsonAtomic } from "../lib/atomic-json.mjs";
import { MAX_RECOVERY_ATTEMPTS, classifyRecoveryError, codexInactivityManualMessage, isRetryDue, markFatalFailure, markManualRequired, markRecoveryRetryReady, markRecoverySucceeded, readRecoveryState, recordCodexSdkEvent, recordCodexTurnCompleted, recordCodexTurnFailure, recordCodexTurnStart, recoveryAttemptLimit, scheduleRecovery } from "./recovery.mjs";
import { recordBatchFailure } from "./failure-diagnostics.mjs";
import { assertLegacyEditPlanReady, editPlanPrerequisiteError } from "./edit-plan-readiness.mjs";
import { loadRenderRuntimeConfig } from "./runtime-config.mjs";
import { analyzeTemplateTransitions, writeFallbackTransitionPlan } from "./template-transition-analysis.mjs";
import { batchWorkspacePath, batchWorkspacePathForId, resolveStoredWorkspaceFile, templateWorkspacePath } from "../lib/tenant-paths.mjs";
import { createCodexClient } from "../lib/codex-client.mjs";

const ROOT = process.cwd();
const STORE = path.join(ROOT, "data", "batches.json");
const TEMPLATE_STORE = path.join(ROOT, "data", "templates.json");
const HEARTBEAT = path.join(ROOT, "data", "worker-heartbeat.json");
const ACCOUNT_STATE = path.join(ROOT, "data", "codex-account-state.json");
const FFMPEG = process.env.FFMPEG_PATH || "D:\\JianyingPro\\11.1.0.14287\\ffmpeg.exe";
const GOLD_STANDARD = process.env.GOLD_STANDARD_PATH || path.join(ROOT, "standards", "reference-sets", "gc-good-20260805", "gold-standard-v2.json");
const GC_SKILL_DIRECTIVE = `Use $gc-fashion-ad-editor for this clothing-ad task. The approved quality authority is ${GOLD_STANDARD}. Follow its sample-first, clothing-focus, full-look/detail coverage, stable-camera, color-continuity, original-speed, unique-music, beat-sync, safe-zone, and 95-point QC requirements.`;
const TURN_TIMEOUT_MS = Math.max(5 * 60 * 1000, Number(process.env.CUTFLOW_TURN_TIMEOUT_MS) || 10 * 60 * 1000);
const TURN_ACTIVITY_PERSIST_MS = Math.max(1_000, Number(process.env.CUTFLOW_TURN_ACTIVITY_PERSIST_MS) || 2_000);
const FFMPEG_TIMEOUT_MS = Math.max(5 * 60 * 1000, Number(process.env.CUTFLOW_FFMPEG_TIMEOUT_MS) || 20 * 60 * 1000);
const once = process.argv.includes("--once");
const WORKER_INSTANCE = process.env.CUTFLOW_WORKER_INSTANCE || `Worker-${process.pid}`;
const GROUP_EVIDENCE_FILE = "group-evidence.v1.json";
const GROUP_EVIDENCE_TIMEOUT_MS = 20_000;
let leaseGuard = null;
let failureContext = null;

async function writeHeartbeat() {
  await mkdir(path.dirname(HEARTBEAT), { recursive: true });
  await writeFile(HEARTBEAT, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, workerId: WORKER_INSTANCE }), "utf8");
}

class CanceledError extends Error {
  constructor() { super("任务已由团队取消"); this.name = "CanceledError"; }
}

class TurnTimeoutError extends Error {
  constructor(context = {}) {
    const timeoutMs = Number(context.timeoutMs) || TURN_TIMEOUT_MS;
    super(context.completionMissing
      ? "Codex executor ended without a completed turn event"
      : `Codex 剪辑已连续 ${Math.round(timeoutMs / 60000)} 分钟没有新的 SDK 事件`);
    this.name = "TurnTimeoutError";
    this.code = "CODEX_TURN_INACTIVITY_TIMEOUT";
    this.codexTurn = {
      timeoutMs,
      eventCount: Number(context.eventCount || 0),
      lastEventAt: context.lastEventAt,
      lastEventType: context.lastEventType,
      lastEventSummary: context.lastEventSummary,
      threadId: context.threadId,
      turnId: context.turnId,
    };
  }
}

class ExecutorIncompleteError extends Error {
  constructor(context = {}) {
    super("Codex executor ended without a completed turn event");
    this.name = "ExecutorIncompleteError";
    this.code = "CODEX_EXECUTOR_INCOMPLETE";
    this.codexTurn = context;
  }
}

function codexErrorDiagnostic(error, context = {}) {
  const source = error && typeof error === "object" ? error : {};
  const message = error instanceof Error ? error.message : String(error || "Unknown Codex failure");
  const statusMatch = message.match(/\b(?:http\s*)?(401|403|429|500|502|503|504)\b/i);
  const suppliedStatus = Number(source.httpStatus ?? source.status ?? source.statusCode);
  return {
    ...context,
    errorCode: source.code ? String(source.code) : undefined,
    httpStatus: Number.isInteger(suppliedStatus) ? suppliedStatus : statusMatch ? Number(statusMatch[1]) : undefined,
    cause: source.cause instanceof Error ? source.cause.message.slice(-800) : undefined,
  };
}

function turnFailedError(failure, context) {
  const source = failure && typeof failure === "object" ? failure : {};
  const error = new Error(source.message || String(failure || "Codex turn failed"));
  if (source.code) error.code = String(source.code);
  if (source.status !== undefined) error.status = source.status;
  if (source.statusCode !== undefined) error.statusCode = source.statusCode;
  if (source.httpStatus !== undefined) error.httpStatus = source.httpStatus;
  error.codexTurn = context;
  return error;
}

const batchDirFor = (batch) => batchWorkspacePath(ROOT, batch);
const cancelFlagFor = async (id) => path.join(await batchWorkspacePathForId(ROOT, id), "cancel.request");
function isInsideNasRoot(root, candidate) {
  const relative = path.win32.relative(path.win32.resolve(root), path.win32.resolve(candidate));
  return relative !== "" && !relative.startsWith("..") && !path.win32.isAbsolute(relative);
}
function resolveFilePath(batch, file) {
  if (!file) throw new Error("Batch file is missing");
  if (batch.storageVersion !== 2) return file.absolutePath || (path.isAbsolute(file.storagePath) ? file.storagePath : path.join(ROOT, file.storagePath));
  if (file.sourceType === "nas") {
    const source = file.absolutePath || file.storagePath;
    if (typeof batch.nasPath !== "string" || !source || !isInsideNasRoot(batch.nasPath, source)) throw new Error("NAS source escapes the Batch claim");
    return source;
  }
  return resolveStoredWorkspaceFile(ROOT, batchDirFor(batch), file.storagePath);
}
const ACTIVE_BATCH_STATUSES = new Set(["analyzing_reference", "creating_proxies", "detecting_products", "editing", "revising"]);
const RUNNABLE_BATCH_STATUSES = new Set(["reference_queued", "analyzing_reference", "creating_proxies", "detecting_products", "regroup_queued", "batch_queued", "editing", "revision_queued", "revising"]);
const CODEX_DEPENDENT_BATCH_STATUSES = new Set(["reference_queued", "analyzing_reference", "detecting_products", "regroup_queued", "batch_queued", "editing", "revision_queued", "revising"]);

async function validateProductSource(batch, batchDir, file) {
  const videoPath = resolveFilePath(batch, file);
  // This flag is deliberately off by default. When explicitly enabled it uses
  // the existing Validator entry point; ShotPool remains separately gated.
  if (!isArtifactGateEnabled()) return validateVideo(videoPath, { ffmpeg: FFMPEG });
  return validateWithArtifactGate({
    videoPath,
    batchId: batch.id,
    batchDir,
    source: { id: file.id, name: file.name },
    ffmpeg: FFMPEG,
  });
}

function productFileForVideo(batch, videoPath) {
  return batch.files.find((file) => file.kind === "products" && resolveFilePath(batch, file) === videoPath)
    || { id: videoPath, name: path.basename(videoPath), storagePath: videoPath, absolutePath: videoPath };
}

async function pauseForArtifactReview(batch, reviews) {
  await update(batch.id, (item) => {
    item.status = "failed";
    item.progress = 40;
    item.error = `Artifact Gate 有 ${reviews.length} 条素材需要人工审核；未审核素材不会进入 ShotPool。`;
    item.renderingLabel = "等待人工处理";
    item.lastWorkerActivityAt = new Date().toISOString();
  });
  return { artifactReviewRequired: true, reviews: reviews.length };
}

async function validateBatchProductFiles(batch, batchDir, labelFor) {
  const validationResults = [];
  const productFiles = batch.files.filter((file) => file.kind === "products");
  for (const [index, file] of productFiles.entries()) {
    await throwIfCanceled(batch.id);
    await update(batch.id, (item) => {
      item.renderingLabel = labelFor(index, productFiles.length);
      item.lastWorkerActivityAt = new Date().toISOString();
    });
    const videoPath = resolveFilePath(batch, file);
    validationResults.push({ videoPath, result: await validateProductSource(batch, batchDir, file) });
  }
  return validationResults;
}

function legacyTransitionProfileForBatch(batch) {
  // New modes never delegate transition choices to the legacy profile. Missing
  // transitionMode identifies a historical task and intentionally keeps its
  // previous behaviour unchanged.
  if (batch.transitionMode === "standard" || batch.transitionMode === "template_transition") return "hard_cut";
  return batch.transitionProfile || "template";
}

async function analyzeSelectedTemplateTransitions(batch) {
  if (batch.transitionMode !== "template_transition") return null;
  const batchDir = batchDirFor(batch);
  const editDir = path.join(batchDir, "edit");
  const outputPath = path.join(editDir, "transition-plan.v1.json");
  await mkdir(editDir, { recursive: true });
  try {
    const templates = await readJson(TEMPLATE_STORE, []);
    const template = templates.find((item) => item.id === batch.templateId);
    if (!template?.file) throw new Error("未找到已选母版的原始模板视频");
    const templateDir = templateWorkspacePath(ROOT, template);
    const templatePath = resolveStoredWorkspaceFile(ROOT, templateDir, template.file.storagePath);
    await update(batch.id, (item) => {
      item.renderingLabel = "正在只读分析母版动态转场";
      item.lastWorkerActivityAt = new Date().toISOString();
    });
    const plan = await analyzeTemplateTransitions({
      ffmpeg: FFMPEG,
      templateId: template.id,
      templatePath,
      templateDirectory: templateDir,
      outputPath,
    });
    if (plan.status !== "ready") {
      await update(batch.id, (item) => {
        item.renderingLabel = "母版转场分析失败，已降级为硬切";
        item.lastWorkerActivityAt = new Date().toISOString();
      });
    }
    return plan;
  } catch (error) {
    const diagnostic = `母版转场分析失败，已降级为硬切：${error instanceof Error ? error.message : String(error)}`;
    // This is intentionally non-fatal: never allow optional transition
    // analysis to enter queue retry/recovery or block normal production.
    await writeFallbackTransitionPlan({
      templateId: batch.templateId || "unknown-template",
      templatePath: "storage/templates/<templateId>/",
      outputPath,
      diagnostic,
    }).catch(() => undefined);
    await update(batch.id, (item) => {
      item.renderingLabel = "母版转场分析失败，已降级为硬切";
      item.lastWorkerActivityAt = new Date().toISOString();
    }).catch(() => undefined);
    return null;
  }
}

function legacyStage(status) {
  const labels = {
    reference_queued: "参考样片分析",
    analyzing_reference: "参考样片分析",
    creating_proxies: "素材代理生成",
    detecting_products: "产品识别",
    regroup_queued: "产品重新分组",
    batch_queued: "质量检测",
    editing: "自动剪辑",
    revision_queued: "修改准备",
    revising: "修改渲染",
  };
  return labels[status] || String(status || "未知阶段");
}

async function captureLegacyFailure(batch, error, stage = legacyStage(batch.status), context = {}) {
  const activeContext = failureContext || {};
  await recordBatchFailure({
    root: ROOT,
    batchId: batch.id,
    service: activeContext.service || "Legacy Worker",
    stage,
    workerInstance: activeContext.workerInstance || WORKER_INSTANCE,
    error,
    context: { batchStatus: batch.status, ...activeContext.context, ...context },
  }).catch(() => undefined);
}

async function isCanceled(id) {
  try { await access(await cancelFlagFor(id)); return true; } catch { return false; }
}

async function throwIfCanceled(id) {
  if (await isCanceled(id)) throw new CanceledError();
}

async function resumeRecoveryIfNeeded(batch) {
  const state = await readRecoveryState(ROOT, batch.id);
  if (state.state !== "recovering") return true;
  if (!isRetryDue(state)) return false;
  await markRecoveryRetryReady({ root: ROOT, batchId: batch.id, stage: batch.status });
  await update(batch.id, (item) => {
    item.renderingLabel = "恢复等待结束，正在重新执行当前阶段";
    item.lastWorkerActivityAt = new Date().toISOString();
  });
  return true;
}

async function markBusinessRecoveryIfProven(batch) {
  const recovery = await readRecoveryState(ROOT, batch.id);
  if (recovery.state !== "retry_ready") return;
  const current = (await readBatches()).find((item) => item.id === batch.id);
  if (!current || ["failed", "canceled", "cancel_requested"].includes(current.status)) return;
  const stageAdvanced = current.status !== batch.status || Number(current.progress || 0) > Number(batch.progress || 0);
  await markRecoverySucceeded({
    root: ROOT,
    batchId: batch.id,
    stage: current.status,
    evidence: stageAdvanced ? "阶段状态已推进" : "Worker 已成功完成当前阶段调用",
  });
  await update(batch.id, (item) => {
    item.recoveryAttempts = 0;
    item.error = undefined;
    item.renderingLabel = stageAdvanced ? "业务恢复成功，阶段已推进" : "业务恢复成功，当前阶段已继续执行";
    item.lastWorkerActivityAt = new Date().toISOString();
  });
}

async function recoverOrEscalate(batch, error) {
  const current = (await readBatches()).find((item) => item.id === batch.id) || batch;
  const message = error instanceof Error ? error.message : String(error);
  const classification = classifyRecoveryError(error);
  const attempts = (current.recoveryAttempts || 0) + 1;
  await captureLegacyFailure(current, error, legacyStage(current.status), { recoveryAttempt: attempts, recoverable: classification.recoverable });
  if (classification.category === "business") {
    await markManualRequired({ root: ROOT, batchId: batch.id, stage: current.status, message });
    await update(batch.id, (item) => {
      item.status = "failed";
      item.recoveryAttempts = current.recoveryAttempts || 0;
      item.error = message;
      item.renderingLabel = "等待人工处理";
      item.lastWorkerActivityAt = new Date().toISOString();
    });
    return;
  }
  if (classification.category === "fatal") {
    await markFatalFailure({ root: ROOT, batchId: batch.id, stage: current.status, message });
    await update(batch.id, (item) => {
      item.status = "failed";
      item.error = message;
      item.renderingLabel = "任务失败";
      item.lastWorkerActivityAt = new Date().toISOString();
    });
    return;
  }
  const attemptLimit = recoveryAttemptLimit(classification);
  if (!classification.recoverable || attempts >= attemptLimit) {
    const manualMessage = classification.kind === "codex_inactivity"
      ? codexInactivityManualMessage()
      : (!classification.recoverable ? message : `自动恢复已连续尝试${attemptLimit}次仍未成功：${message}`);
    await markManualRequired({ root: ROOT, batchId: batch.id, stage: current.status, message: manualMessage });
    await update(batch.id, (item) => {
      item.status = "failed";
      item.error = manualMessage;
      item.renderingLabel = "等待人工处理";
      item.lastWorkerActivityAt = new Date().toISOString();
    });
    return;
  }
  await scheduleRecovery({ root: ROOT, batchId: batch.id, attempt: attempts, stage: current.status, classification, message });
  await update(batch.id, (item) => {
    // Keep the in-flight stage. Checkpoint files decide the exact resume point.
    item.status = current.status;
    item.recoveryAttempts = attempts;
    item.error = undefined;
    item.renderingLabel = `自动恢复中：${classification.label}，第${attempts}次尝试`;
    item.lastWorkerActivityAt = new Date().toISOString();
  });
}

async function recoverCodexConnection(batch) {
  const state = await readRecoveryState(ROOT, batch.id);
  if (state.state === "recovering" && !isRetryDue(state)) return;
  const attempts = state.state === "recovering" ? Number(state.attempts || 0) + 1 : (batch.recoveryAttempts || 0) + 1;
  if (attempts > MAX_RECOVERY_ATTEMPTS) {
    const message = `Codex 连续重连${MAX_RECOVERY_ATTEMPTS}次仍未恢复`;
    await markManualRequired({ root: ROOT, batchId: batch.id, stage: batch.status, message });
    await update(batch.id, (item) => { item.status = "failed"; item.error = message; item.renderingLabel = "等待人工处理"; item.lastWorkerActivityAt = new Date().toISOString(); });
    return;
  }
  const classification = classifyRecoveryError(new Error("Codex disconnect"));
  await captureLegacyFailure(batch, new Error("Codex disconnect"), legacyStage(batch.status), { recoveryAttempt: attempts, recoverable: true });
  await scheduleRecovery({ root: ROOT, batchId: batch.id, attempt: attempts, stage: batch.status, classification, message: "Codex disconnect" });
  await update(batch.id, (item) => {
    item.recoveryAttempts = attempts;
    item.error = undefined;
    item.renderingLabel = `自动恢复中：正在重新连接 Codex，第${attempts}次尝试`;
    item.lastWorkerActivityAt = new Date().toISOString();
  });
}

function describeTurnEvent(event) {
  if (event?.type === "thread.started") return "线程已创建";
  if (event?.type === "turn.started") return "开始执行";
  if (event?.type === "turn.completed") return "执行完成";
  if (event?.type === "turn.failed") return "执行失败";
  if (event?.type === "error") return "SDK 返回错误";
  if (!event?.type?.startsWith("item.")) return "收到 SDK 事件";
  const item = event.item || {};
  const status = item.status === "in_progress" ? "进行中" : item.status === "failed" ? "失败" : "完成";
  const labels = {
    agent_message: "生成回复",
    reasoning: "推理",
    command_execution: "执行命令",
    file_change: "写入文件",
    mcp_tool_call: "调用工具",
    web_search: "检索",
    todo_list: "更新计划",
    error: "报告错误",
  };
  return `${labels[item.type] || "处理项目"}${item.status ? `（${status}）` : ""}`;
}

async function runTurn(thread, batchId, prompt, options = {}) {
  const {
    updateBatch = (change) => update(batchId, change),
    isBatchCanceled = () => isCanceled(batchId),
    timeoutMs = TURN_TIMEOUT_MS,
    activityPersistMs = TURN_ACTIVITY_PERSIST_MS,
    runtimeRoot = ROOT,
    codexService = failureContext?.service || "legacy",
    codexSlotId,
    queueLeaseId,
    ...turnOptions
  } = options;
  const turnId = crypto.randomUUID();
  const controller = new AbortController();
  let timedOut = false;
  let timeoutError = null;
  let activityWriteInFlight = false;
  let activityWrite = Promise.resolve();
  let lastPersistedAt = 0;
  let eventCount = 0;
  let lastEventAt = Date.now();
  let lastEventType = "turn.starting";
  let lastEventSummary = "已启动，等待 Codex 事件";
  let timeoutTimer;
  let rejectInactivity;
  let turnInvalidated = false;
  let started = false;

  const turnContext = () => ({
    timeoutMs,
    eventCount,
    lastEventAt: new Date(lastEventAt).toISOString(),
    lastEventType,
    lastEventSummary,
    threadId: thread.id || undefined,
    turnId,
  });

  await recordCodexTurnStart({ root: runtimeRoot, turnId, threadId: thread.id || undefined, taskKey: batchId, service: codexService, slotId: codexSlotId, queueLeaseId }).catch(() => undefined);

  const writeActivity = async ({ throwOnFailure = false } = {}) => {
    if (turnInvalidated) return;
    if (activityWriteInFlight) return activityWrite;
    activityWriteInFlight = true;
    const write = Promise.resolve(updateBatch((item) => {
      // A timed-out turn can settle after a replacement worker has begun.
      // Only its owner may update the Batch; all later events are ignored.
      if (started && item.codexTurn?.turnId && item.codexTurn.turnId !== turnId) return;
      const context = turnContext();
      item.lastWorkerActivityAt = context.lastEventAt;
      item.renderingLabel = `智能剪辑：${context.lastEventSummary}`;
      item.codexTurn = { state: "running", turnId, startedAt: item.codexTurn?.startedAt || new Date().toISOString(), ...context };
    }));
    activityWrite = write.catch((error) => {
      if (throwOnFailure) throw error;
    }).finally(() => { activityWriteInFlight = false; });
    return activityWrite;
  };

  const armInactivityTimer = () => {
    clearTimeout(timeoutTimer);
    timeoutTimer = setTimeout(() => {
      if (timedOut) return;
      timedOut = true;
      turnInvalidated = true;
      timeoutError = new TurnTimeoutError(turnContext());
      // Persist an invalid token before the queue lease is released. This
      // fences late SDK events from this stale turn after a retry is claimed.
      void Promise.resolve(updateBatch((item) => {
        if (item.codexTurn?.turnId && item.codexTurn.turnId !== turnId) return;
        item.lastWorkerActivityAt = new Date().toISOString();
        item.renderingLabel = "Codex SDK 无事件，正在终止当前 Turn";
        item.codexTurn = {
          state: "timed_out",
          timedOutAt: new Date().toISOString(),
          ...turnContext(),
          turnId: `${turnId}:expired`,
        };
      })).catch(() => undefined);
      controller.abort();
      rejectInactivity(timeoutError);
    }, timeoutMs);
  };

  const noteActivity = (event) => {
    lastEventAt = Date.now();
    eventCount += 1;
    lastEventType = event?.type || "unknown";
    lastEventSummary = describeTurnEvent(event);
    void recordCodexSdkEvent({ root: runtimeRoot, turnId, event }).catch(() => undefined);
    armInactivityTimer();
    if (lastEventAt - lastPersistedAt >= activityPersistMs) {
      lastPersistedAt = lastEventAt;
      void writeActivity();
    }
  };

  await writeActivity({ throwOnFailure: true });
  started = true;
  lastPersistedAt = Date.now();
  armInactivityTimer();
  const cancelTimer = setInterval(() => {
    Promise.resolve(isBatchCanceled()).then((canceled) => {
      if (canceled) controller.abort();
    }).catch(() => undefined);
  }, 750);
  const inactivityPromise = new Promise((_, reject) => { rejectInactivity = reject; });

  const consumeTurn = async () => {
    const { events } = await thread.runStreamed(`${GC_SKILL_DIRECTIVE}\n\n${prompt}`, { ...turnOptions, signal: controller.signal });
    const items = [];
    let finalResponse = "";
    let usage = null;
    let failure = null;
    let completed = false;
    for await (const event of events) {
      noteActivity(event);
      if (event.type === "item.completed") {
        if (event.item?.type === "agent_message") finalResponse = event.item.text;
        items.push(event.item);
      } else if (event.type === "turn.completed") {
        usage = event.usage;
        completed = true;
      } else if (event.type === "turn.failed") {
        failure = event.error;
        break;
      } else if (event.type === "error") {
        failure = event.error || { message: event.message || "Codex SDK stream error." };
        break;
      }
    }
    if (timedOut) throw timeoutError;
    if (failure) throw turnFailedError(failure, turnContext());
    if (!completed) throw new ExecutorIncompleteError(turnContext());
    return { items, finalResponse, usage };
  };

  const turnPromise = consumeTurn();
  // AbortSignal is passed to the SDK so its Codex process is terminated. Keep a
  // rejection handler attached in case a broken SDK process settles after the
  // service has already released the task lease following an inactivity timeout.
  turnPromise.catch(() => undefined);
  try {
    const result = await Promise.race([turnPromise, inactivityPromise]);
    await Promise.resolve(updateBatch((item) => {
      if (item.codexTurn?.turnId && item.codexTurn.turnId !== turnId) return;
      item.codexTurn = { ...item.codexTurn, state: "completed", turnId, completedAt: new Date().toISOString() };
    })).catch(() => undefined);
    await recordCodexTurnCompleted({ root: runtimeRoot, turnId }).catch(() => undefined);
    return result;
  } catch (error) {
    if (await isBatchCanceled()) {
      await recordCodexTurnFailure({ root: runtimeRoot, turnId, kind: "canceled", message: "Batch canceled" }).catch(() => undefined);
      throw new CanceledError();
    }
    const classification = classifyRecoveryError(error);
    const diagnostic = codexErrorDiagnostic(error, turnContext());
    if (error && typeof error === "object" && !error.codexTurn) {
      try { error.codexTurn = turnContext(); } catch {}
    }
    await recordCodexTurnFailure({
      root: runtimeRoot,
      turnId,
      kind: timedOut ? "codex_inactivity" : classification.kind,
      failureClass: timedOut ? "inactivity_timeout" : classification.failureClass,
      message: error instanceof Error ? error.message : String(error),
      diagnostic,
    }).catch(() => undefined);
    if (timedOut) throw timeoutError || new TurnTimeoutError(turnContext());
    throw error;
  } finally {
    clearInterval(cancelTimer);
    clearTimeout(timeoutTimer);
    await activityWrite;
  }
}

const profileSchema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    duration_seconds: { type: "number" },
    aspect_ratio: { type: "string" },
    pace: { type: "string" },
    color: { type: "string" },
    hook_style: { type: "string" },
    caption_safe_zone: { type: "string" },
    cvr_style: { type: "string" },
    hook_text: { type: "string" },
    cvr_text: { type: "string" },
    audio_style: { type: "string" },
    fixed_rules: { type: "array", items: { type: "string" } },
    structure: {
      type: "array",
      items: {
        type: "object",
        properties: {
          timeline: { type: "string" },
          purpose: { type: "string" },
          shot_type: { type: "string" },
          weight: { type: "number" },
        },
        required: ["timeline", "purpose", "shot_type", "weight"],
        additionalProperties: false,
      },
    },
    transition_plan: {
      type: "object",
      properties: {
        enabled: { type: "boolean" },
        reason: { type: "string" },
        placements: {
          type: "array",
          maxItems: 2,
          items: {
            type: "object",
            properties: {
              after_slot: { type: "string", enum: ["hook", "outfit_interest", "front_reason", "sleeve_fabric_reason"] },
              effect: { type: "string", enum: ["fade", "fadeblack", "dissolve", "wipeleft", "wiperight", "slideleft", "slideright", "pixelize"] },
              duration_seconds: { type: "number", minimum: 0.06, maximum: 0.2 },
            },
            required: ["after_slot", "effect", "duration_seconds"],
            additionalProperties: false,
          },
        },
      },
      required: ["enabled", "reason", "placements"],
      additionalProperties: false,
    },
    confidence: { type: "number" },
  },
  required: ["summary", "duration_seconds", "aspect_ratio", "pace", "color", "hook_style", "caption_safe_zone", "cvr_style", "hook_text", "cvr_text", "audio_style", "fixed_rules", "structure", "transition_plan", "confidence"],
  additionalProperties: false,
};

const productDetectionSchema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    groups: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          label: { type: "string" },
          signature: { type: "string" },
          confidence: { type: "number" },
          files: { type: "array", items: { type: "string" } },
          notes: { type: "string" },
        },
        required: ["id", "label", "signature", "confidence", "files", "notes"],
        additionalProperties: false,
      },
    },
    unassigned: { type: "array", items: { type: "string" } },
    confidence: { type: "number" },
  },
  required: ["summary", "groups", "unassigned", "confidence"],
  additionalProperties: false,
};

async function readBatches() {
  return readJson(STORE, []);
}

async function accountReady() {
  const state = await readJson(ACCOUNT_STATE, null);
  return Boolean(state && state.authenticationValid !== false && (state.ready === true || state.apiReady === true));
}

async function writeBatches(batches) {
  await writeJsonAtomic(STORE, batches);
}

async function update(id, change) {
  if (leaseGuard && !(await leaseGuard())) throw new Error("Lease lost; refusing batch write");
  return withFileLock(STORE, async () => {
    const batches = await readBatches();
    const index = batches.findIndex((batch) => batch.id === id);
    if (index < 0) throw new Error("Batch not found");
    change(batches[index]);
    batches[index].updatedAt = new Date().toISOString();
    await writeBatches(batches);
    return batches[index];
  });
}

function createThread(batch) {
  const codex = createCodexClient();
  const batchDir = batchDirFor(batch);
  const options = {
    // This is a hard tenant boundary for every Codex turn. Do not use the
    // project root or another account's workspace as an additional directory.
    workingDirectory: batchDir,
    skipGitRepoCheck: true,
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
    modelReasoningEffort: "high",
  };
  // Batch files are the source of truth. Always start a fresh thread so a
  // queued job survives a Codex account switch or an inaccessible old thread.
  return codex.startThread(options);
}

function runFfmpeg(args, batchId) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, args, { windowsHide: true });
    let stderr = "";
    let canceled = false;
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(Object.assign(new Error(`分析代理生成超过 ${Math.round(FFMPEG_TIMEOUT_MS / 60000)} 分钟无响应`), {
        code: "PROCESS_TIMEOUT",
        ...(stderr ? { stderr } : {}),
        command: [FFMPEG, ...args].map((value) => String(value)).join(" "),
      }));
    }, FFMPEG_TIMEOUT_MS);
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setInterval(async () => {
      if (await isCanceled(batchId)) {
        canceled = true;
        child.kill("SIGTERM");
      }
    }, 750);
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      clearTimeout(timeout);
      reject(Object.assign(error, { ...(stderr ? { stderr } : {}), command: [FFMPEG, ...args].map((value) => String(value)).join(" ") }));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      clearTimeout(timeout);
      if (canceled) return reject(new CanceledError());
      if (code === 0) return resolve();
      reject(Object.assign(new Error(`分析代理生成失败（ffmpeg ${code}）${stderr ? `：${stderr}` : ""}`), { exitCode: code, ...(stderr ? { stderr } : {}), command: [FFMPEG, ...args].map((value) => String(value)).join(" ") }));
    });
  });
}

const normalizedRelativePath = (value) => String(value || "").replaceAll("/", "\\").replace(/^\\+/, "").toLocaleLowerCase("zh-CN");

function relativeProductFolder(value) {
  const parts = String(value || "").replaceAll("\\", "/").split("/").filter(Boolean);
  return parts.length > 1 ? parts[0] : null;
}

function productReferenceForGroup(group, productReferenceFiles) {
  const candidates = Array.isArray(productReferenceFiles) ? productReferenceFiles : [];
  const declared = Array.isArray(group.productReferenceFiles) ? group.productReferenceFiles : [];
  for (const source of declared) {
    const matched = candidates.find((file) => normalizedRelativePath(file.relativePath) === normalizedRelativePath(source));
    if (matched) return matched;
  }
  const notes = normalizedRelativePath(group.notes).replaceAll("\\", "");
  const noted = candidates.find((file) => {
    const relativePath = normalizedRelativePath(file.relativePath).replaceAll("\\", "");
    const fileName = normalizedRelativePath(path.basename(file.relativePath || file.name)).replaceAll("\\", "");
    return notes.includes(relativePath) || notes.includes(fileName);
  });
  if (noted) return noted;
  const folder = group.sourceFolder || relativeProductFolder(group.files?.[0]);
  if (folder) {
    const matched = candidates.find((file) => relativeProductFolder(file.relativePath)?.toLocaleLowerCase("zh-CN") === folder.toLocaleLowerCase("zh-CN"));
    if (matched) return matched;
  }
  const groupId = normalizedRelativePath(group.id).replaceAll("\\", "");
  const named = candidates.find((file) => {
    const fileName = normalizedRelativePath(path.basename(file.relativePath || file.name)).replaceAll("\\", "");
    return fileName === groupId || [".", "_", "-", " "].some((separator) => fileName.startsWith(`${groupId}${separator}`));
  });
  return named || (candidates.length === 1 ? candidates[0] : null);
}

export function buildGroupEvidenceSnapshot(groups, productFiles, productReferenceFiles, generatedAt = new Date().toISOString()) {
  return {
    schemaVersion: 1,
    generatedAt,
    groups: (Array.isArray(groups) ? groups : []).map((group) => {
      const video = (Array.isArray(productFiles) ? productFiles : []).find((file) => group.files?.some((source) => normalizedRelativePath(source) === normalizedRelativePath(file.relativePath)));
      const productImage = productReferenceForGroup(group, productReferenceFiles);
      return {
        groupId: group.id,
        label: group.label,
        video: video ? { relativePath: video.relativePath } : null,
        productImage: productImage ? { relativePath: productImage.relativePath } : null,
      };
    }),
  };
}

function cacheEvidenceJpeg(input, output, kind) {
  return new Promise((resolve, reject) => {
    const args = kind === "video"
      ? ["-hide_banner", "-loglevel", "error", "-y", "-ss", "00:00:01", "-i", input, "-frames:v", "1", "-vf", "scale=320:-2", "-q:v", "4", output]
      : ["-hide_banner", "-loglevel", "error", "-y", "-i", input, "-frames:v", "1", "-vf", "scale=320:-2", "-q:v", "4", output];
    const child = spawn(FFMPEG, args, { windowsHide: true });
    let stderr = "";
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error("生成分组证据缩略图超时"));
    }, GROUP_EVIDENCE_TIMEOUT_MS);
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", finish);
    child.on("close", (code) => {
      if (code === 0) finish();
      else finish(new Error(`生成分组证据缩略图失败（ffmpeg ${code}）${stderr ? `：${stderr.trim()}` : ""}`));
    });
  });
}

export async function cacheManualGroupingEvidence(batch, batchDir, groups, productFiles, productReferenceFiles) {
  const snapshot = buildGroupEvidenceSnapshot(groups, productFiles, productReferenceFiles);
  const evidenceDir = path.join(batchDir, "group-evidence");
  if (existsSync(FFMPEG)) {
    await mkdir(evidenceDir, { recursive: true });
    for (const [index, group] of snapshot.groups.entries()) {
      const prefix = `group-${String(index + 1).padStart(3, "0")}`;
      const originalVideo = group.video && productFiles.find((file) => normalizedRelativePath(file.relativePath) === normalizedRelativePath(group.video.relativePath));
      const originalImage = group.productImage && productReferenceFiles.find((file) => normalizedRelativePath(file.relativePath) === normalizedRelativePath(group.productImage.relativePath));
      if (originalVideo) {
        const relativeThumbnail = path.posix.join("group-evidence", `${prefix}-video.jpg`);
        await cacheEvidenceJpeg(resolveFilePath(batch, originalVideo), path.join(batchDir, relativeThumbnail), "video")
          .then(() => { group.video.thumbnailPath = relativeThumbnail; })
          .catch((error) => console.warn(`[group-evidence] ${batch.id}/${group.groupId} video thumbnail unavailable: ${error.message}`));
      }
      if (originalImage) {
        const relativeThumbnail = path.posix.join("group-evidence", `${prefix}-product.jpg`);
        await cacheEvidenceJpeg(resolveFilePath(batch, originalImage), path.join(batchDir, relativeThumbnail), "image")
          .then(() => { group.productImage.thumbnailPath = relativeThumbnail; })
          .catch((error) => console.warn(`[group-evidence] ${batch.id}/${group.groupId} product-image thumbnail unavailable: ${error.message}`));
      }
    }
  }
  await writeJsonAtomic(path.join(batchDir, GROUP_EVIDENCE_FILE), snapshot);
  return snapshot;
}

async function createReadOnlyNasVideoProxy({ batchId, sourcePath, outputPath }) {
  if (!existsSync(FFMPEG)) throw new Error(`找不到视频代理工具：${FFMPEG}`);
  // Windows FFmpeg installations can reject a UNC input even when the Worker
  // account is authorized to read it. Copy only this Batch's declared source
  // to a short-lived local input, transcode the proxy, then remove that input.
  // Codex receives only the final proxy and never gains NAS access.
  const inputExtension = path.extname(sourcePath) || ".media";
  const localInput = `${outputPath}.source-${crypto.randomUUID()}${inputExtension}`;
  await mkdir(path.dirname(outputPath), { recursive: true });
  try {
    await copyFile(sourcePath, localInput);
    await runFfmpeg([
      "-hide_banner", "-loglevel", "error", "-y", "-i", localInput,
      "-vf", "scale=540:-2,fps=6", "-an", "-c:v", "mpeg4", "-q:v", "18",
      "-movflags", "+faststart", outputPath,
    ], batchId);
  } finally {
    await rm(localInput, { force: true }).catch(() => {});
  }
}

async function createAnalysisProxies(batch, { status = "creating_proxies", progressStart = 25, progressSpan = 7 } = {}) {
  const nasFiles = batch.files.filter((file) => file.kind === "products" && file.sourceType === "nas");
  if (!nasFiles.length) return batch;
  if (!existsSync(FFMPEG)) throw new Error(`找不到视频代理工具：${FFMPEG}`);
  await throwIfCanceled(batch.id);
  await update(batch.id, (item) => {
    if (status) item.status = status;
    item.progress = progressStart;
    item.error = undefined;
  });
  const proxyDir = path.join(batchDirFor(batch), "proxies");
  await mkdir(proxyDir, { recursive: true });

  for (let index = 0; index < nasFiles.length; index += 1) {
    await throwIfCanceled(batch.id);
    const file = nasFiles[index];
    const output = path.join(proxyDir, `${file.id}.mp4`);
    const existing = await stat(output).catch(() => null);
    if (!existing?.size) await createReadOnlyNasVideoProxy({ batchId: batch.id, sourcePath: resolveFilePath(batch, file), outputPath: output });
    const proxyPath = path.relative(ROOT, output);
    await update(batch.id, (item) => {
      const record = item.files.find((candidate) => candidate.id === file.id);
      if (record) record.proxyPath = proxyPath;
      item.progress = progressStart + Math.round(((index + 1) / nasFiles.length) * progressSpan);
    });
  }
  const refreshed = (await readBatches()).find((item) => item.id === batch.id);
  return refreshed || batch;
}

function fallbackHardCutTransitionPlan() {
  return {
    schema_version: "transition-plan.v1",
    status: "fallback_hard_cut",
    diagnostic: "历史样片未记录可复用 transition_plan；本批次已明确降级为硬切。",
    applied: { enabled: false, reason: "历史样片未记录可复用 transition_plan，已降级为硬切", placements: [] },
  };
}

async function prepareEditWorkspaceContext(batch, batchDir, profile, hook, cvr, { root = ROOT } = {}) {
  const editDir = path.join(batchDir, "edit");
  await mkdir(editDir, { recursive: true });
  const products = [];
  for (const file of batch.files.filter((item) => item.kind === "products")) {
    const originalPath = resolveFilePath(batch, file);
    let proxyPath = null;
    if (file.sourceType === "nas") {
      if (!file.proxyPath) throw editPlanPrerequisiteError(`NAS 素材尚未生成本地代理：${file.relativePath || file.name}`);
      const resolvedProxy = resolveStoredWorkspaceFile(root, batchDir, file.proxyPath);
      const relativeProxy = path.relative(batchDir, resolvedProxy);
      if (!relativeProxy || relativeProxy.startsWith("..") || path.isAbsolute(relativeProxy)) throw editPlanPrerequisiteError(`NAS 代理越出当前 Batch workspace：${file.relativePath || file.name}`);
      const info = await stat(resolvedProxy).catch(() => null);
      if (!info?.isFile() || !info.size) throw editPlanPrerequisiteError(`NAS 素材本地代理不可读：${file.relativePath || file.name}`);
      proxyPath = relativeProxy.replaceAll("\\", "/");
    }
    products.push({
      file_id: file.id,
      source_name: file.relativePath || file.name,
      source_original: originalPath,
      ...(proxyPath ? { proxy_path: proxyPath } : {}),
    });
  }
  const transition = profile?.transition_plan
    ? { schema_version: "transition-plan.v1", status: "recorded", applied: profile.transition_plan }
    : fallbackHardCutTransitionPlan();
  const context = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    purpose: "Codex 可读的本地剪辑上下文；NAS 仅由 Worker 只读访问。",
    hook_text: hook.text,
    cvr_text: cvr.text,
    transition_plan: transition,
    product_groups_path: "../product-groups.json",
    reference_profile_path: "../reference-profile.json",
    products,
  };
  await writeJsonAtomic(path.join(editDir, "analysis-context.v1.json"), context);
  return context;
}

async function analyzeReference(batch) {
  await throwIfCanceled(batch.id);
  await update(batch.id, (item) => { item.status = "analyzing_reference"; item.progress = 18; item.error = undefined; });
  const batchDir = batchDirFor(batch);
  const savedProfile = await readJson(path.join(batchDir, "reference-profile.json"), null);
  if (savedProfile) {
    await update(batch.id, (item) => { item.progress = 24; item.referenceProfile = savedProfile; item.renderingLabel = "已恢复样片分析结果，继续产品识别"; });
    await analyzeSelectedTemplateTransitions(batch);
    return detectProducts({ ...batch, referenceProfile: savedProfile });
  }
  const reference = batch.files.find((file) => file.kind === "reference");
  const thread = createThread(batch);
  const transitionInstruction = batch.transitionMode === undefined
    ? `转场检测必须逐个切点检查视觉证据：普通硬切、自然运镜延续和单纯BGM卡点都不是特殊转场。仅当样片明确使用短暂视觉转场时，才在 transition_plan 中 enabled=true；最多复刻2个，时长只能是0.06–0.20秒，且只能使用 Schema 提供的 effect。不能稳定复刻或没有明确特殊转场时，必须 enabled=false、placements=[]，并在 reason 中说明；绝不可为了“更炫”自行添加转场。`
    : `当前批次不使用旧版 transition_plan。不要分析 Zoom Blur、Directional Blur、RGB Split、Stretch 或其他复杂动态转场；transition_plan 必须返回 enabled=false、placements=[]，reason 写明“由剪辑模式控制”。`;
  const prompt = `使用已安装的 video-use 技能。先只分析样片，不开始剪产品素材。

样片绝对路径：${resolveFilePath(batch, reference)}
批次目录：${batchDir}
已确认的优秀视频标准：${GOLD_STANDARD}
全批统一要求：\n${batch.requirements}

请用视频工具逐段识别样片，提取：时间结构、镜头类型、剪辑节奏、转场、色彩倾向、Hook文字样式和安全区、CVR布局、音乐与卡点规律。逐字记录画面中实际出现的 Hook 与 CVR 文字，分别写入 hook_text 与 cvr_text；没有可确认文字时必须返回空字符串。母版不得低于已确认标准：1秒内清楚看到服装；画面前后色调一致且有氛围；运镜稳定不抖；主要切点贴合BGM；同时包含整体上身和衣服细节；镜头持续聚焦衣服；结构遵循停留、兴趣、价值、转化。必须明确哪些规则需要对整批产品固定。

${transitionInstruction}
返回符合JSON Schema的母版配置。`;
  const result = await runTurn(thread, batch.id, prompt, { outputSchema: profileSchema });
  const profile = JSON.parse(result.finalResponse);
  await mkdir(batchDir, { recursive: true });
  await writeFile(path.join(batchDir, "reference-profile.json"), JSON.stringify(profile, null, 2), "utf8");
  await update(batch.id, (item) => { item.progress = 24; item.referenceProfile = profile; item.threadId = thread.id || item.threadId; });
  await analyzeSelectedTemplateTransitions(batch);
  await detectProducts({ ...batch, referenceProfile: profile, threadId: thread.id || batch.threadId }, thread);
}

async function detectProducts(batch, activeThread = null, correction = "") {
  await throwIfCanceled(batch.id);
  await update(batch.id, (item) => { item.status = "detecting_products"; item.progress = 28; item.error = undefined; });
  const batchDir = batchDirFor(batch);
  const savedDetection = await readJson(path.join(batchDir, "product-groups.json"), null);
  const shouldReapplyGroupingRules = batch.status === "regroup_queued" || Boolean(correction);
  if (Array.isArray(savedDetection?.groups) && !shouldReapplyGroupingRules) {
    const autoApproved = savedDetection.autoApproved === true && savedDetection.groupingMethod === "product_directory";
    await update(batch.id, (item) => {
      item.status = autoApproved ? "batch_queued" : "reference_ready";
      item.progress = autoApproved ? 35 : 38;
      item.productDetection = savedDetection;
      item.recoveryAttempts = 0;
      item.renderingLabel = autoApproved ? "已恢复产品文件夹分组，已进入后续队列" : "已恢复产品识别结果，等待确认";
      item.lastWorkerActivityAt = new Date().toISOString();
    });
    return;
  }
  const productFiles = batch.files.filter((file) => file.kind === "products");
  const productReferenceFiles = batch.files.filter((file) => file.kind === "product_refs");
  if (!productFiles.length) throw new Error("没有可识别的产品视频");
  const directoryDetection = shouldReapplyGroupingRules
    ? null
    : groupProductsByProductDirectory(productFiles, productReferenceFiles);
  if (directoryDetection?.isCompliant) {
    await writeFile(path.join(batchDir, "product-groups.json"), JSON.stringify(directoryDetection, null, 2), "utf8");
    await update(batch.id, (item) => {
      item.status = "batch_queued";
      item.progress = 35;
      item.productDetection = directoryDetection;
      item.recoveryAttempts = 0;
      item.renderingLabel = `已按产品文件夹确认 ${directoryDetection.groups.length} 款，跳过人工确认并进入后续队列`;
      item.lastWorkerActivityAt = new Date().toISOString();
    });
    return;
  }
  const filenameDetection = {
    ...groupProductsByFilename(productFiles),
    groupingMethod: "filename",
    autoApproved: false,
    ...(directoryDetection?.reasons?.length ? { reasons: directoryDetection.reasons } : {}),
  };
  if (filenameDetection.groups.length) {
    await writeFile(path.join(batchDir, "product-groups.json"), JSON.stringify(filenameDetection, null, 2), "utf8");
    // Evidence is advisory only. A corrupt source, inaccessible NAS asset or
    // missing ffmpeg must never prevent the established human-confirmation
    // fallback from continuing.
    await cacheManualGroupingEvidence(batch, batchDir, filenameDetection.groups, productFiles, productReferenceFiles)
      .catch((error) => console.warn(`[group-evidence] ${batch.id} unavailable: ${error.message}`));
    await update(batch.id, (item) => {
      item.status = "reference_ready";
      item.progress = 38;
      item.productDetection = filenameDetection;
      item.recoveryAttempts = 0;
      item.renderingLabel = filenameDetection.unassigned.length
        ? `已按文件名生成 ${filenameDetection.groups.length} 个 Session；${filenameDetection.unassigned.length} 条未命名素材待人工确认`
        : `已按文件名生成 ${filenameDetection.groups.length} 个产品 Session，等待确认`;
      item.lastWorkerActivityAt = new Date().toISOString();
    });
    return;
  }
  batch = await createAnalysisProxies(batch);
  const analyzedProductFiles = batch.files.filter((file) => file.kind === "products");
  const thread = activeThread || createThread(batch);
  const prior = batch.productDetection ? `\n现有分组：${JSON.stringify(batch.productDetection)}` : "";
  const correctionText = correction ? `\n团队修正要求：${correction}` : "";
  const fileList = analyzedProductFiles.map((file) => {
    const analysisPath = file.proxyPath ? resolveStoredWorkspaceFile(ROOT, batchDir, file.proxyPath) : resolveFilePath(batch, file);
    return `${file.relativePath} => 分析文件 ${analysisPath}`;
  }).join("\n");
  const referenceImageList = productReferenceFiles.length
    ? productReferenceFiles.map((file) => `${file.relativePath} => ${resolveFilePath(batch, file)}`).join("\n")
    : "未提供产品参考图";
  const prompt = `继续使用 video-use 技能。当前批次没有可用的产品编号文件名，因此使用视觉识别作为兜底，识别本次拍摄包含多少款不同服装，并把所有视频按产品归组。

对每个视频提取开头、中段、结尾关键帧，优先依据服装底色、印花文字、号码、图案位置、领口袖口、版型以及正反面对应关系判断同款。模特、景别、机位和背景不同不能被误判成不同产品。正面、背面和细节镜头应归入同一款。

视频清单：\n${fileList}
产品参考图（辅助视觉锚点）：\n${referenceImageList}
样片母版：${path.join(batchDir, "reference-profile.json")}
${prior}${correctionText}

逐张参考图提取服装底色、文字、图案、号码、领口、袖口和版型，再与每条视频的多帧外观比较。参考图只作为辅助锚点；视频与参考图视觉冲突、关键特征被遮挡或置信度不足时必须放入unassigned。为每款生成稳定ID和易读名称，列出归属视频、识别特征、置信度和需要人工关注的问题，并在notes中记录命中的参考图。返回符合JSON Schema的产品分组结果。`;
  const result = await runTurn(thread, batch.id, prompt, { outputSchema: productDetectionSchema });
  const detection = { ...JSON.parse(result.finalResponse), groupingMethod: "visual", autoApproved: false };
  await writeFile(path.join(batchDir, "product-groups.json"), JSON.stringify(detection, null, 2), "utf8");
  await cacheManualGroupingEvidence(batch, batchDir, detection.groups, productFiles, productReferenceFiles)
    .catch((error) => console.warn(`[group-evidence] ${batch.id} unavailable: ${error.message}`));
  await update(batch.id, (item) => {
    item.status = "reference_ready";
    item.progress = 38;
    item.productDetection = detection;
    item.threadId = thread.id || item.threadId;
    item.recoveryAttempts = 0;
    item.lastWorkerActivityAt = new Date().toISOString();
  });
}

async function runAnalyzeQuality(batch) {
  await throwIfCanceled(batch.id);
  const batchDir = batchDirFor(batch);
  let validationResults = [];
  await update(batch.id, (item) => { item.status = "editing"; item.progress = 40; item.renderingLabel = "分析服务：质量门禁与 ShotPool"; item.error = undefined; });
  if (isNewValidatorEnabled()) {
    validationResults = await validateBatchProductFiles(batch, batchDir, (index, total) => `分析服务：质量门禁（${index + 1}/${total}）`);
    await writeFile(path.join(batchDir, "validation-results.json"), JSON.stringify({ isolated: true, generatedAt: new Date().toISOString(), results: validationResults }, null, 2), "utf8");
  } else if (isArtifactGateEnabled()) {
    validationResults = await validateBatchProductFiles(batch, batchDir, (index, total) => `分析服务：Artifact Gate（${index + 1}/${total}）`);
    await writeFile(path.join(batchDir, "validation-results.json"), JSON.stringify({ isolated: true, generatedAt: new Date().toISOString(), results: validationResults }, null, 2), "utf8");
  }
  const artifactReviews = isArtifactGateEnabled() ? validationResults.filter((item) => item.result?.verdict === "review") : [];
  if (artifactReviews.length) return pauseForArtifactReview(batch, artifactReviews);
  if (isNewShotPoolEnabled()) {
    await update(batch.id, (item) => { item.renderingLabel = "分析服务：写入完整 ShotPool"; item.lastWorkerActivityAt = new Date().toISOString(); });
    await importBatchToShotPool({
      batch,
      batchDir,
      validate: (videoPath) => validateProductSource(batch, batchDir, productFileForVideo(batch, videoPath)),
    });
  }
  if (isSemanticShadowEnabled()) {
    await runSemanticShadow({ batch, batchDir, shotPool: await loadShotPool(batch.id, batchDir), ffmpeg: FFMPEG });
  }
}

async function markRenderQueued(batch, operation = "render") {
  await writeJsonAtomic(path.join(batchDirFor(batch), "service-stage.json"), { schemaVersion: 1, next: "render", operation, workflowVersion: Number(batch.workflowVersion) || 1, queuedAt: new Date().toISOString() });
}

function hasRecordedProfileText(profile, field) {
  return typeof profile?.[field] === "string";
}

async function resolveLegacyEditProfile(batch, batchDir) {
  const storedProfile = await readJson(path.join(batchDir, "reference-profile.json"), null);
  const profile = { ...(storedProfile || batch.referenceProfile || {}) };
  const missingText = ["hook_text", "cvr_text"].filter((field) => !hasRecordedProfileText(profile, field));
  if (!missingText.length || !batch.templateId) return profile;

  const templates = await readJson(TEMPLATE_STORE, []);
  const templateProfile = templates.find((template) => template.id === batch.templateId)?.profile;
  let changed = false;
  for (const field of missingText) {
    if (hasRecordedProfileText(templateProfile, field)) {
      profile[field] = templateProfile[field];
      changed = true;
    }
  }
  if (!changed) return profile;

  await writeFile(path.join(batchDir, "reference-profile.json"), JSON.stringify(profile, null, 2), "utf8");
  await update(batch.id, (item) => { item.referenceProfile = profile; });
  batch.referenceProfile = profile;
  return profile;
}

function recordedTextOrManualOverride(batch, profile, batchField, profileField, label) {
  const override = typeof batch[batchField] === "string" ? batch[batchField].trim() : "";
  const recorded = typeof profile?.[profileField] === "string" ? profile[profileField].trim() : "";
  const text = override || recorded;
  if (!text) {
    throw editPlanPrerequisiteError(`样片未记录可复用的 ${label} 原文，请先在任务中填写 ${label} 文案后重新开始剪辑。`);
  }
  return { text, source: override ? "manual" : "template" };
}

async function runBatchEdit(batch, { includeAnalyze = true, render = true } = {}) {
  await throwIfCanceled(batch.id);
  await update(batch.id, (item) => { item.status = "editing"; item.progress = 45; item.error = undefined; });
  const batchDir = batchDirFor(batch);
  const outputDir = path.join(batchDir, "output");
  await mkdir(outputDir, { recursive: true });
  let validationResults = [];
  if (includeAnalyze && isNewValidatorEnabled()) {
    validationResults = await validateBatchProductFiles(batch, batchDir, (index, total) => `隔离运行新质量门禁（${index + 1}/${total}）`);
    await writeFile(path.join(batchDir, "validation-results.json"), JSON.stringify({
      isolated: true,
      generatedAt: new Date().toISOString(),
      results: validationResults,
    }, null, 2), "utf8");
  } else if (includeAnalyze && isArtifactGateEnabled()) {
    validationResults = await validateBatchProductFiles(batch, batchDir, (index, total) => `隔离运行 Artifact Gate（${index + 1}/${total}）`);
    await writeFile(path.join(batchDir, "validation-results.json"), JSON.stringify({
      isolated: true,
      generatedAt: new Date().toISOString(),
      results: validationResults,
    }, null, 2), "utf8");
  }
  const artifactReviews = isArtifactGateEnabled() ? validationResults.filter((item) => item.result?.verdict === "review") : [];
  if (artifactReviews.length) return pauseForArtifactReview(batch, artifactReviews);
  if (includeAnalyze && isNewShotPoolEnabled()) {
    await update(batch.id, (item) => {
      item.renderingLabel = "隔离写入新 ShotPool";
      item.lastWorkerActivityAt = new Date().toISOString();
    });
    await importBatchToShotPool({
      batch,
      batchDir,
      validate: (videoPath) => validateProductSource(batch, batchDir, productFileForVideo(batch, videoPath)),
    });
  }
  if (includeAnalyze && isSemanticShadowEnabled()) {
    await runSemanticShadow({ batch, batchDir, shotPool: await loadShotPool(batch.id, batchDir), ffmpeg: FFMPEG });
  }
  let scheduledProducts = [];
  if (isNewSchedulerEnabled()) {
    const scriptTemplatePath = path.join(batchDir, "script-template.json");
    const scriptTemplate = await readJson(scriptTemplatePath, null);
    const productGroups = await readJson(path.join(batchDir, "product-groups.json"), null);
    if (!scriptTemplate) throw new Error("New Scheduler requires script-template.json");
    if (!Array.isArray(productGroups?.groups)) throw new Error("New Scheduler requires confirmed product-groups.json");
    const productViews = createProductViews({
      shotPool: await loadShotPool(batch.id, batchDir),
      productGroups: productGroups.groups,
    });
    scheduledProducts = productViews.map((productView) => ({
      product: productView.product,
      sourceNamesByShotId: productView.sourceNamesByShotId,
      scheduleResult: scheduleProductView({ batchId: batch.id, productView, scriptTemplate, transitionProfile: legacyTransitionProfileForBatch(batch) }),
    }));
    await writeJsonAtomic(path.join(batchDir, "schedule-result.json"), {
      isolated: true,
      batchId: batch.id,
      createdAt: new Date().toISOString(),
      products: scheduledProducts,
    });
  }
  if (isNewRendererEnabled()) {
    if (!isNewSchedulerEnabled()) throw new Error("New Renderer requires ENABLE_NEW_SCHEDULER=true");
    if (!scheduledProducts.length) throw new Error("New Renderer requires at least one Product View");
    const failed = scheduledProducts.filter(({ scheduleResult }) => scheduleResult.status === "failed");
    if (failed.length) throw new Error(`Schedule Failed: ${failed.map(({ product, scheduleResult }) => `${product.id}:${scheduleResult.slotId}`).join(", ")}`);
    if (!render) {
      await markRenderQueued(batch, "render");
      return { renderReady: true };
    }
    const refreshed = (await readBatches()).find((item) => item.id === batch.id) || batch;
    const { files, summary } = await renderBatchFromRenderPlans({
      root: ROOT,
      batch: refreshed,
      batchDir,
      ffmpeg: FFMPEG,
      scheduledProducts,
      isCanceled: () => isCanceled(batch.id),
      onProgress: async (done, total, label) => update(batch.id, (item) => {
        item.progress = 50 + Math.round((done / total) * 47);
        item.renderingLabel = `${label}（${done}/${total}）`;
        item.lastWorkerActivityAt = new Date().toISOString();
      }),
      onActivity: async (label) => update(batch.id, (item) => {
        item.renderingLabel = label;
        item.lastWorkerActivityAt = new Date().toISOString();
      }),
    });
    if (!files.length) await captureLegacyFailure(batch, new Error("New RenderPlan renderer produced no reviewable MP4 output."), "视频渲染");
    await update(batch.id, (item) => {
      item.status = files.length ? "review" : "failed";
      item.progress = files.length ? 100 : 92;
      item.error = files.length ? undefined : "New RenderPlan renderer produced no reviewable MP4 output.";
      item.files = item.files.filter((file) => file.kind !== "output").concat(files);
      item.renderSummary = summary;
      item.renderingLabel = undefined;
    });
    return;
  }
  const edlPath = path.join(batchDir, "edit", "batch-edl.json");
  const referenceProfile = await resolveLegacyEditProfile(batch, batchDir);
  const hook = recordedTextOrManualOverride(batch, referenceProfile, "hookText", "hook_text", "Hook");
  const cvr = recordedTextOrManualOverride(batch, referenceProfile, "cvrText", "cvr_text", "CVR");
  if (batch.files.some((file) => file.kind === "products" && file.sourceType === "nas")) {
    // Codex runs inside the tenant workspace and cannot assume it has direct
    // UNC permission. Give it read-only local proxies for inspection while the
    // final EDL continues to identify the original NAS sources by filename.
    batch = await createAnalysisProxies(batch, { status: "editing", progressStart: 45, progressSpan: 3 });
  }
  const analysisContext = await prepareEditWorkspaceContext(batch, batchDir, referenceProfile, hook, cvr);
  const resumeFromEdl = batch.status === "editing" && await stat(edlPath).then((value) => value.isFile()).catch(() => false);
  let thread = { id: batch.threadId };
  let result = { finalResponse: batch.lastAgentResponse || "已从现有 batch-edl.json 恢复本地渲染。" };
  const originalList = analysisContext.products.map((file) => file.proxy_path
    ? `${file.source_name} => 本地代理 ${file.proxy_path}（EDL source_name/source_original 必须按 analysis-context.v1.json 原样回填）`
    : `${file.source_name} => Batch workspace 原素材（EDL source_name/source_original 必须按 analysis-context.v1.json 原样回填）`).join("\n");
  const hookInstruction = hook.source === "manual" ? `Hook 文案必须使用：${hook.text}` : `Hook 文案必须沿用样片原文：${hook.text}`;
  const cvrInstruction = cvr.source === "manual" ? `CVR 文案必须使用：${cvr.text}` : `CVR 文案必须沿用样片原文：${cvr.text}`;
  const transitionInstruction = referenceProfile?.transition_plan
    ? "转场规则：读取 reference-profile.json.transition_plan，并原样写入 batch-edl.json 的 master.transition_plan。若 enabled=false，则每个 segment 必须 transition_out=\"hard_cut\"，不得添加任何特效。若 enabled=true，只能在 placements 指定的 after_slot 对应片段写入 effect 和 transition_duration_seconds；其他片段必须 hard_cut。不得新增随机转场、不得更改 speed=1.0、不得用转场替代卡点或镜头选择。"
    : "转场规则：这是未记录 transition_plan 的历史母版；本批次必须采用硬切。请在 batch-edl.json 的 master.transition_plan 写入 {\"enabled\":false,\"reason\":\"历史母版未记录可复用转场，已降级为硬切\",\"placements\":[]}，且每个 segment 的 transition_out=\"hard_cut\"。不得新增随机转场、不得更改 speed=1.0、不得用转场替代卡点或镜头选择。";
  const prompt = `继续使用 video-use 技能。样片母版已经由团队确认。

先读取本地剪辑上下文：${path.join(batchDir, "edit", "analysis-context.v1.json")}
样片母版：${path.join(batchDir, "reference-profile.json")}
产品自动分组与同款证据：${path.join(batchDir, "product-groups.json")}
已确认的优秀视频标准：${GOLD_STANDARD}
全部原始素材清单（最终剪辑必须使用这些原片）：\n${originalList}
可选资源目录：${batchDir}
输出目录：${outputDir}

目标：严格按照product-groups.json逐款剪辑，不要求原素材预先分类。NAS 原片目录只读，禁止移动、重命名、覆盖或写入任何原素材；不得直接读取 NAS。Codex 只可读取 analysis-context.v1.json 标明的当前 Batch 本地代理，代理只用于识别；最终 EDL 必须原样回填其中的 source_name 和 source_original，不能引用其他账号、旧 storage/batches 路径或代理路径。每款输出${batch.outputCount}条，最长${batch.durationMax}秒，所有动作保持1.00×，全批严格复用同一脚本结构、节奏、色彩、Hook安全区和CVR布局。${hookInstruction} ${cvrInstruction} 产品镜头可以不同，但阶段时长与画面功能一致。选镜必须排除抖动、对焦漂移、色调异常和服装主体不清楚的片段；五段结构必须同时覆盖整体上身、正面、工艺细节和背面/最佳补充镜头；主要切点与BGM强拍或能量上升点对齐。

${transitionInstruction}

先生成批次EDL，再逐款剪辑、合成和QC。硬门禁全部通过且加权分达到95分才允许进入审核，完成后返回成片清单及失败项。`;
  if (resumeFromEdl) {
    await update(batch.id, (item) => {
      item.renderingLabel = "检测到现有剪辑清单，正在恢复本地渲染";
      item.lastWorkerActivityAt = new Date().toISOString();
    });
  } else {
    thread = createThread(batch);
    result = await runTurn(thread, batch.id, `${prompt}\n必须把最终可执行EDL写入：${edlPath}。完成EDL后不要尝试自行调用编码器，渲染由本地Worker执行。`);
    await update(batch.id, (item) => {
      item.threadId = thread.id || item.threadId;
      item.lastAgentResponse = result.finalResponse;
      item.lastWorkerActivityAt = new Date().toISOString();
    });
  }
  await assertLegacyEditPlanReady(batchDir, { batch, root: ROOT, agentResponse: resumeFromEdl ? undefined : result.finalResponse });
  if (!render) {
    await markRenderQueued(batch, "render");
    return { renderReady: true };
  }
  const refreshed = (await readBatches()).find((item) => item.id === batch.id) || batch;
  const { files, summary } = await renderBatchFromEdl({
    root: ROOT,
    batch: refreshed,
    batchDir,
    ffmpeg: FFMPEG,
    isCanceled: () => isCanceled(batch.id),
    onProgress: async (done, total, label) => update(batch.id, (item) => {
      item.progress = 50 + Math.round((done / total) * 47);
      item.renderingLabel = `${label}（${done}/${total}）`;
      item.lastWorkerActivityAt = new Date().toISOString();
    }),
    onActivity: async (label) => update(batch.id, (item) => {
      item.renderingLabel = label;
      item.lastWorkerActivityAt = new Date().toISOString();
    }),
  });
  if (!files.length) await captureLegacyFailure(batch, new Error("未生成任何可审核的 MP4 成片，请检查 NAS 原片读取权限和 ffmpeg 编码器。"), "视频渲染");
  await update(batch.id, (item) => {
    item.status = files.length ? "review" : "failed";
    item.progress = files.length ? 100 : 92;
    item.error = files.length ? undefined : "未生成任何可审核的 MP4 成片，请检查 NAS 原片读取权限和 ffmpeg 编码器。";
    item.threadId = thread.id || item.threadId;
    item.files = item.files.filter((file) => file.kind !== "output").concat(files);
    item.lastAgentResponse = result.finalResponse;
    item.renderSummary = summary;
    item.renderingLabel = undefined;
  });
}

async function runRenderBatch(batch) {
  await throwIfCanceled(batch.id);
  const batchDir = batchDirFor(batch);
  const runtimeConfig = await loadRenderRuntimeConfig(ROOT);
  if (!isNewRendererEnabled()) await assertLegacyEditPlanReady(batchDir, { batch, root: ROOT });
  const progressStart = batch.status === "revising" ? 86 : 50;
  const progressSpan = batch.status === "revising" ? 11 : 47;
  const onProgress = async (done, total, label) => update(batch.id, (item) => {
    item.progress = progressStart + Math.round((done / total) * progressSpan);
    item.renderingLabel = `${label}（${done}/${total}）`;
    item.lastWorkerActivityAt = new Date().toISOString();
  });
  const onActivity = async (label) => update(batch.id, (item) => {
    item.renderingLabel = label;
    item.lastWorkerActivityAt = new Date().toISOString();
  });
  const refreshed = (await readBatches()).find((item) => item.id === batch.id) || batch;
  const rendered = isNewRendererEnabled()
    ? await renderBatchFromRenderPlans({
      root: ROOT,
      batch: refreshed,
      batchDir,
      ffmpeg: runtimeConfig.ffmpegPath,
      scheduledProducts: (await readJson(path.join(batchDir, "schedule-result.json"), null))?.products || [],
      isCanceled: () => isCanceled(batch.id),
      onProgress,
      onActivity,
    })
    : await renderBatchFromEdl({ root: ROOT, batch: refreshed, batchDir, ffmpeg: runtimeConfig.ffmpegPath, isCanceled: () => isCanceled(batch.id), onProgress, onActivity });
  const { files, summary } = rendered;
  if (!files.length) await captureLegacyFailure(batch, new Error("未生成任何可审核的 MP4 成片。"), "视频渲染");
  await update(batch.id, (item) => {
    const isRevision = batch.status === "revising" && Number(item.revisionVersion || 0) > 0;
    const priorOutputs = item.files.filter((file) => file.kind === "output");
    item.status = files.length ? "review" : "failed";
    item.progress = files.length ? 100 : 92;
    item.error = files.length ? undefined : "未生成任何可审核的 MP4 成片。";
    if (isRevision && priorOutputs.length) item.outputHistory = [...(item.outputHistory || []), ...priorOutputs];
    item.files = item.files.filter((file) => file.kind !== "output").concat(files);
    item.renderSummary = summary;
    item.renderingLabel = undefined;
    if (isRevision) {
      const revision = item.revisionHistory?.find((entry) => entry.version === Number(item.revisionVersion));
      if (revision) {
        revision.status = files.length ? "review" : "failed";
        revision.completedAt = new Date().toISOString();
        revision.outputIds = files.map((file) => file.id);
        if (!files.length) revision.error = item.error;
      }
    }
  });
}

async function runRevision(batch, { render = true } = {}) {
  await throwIfCanceled(batch.id);
  await update(batch.id, (item) => {
    item.status = "revising";
    item.progress = 86;
    item.error = undefined;
    const revision = item.revisionHistory?.find((entry) => entry.version === Number(item.revisionVersion));
    if (revision) { revision.status = "processing"; revision.startedAt ??= new Date().toISOString(); }
  });
  const command = batch.commands.at(-1)?.text || "按最新反馈统一调整整批成片。";
  const thread = createThread(batch);
  const batchDir = batchDirFor(batch);
  const result = await runTurn(thread, batch.id, `读取当前批次的文件化上下文并执行团队的整批修改指令：${command}\n优秀视频标准：${GOLD_STANDARD}\n样片母版：${path.join(batchDir, "reference-profile.json")}\n产品分组：${path.join(batchDir, "product-groups.json")}\n现有EDL：${path.join(batchDir, "edit", "batch-edl.json")}\n保持已经确认的样片母版和v1优秀视频标准，只改指令涉及的部分，并更新${path.join(batchDir, "edit", "batch-edl.json")}。不要依赖旧对话线程，不要自行调用编码器。`);
  await update(batch.id, (item) => {
    item.threadId = thread.id || item.threadId;
    item.lastAgentResponse = result.finalResponse;
    item.lastWorkerActivityAt = new Date().toISOString();
  });
  await assertLegacyEditPlanReady(batchDir, { batch, root: ROOT, agentResponse: result.finalResponse });
  if (!render) {
    await markRenderQueued(batch, "revision");
    return { renderReady: true };
  }
  const refreshed = (await readBatches()).find((item) => item.id === batch.id) || batch;
  const { files, summary } = await renderBatchFromEdl({ root: ROOT, batch: refreshed, batchDir, ffmpeg: FFMPEG, isCanceled: () => isCanceled(batch.id), onActivity: async (label) => update(batch.id, (item) => { item.renderingLabel = label; item.lastWorkerActivityAt = new Date().toISOString(); }), onProgress: async (done, total, label) => update(batch.id, (item) => { item.progress = 86 + Math.round((done / total) * 11); item.renderingLabel = `${label}（${done}/${total}）`; item.lastWorkerActivityAt = new Date().toISOString(); }) });
  if (!files.length) await captureLegacyFailure(batch, new Error("修改任务未生成任何可审核的 MP4 成片。"), "修改渲染");
  await update(batch.id, (item) => {
    const priorOutputs = item.files.filter((file) => file.kind === "output");
    item.status = files.length ? "review" : "failed";
    item.progress = files.length ? 100 : 92;
    item.error = files.length ? undefined : "修改任务未生成任何可审核的 MP4 成片。";
    item.threadId = thread.id || item.threadId;
    if (priorOutputs.length) item.outputHistory = [...(item.outputHistory || []), ...priorOutputs];
    item.files = item.files.filter((file) => file.kind !== "output").concat(files);
    item.renderSummary = summary;
    item.renderingLabel = undefined;
    const revision = item.revisionHistory?.find((entry) => entry.version === Number(item.revisionVersion));
    if (revision) { revision.status = files.length ? "review" : "failed"; revision.completedAt = new Date().toISOString(); revision.outputIds = files.map((file) => file.id); if (!files.length) revision.error = item.error; }
  });
}

async function scanOutputs(directory) {
  const records = [];
  try {
    for (const name of await readdir(directory)) {
      if (!name.toLowerCase().endsWith(".mp4")) continue;
      const full = path.join(directory, name);
      const info = await stat(full);
      records.push({ id: crypto.randomUUID(), kind: "output", name, relativePath: name, storagePath: path.relative(ROOT, full), size: info.size, createdAt: new Date().toISOString() });
    }
  } catch {}
  return records;
}

async function tick() {
  await writeHeartbeat();
  const batches = await readBatches();
  const codexAvailable = await accountReady();
  if (!codexAvailable) {
    const interrupted = batches.find((item) => ACTIVE_BATCH_STATUSES.has(item.status));
    if (interrupted) await recoverCodexConnection(interrupted);
  }
  const batch = batches.find((item) => RUNNABLE_BATCH_STATUSES.has(item.status) && (codexAvailable || !CODEX_DEPENDENT_BATCH_STATUSES.has(item.status)));
  if (!batch) return false;
  if (!(await resumeRecoveryIfNeeded(batch))) return false;
  try {
    if (["reference_queued", "analyzing_reference"].includes(batch.status)) await analyzeReference(batch);
    if (["creating_proxies", "detecting_products"].includes(batch.status)) await detectProducts(batch);
    if (batch.status === "regroup_queued") await detectProducts(batch, null, batch.groupCommands?.at(-1)?.text || "");
    if (["batch_queued", "editing"].includes(batch.status)) await runBatchEdit(batch);
    if (["revision_queued", "revising"].includes(batch.status)) await runRevision(batch);
    await markBusinessRecoveryIfProven(batch);
  } catch (error) {
    const canceled = error instanceof CanceledError || await isCanceled(batch.id);
    if (!canceled) await recoverOrEscalate(batch, error);
    else await update(batch.id, (item) => { item.status = "canceled"; item.error = undefined; item.lastWorkerActivityAt = new Date().toISOString(); });
  }
  return true;
}

export { TurnTimeoutError, ExecutorIncompleteError, analyzeReference, detectProducts, runAnalyzeQuality, runBatchEdit, runRenderBatch, runRevision, runTurn, readBatches, update, isCanceled, recoverOrEscalate, setLeaseGuard, setFailureContext, createReadOnlyNasVideoProxy, prepareEditWorkspaceContext };

function setLeaseGuard(guard) {
  leaseGuard = typeof guard === "function" ? guard : null;
}

function setFailureContext(context) {
  failureContext = context && typeof context === "object" ? context : null;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await writeHeartbeat();
  const heartbeatTimer = setInterval(() => { writeHeartbeat().catch(() => undefined); }, 5000);
  do {
    const worked = await tick();
    if (once) break;
    await new Promise((resolve) => setTimeout(resolve, worked ? 1000 : 3500));
  } while (true);
  clearInterval(heartbeatTimer);
}
