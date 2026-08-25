import { appendFile, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJson, writeJsonAtomic } from "../lib/atomic-json.mjs";
import { releaseWorkerLeases } from "./service-queue.mjs";
import { MAX_RECOVERY_ATTEMPTS, markManualRequired, scheduleRecovery } from "./recovery.mjs";
import { recordBatchFailure } from "./failure-diagnostics.mjs";
import { update } from "./processor.mjs";

const ROOT = process.cwd();
const SERVICE = process.argv.find((arg) => arg.startsWith("--service="))?.slice("--service=".length) || process.env.CUTFLOW_SERVICE || "render";
const INSTANCE = process.argv.find((arg) => arg.startsWith("--instance="))?.slice("--instance=".length) || process.env.CUTFLOW_SERVICE_INSTANCE || `${SERVICE}-${process.pid}`;
const RESTART_DELAY_MS = Math.max(3_000, Number(process.env.CUTFLOW_SERVICE_RESTART_DELAY_MS) || 3_000);
const HEARTBEAT_TIMEOUT_MS = Math.max(15_000, Number(process.env.CUTFLOW_SERVICE_HEARTBEAT_TIMEOUT_MS) || 20_000);
const HEARTBEAT_CHECK_MS = Math.max(3_000, Math.min(5_000, Math.floor(HEARTBEAT_TIMEOUT_MS / 3)));
const runnerPath = path.join(ROOT, "worker", "service-runner.mjs");
const runtimeFile = path.join(ROOT, "data", "service-runtime", `${SERVICE}-${INSTANCE}.json`);
const logFile = path.join(ROOT, "logs", `${INSTANCE}.supervisor.log`);
const heartbeatFile = path.join(ROOT, "data", "service-heartbeats", `${SERVICE}-${INSTANCE}.json`);

let child = null;
let stopping = false;
let lastChildOutput = "";
let childStartedAt = 0;
let heartbeatTimer = null;
let heartbeatStopRequested = false;

