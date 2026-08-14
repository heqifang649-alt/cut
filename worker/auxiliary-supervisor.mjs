import { appendFile, mkdir, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readJson, writeJsonAtomic } from "../lib/atomic-json.mjs";

const ROOT = process.cwd();
const workerName = process.argv.find((arg) => arg.startsWith("--worker="))?.slice("--worker=".length);
const WORKERS = {
  template: {
    script: "template-processor.mjs",
    heartbeat: "template-worker-heartbeat.json",
    guardedLock: "templates.json.lock",
  },
  delivery: {
    script: "delivery-watcher.mjs",
    heartbeat: "delivery-worker-heartbeat.json",
    guardedLock: "batches.json.lock",
  },
  chatcut: {
    script: "chatcut-sync.mjs",
    heartbeat: "chatcut-worker-heartbeat.json",
    guardedLock: "batches.json.lock",
  },
};

const config = WORKERS[workerName];
if (!config) throw new Error("Auxiliary supervisor requires --worker=template|delivery|chatcut");

const RESTART_DELAY_MS = Math.max(3_000, Number(process.env.CUTFLOW_AUX_RESTART_DELAY_MS) || 3_000);
const HEARTBEAT_TIMEOUT_MS = Math.max(20_000, Number(process.env.CUTFLOW_AUX_HEARTBEAT_TIMEOUT_MS) || 30_000);
// JSON mutations should take milliseconds. A longer hold means the process is
// wedged in filesystem I/O and must be restarted before it blocks the portal.
const LOCK_MAX_HOLD_MS = Math.max(30_000, Number(process.env.CUTFLOW_AUX_LOCK_MAX_HOLD_MS) || 30_000);
const runtimeFile = path.join(ROOT, "data", "auxiliary-runtime", `${workerName}.json`);
const logFile = path.join(ROOT, "logs", `${workerName}.auxiliary-supervisor.log`);
const workerPath = path.join(ROOT, "worker", config.script);
const heartbeatFile = path.join(ROOT, "data", config.heartbeat);
const guardedLockFile = path.join(ROOT, "data", config.guardedLock);

let child = null;
let stopping = false;
let healthCheckPending = false;
let lastChildOutput = "";

function truncate(value, limit = 1_000) {
  const text = String(value || "").trim().replace(/\s+/g, " ");
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

async function writeRuntime(change) {
  const current = await readJson(runtimeFile, { schemaVersion: 1, worker: workerName, restartCount: 0 });
  await writeJsonAtomic(runtimeFile, {
    ...current,
    ...change,
    schemaVersion: 1,
    worker: workerName,
    updatedAt: new Date().toISOString(),
  });
}

async function writeLog(message) {
  await mkdir(path.dirname(logFile), { recursive: true });
  await appendFile(logFile, `${new Date().toISOString()} ${message}\n`, "utf8");
}

function capture(stream) {
  stream.on("data", (chunk) => {
    const text = String(chunk);
    lastChildOutput = truncate(`${lastChildOutput}\n${text}`, 4_000);
    writeLog(text.trim()).catch(() => undefined);
  });
}

async function stopChildTree() {
  if (!child?.pid) return;
  const pid = child.pid;
  // A ChatCut/Codex child can itself spawn helpers. On Windows, kill the
  // process tree so a blocked helper cannot retain the data lock.
  await new Promise((resolve) => {
    const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    killer.once("error", () => resolve(undefined));
    killer.once("exit", () => resolve(undefined));
  });
}

async function unhealthyReason() {
  if (!child?.pid) return null;
  const now = Date.now();
  const heartbeat = await readJson(heartbeatFile, null);
  const heartbeatAt = new Date(heartbeat?.at || 0).getTime();
  if (heartbeat?.pid !== child.pid || !Number.isFinite(heartbeatAt) || now - heartbeatAt > HEARTBEAT_TIMEOUT_MS) {
    // Newly launched workers have a short grace period to write their first
    // heartbeat; after that a missing heartbeat is a true stalled process.
    if (now - child.startedAt > HEARTBEAT_TIMEOUT_MS) return "worker heartbeat stopped";
  }
  const lockInfo = await stat(guardedLockFile).catch(() => null);
  if (!lockInfo || now - lockInfo.mtimeMs <= LOCK_MAX_HOLD_MS) return null;
  const owner = await readJson(guardedLockFile, null);
  return owner?.pid === child.pid ? `held ${config.guardedLock} for over ${Math.round(LOCK_MAX_HOLD_MS / 1000)} seconds` : null;
}

async function checkHealth() {
  if (stopping || healthCheckPending) return;
  healthCheckPending = true;
  try {
    const reason = await unhealthyReason();
    if (!reason) return;
    await writeLog(`Restarting stalled child: ${reason}`);
    await writeRuntime({ status: "stalled", lastFailureReason: reason, lastFailureAt: new Date().toISOString() });
    await stopChildTree();
  } finally {
    healthCheckPending = false;
  }
}

async function restartAfterExit(reason) {
  const current = await readJson(runtimeFile, { restartCount: 0 });
  const restartCount = Number(current.restartCount || 0) + 1;
  await writeRuntime({
    status: "restarting",
    pid: undefined,
    restartCount,
    lastFailureReason: truncate(reason),
    lastFailureAt: new Date().toISOString(),
    nextRestartAt: new Date(Date.now() + RESTART_DELAY_MS).toISOString(),
  });
  await writeLog(`Child exited: ${truncate(reason)}`);
  await new Promise((resolve) => setTimeout(resolve, RESTART_DELAY_MS));
  if (!stopping) await launch();
}

async function launch() {
  const current = await readJson(runtimeFile, { restartCount: 0 });
  await writeRuntime({ status: "starting", pid: undefined, restartCount: Number(current.restartCount || 0), nextRestartAt: undefined });
  lastChildOutput = "";
  child = spawn(process.execPath, [workerPath], { cwd: ROOT, env: process.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  child.startedAt = Date.now();
  capture(child.stdout);
  capture(child.stderr);
  await writeRuntime({ status: "running", pid: child.pid, lastStartedAt: new Date().toISOString() });
  await writeLog(`Child started (pid ${child.pid}).`);
  child.once("error", (error) => { lastChildOutput = truncate(`${lastChildOutput}\n${error.message}`, 4_000); });
  child.once("exit", (code, signal) => {
    child = null;
    if (stopping) {
      writeRuntime({ status: "offline", pid: undefined, nextRestartAt: undefined }).catch(() => undefined);
      return;
    }
    const reason = truncate(lastChildOutput) || `${workerName} worker exited (code ${code ?? "unknown"}${signal ? `, signal ${signal}` : ""})`;
    restartAfterExit(reason).catch((error) => writeLog(`Restart failure: ${truncate(error)}`).catch(() => undefined));
  });
}

async function stop() {
  stopping = true;
  await stopChildTree();
  await writeRuntime({ status: "offline", pid: undefined, nextRestartAt: undefined });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.once("SIGINT", () => { stop().catch(() => undefined); });
  process.once("SIGTERM", () => { stop().catch(() => undefined); });
  await launch();
  const interval = setInterval(() => { checkHealth().catch((error) => writeLog(`Health check failure: ${truncate(error)}`).catch(() => undefined)); }, 5_000);
  interval.unref?.();
}

export { unhealthyReason };