function truncate(value, limit = 1_000) {
  const text = String(value || "").trim().replace(/\s+/g, " ");
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

async function readRuntime() {
  return readJson(runtimeFile, {
    schemaVersion: 1,
    service: SERVICE,
    workerId: INSTANCE,
    restartCount: 0,
  });
}

async function writeRuntime(change) {
  const current = await readRuntime();
  await writeJsonAtomic(runtimeFile, {
    ...current,
    ...change,
    schemaVersion: 1,
    service: SERVICE,
    workerId: INSTANCE,
    updatedAt: new Date().toISOString(),
  });
}

async function writeLog(message) {
  await mkdir(path.dirname(logFile), { recursive: true });
  await appendFile(logFile, `${new Date().toISOString()} ${message}\n`, "utf8");
}

async function releaseCrashedLeases(reason) {
  const message = `Service worker crashed: ${truncate(reason)}`;
  const classification = { category: "recoverable", kind: "worker_crash", recoverable: true, label: "服务异常重启" };
  const released = await releaseWorkerLeases({
    root: ROOT,
    workerId: INSTANCE,
    reason: message,
    maxAttempts: MAX_RECOVERY_ATTEMPTS,
  });
  for (const { task, state, attempt } of released) {
    await recordBatchFailure({
      root: ROOT,
      batchId: task.batchId,
      service: SERVICE,
      stage: `${task.stage}/${task.operation}`,
      workerInstance: INSTANCE,
      error: new Error(message),
      context: { operation: task.operation, attempt, workerCrash: true, recoverable: state === "retry" },
    }).catch(() => undefined);
    if (state === "manual") {
      await markManualRequired({ root: ROOT, batchId: task.batchId, stage: task.stage, message }).catch(() => undefined);
      await update(task.batchId, (item) => {
        item.status = "failed";
        item.error = `自动恢复连续失败 ${MAX_RECOVERY_ATTEMPTS} 次：${message}`;
        item.renderingLabel = "等待人工处理";
        item.lastWorkerActivityAt = new Date().toISOString();
      }).catch(() => undefined);
      continue;
    }
    await scheduleRecovery({ root: ROOT, batchId: task.batchId, attempt, stage: task.stage, classification, message }).catch(() => undefined);
    await update(task.batchId, (item) => {
      item.recoveryAttempts = attempt;
      item.error = undefined;
      item.renderingLabel = `自动恢复中：${classification.label}，第 ${attempt} 次尝试`;
      item.lastWorkerActivityAt = new Date().toISOString();
    }).catch(() => undefined);
  }
}

function capture(stream) {
  stream.on("data", (chunk) => {
    const text = String(chunk);
    lastChildOutput = truncate(`${lastChildOutput}\n${text}`, 4_000);
    writeLog(text.trim()).catch(() => undefined);
  });
}

export function heartbeatFailure({ heartbeat, childPid, childStartedAt: startedAt, now = Date.now(), timeoutMs = HEARTBEAT_TIMEOUT_MS }) {
  if (!childPid || now - startedAt <= timeoutMs) return null;
  if (Number(heartbeat?.pid) !== Number(childPid)) return "worker heartbeat pid mismatch";
  const heartbeatAt = new Date(heartbeat?.at || 0).getTime();
  if (!Number.isFinite(heartbeatAt) || now - heartbeatAt > timeoutMs) return "worker heartbeat stopped";
  return null;
}

async function checkHeartbeat() {
  if (!child || stopping || heartbeatStopRequested) return;
  const reason = heartbeatFailure({
    heartbeat: await readJson(heartbeatFile, null),
    childPid: child.pid,
    childStartedAt,
  });
  if (!reason) return;
  heartbeatStopRequested = true;
  await writeLog(`${reason}; stopping child pid ${child.pid}.`);
  if (!child.killed) child.kill();
}

async function restartAfterCrash(reason) {
  await releaseCrashedLeases(reason).catch((error) => writeLog(`Could not release crashed leases: ${truncate(error instanceof Error ? error.message : String(error))}`));
  const current = await readRuntime();
  const restartCount = Number(current.restartCount || 0) + 1;
  const crashedAt = new Date().toISOString();
  await writeRuntime({
    status: "crashed",
    pid: undefined,
    restartCount,
    lastCrashReason: truncate(reason),
    lastCrashAt: crashedAt,
    nextRestartAt: new Date(Date.now() + RESTART_DELAY_MS).toISOString(),
  });
  await writeLog(`Child crashed: ${truncate(reason)}`);
  await new Promise((resolve) => setTimeout(resolve, RESTART_DELAY_MS));
  if (stopping) return;
  await writeRuntime({ status: "restarting", lastRestartAt: new Date().toISOString(), nextRestartAt: undefined });
  launch().catch((error) => restartAfterCrash(error instanceof Error ? error.message : String(error)).catch(() => undefined));
}

async function launch() {
  const current = await readRuntime();
  await writeRuntime({
    status: "starting",
    pid: undefined,
    restartCount: Number(current.restartCount || 0),
    nextRestartAt: undefined,
  });
  lastChildOutput = "";
  child = spawn(process.execPath, [runnerPath, `--service=${SERVICE}`, `--instance=${INSTANCE}`], {
    cwd: ROOT,
    env: { ...process.env, CUTFLOW_SERVICE_INSTANCE: INSTANCE },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  childStartedAt = Date.now();
  heartbeatStopRequested = false;
  capture(child.stdout);
  capture(child.stderr);
  // A spawned child is now live. Keeping it in "starting" forever made the
  // dashboard report healthy Analyze/Clip workers as restarting services.
  await writeRuntime({ status: "running", pid: child.pid, lastStartedAt: new Date().toISOString() });
  await writeLog(`Child started (pid ${child.pid}).`);

  child.once("error", (error) => {
    lastChildOutput = truncate(`${lastChildOutput}\n${error.message}`, 4_000);
  });
  child.once("exit", (code, signal) => {
    child = null;
    heartbeatStopRequested = false;
    if (stopping) {
      writeRuntime({ status: "offline", pid: undefined, nextRestartAt: undefined }).catch(() => undefined);
      return;
    }
    const detail = truncate(lastChildOutput) || `${SERVICE} service worker exited (code ${code ?? "unknown"}${signal ? `, signal ${signal}` : ""})`;
    restartAfterCrash(detail).catch(() => undefined);
  });
}

async function stop() {
  stopping = true;
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (child && !child.killed) child.kill();
  await writeRuntime({ status: "offline", pid: undefined, nextRestartAt: undefined });
}

async function main() {
  process.once("SIGINT", () => { stop().catch(() => undefined); });
  process.once("SIGTERM", () => { stop().catch(() => undefined); });
  await launch();
  heartbeatTimer = setInterval(() => checkHeartbeat().catch((error) => writeLog(`Heartbeat check failed: ${truncate(error.message)}`)), HEARTBEAT_CHECK_MS);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

export { launch, restartAfterCrash, writeRuntime };
