import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { readJson, withFileLock } from "../lib/atomic-json.mjs";
import { FLEET_MEMBERS } from "./fleet-supervisor.mjs";

const FLEET_HEARTBEAT_MAX_AGE_MS = 15_000;
const FLEET_START_TIMEOUT_MS = 20_000;
const FLEET_WATCH_INTERVAL_MS = 10_000;
let watchdogTimer = null;

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function fleetRuntimeIsHealthy(runtime, { now = Date.now(), isAlive = processIsAlive } = {}) {
  if (runtime?.status !== "running" || !isAlive(Number(runtime.pid))) return false;
  const heartbeatAt = new Date(runtime.at || 0).getTime();
  if (!Number.isFinite(heartbeatAt) || now - heartbeatAt > FLEET_HEARTBEAT_MAX_AGE_MS) return false;
  const members = new Map((Array.isArray(runtime.members) ? runtime.members : []).map((member) => [member.name, member]));
  return FLEET_MEMBERS.every((required) => {
    const member = members.get(required.name);
    return member && isAlive(Number(member.pid));
  });
}

async function readFleetRuntime(root) {
  return readJson(path.join(root, "data", "fleet-runtime.json"), null);
}

async function waitForFleet(root, { timeoutMs = FLEET_START_TIMEOUT_MS, isAlive } = {}) {
  const deadline = Date.now() + timeoutMs;
  do {
    const runtime = await readFleetRuntime(root);
    if (fleetRuntimeIsHealthy(runtime, { isAlive })) return runtime;
    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  throw new Error("Worker Fleet 启动超时；任务已保留在队列中，将继续自动恢复");
}

async function fleetEnvironment(root) {
  const production = await readJson(path.join(root, "data", "production-path.json"), null);
  const env = {
    ...process.env,
    CODEX_HOME: process.env.CODEX_HOME || "D:\\codex\\.codex",
    CUTFLOW_WORKER_TEMP_ROOT: process.env.CUTFLOW_WORKER_TEMP_ROOT || "D:\\codex\\tmp\\cutflow-workers",
    CUTFLOW_WORKER_CACHE_ROOT: process.env.CUTFLOW_WORKER_CACHE_ROOT || "D:\\codex\\cache\\cutflow-workers",
    NODE_OPTIONS: process.env.NODE_OPTIONS || "--openssl-legacy-provider",
  };
  for (const [flag, value] of Object.entries(production?.flags || {})) env[flag] = String(value);
  if (production?.modelFast) env.MODEL_FAST = String(production.modelFast);
  if (production?.modelStrong) env.MODEL_STRONG = String(production.modelStrong);
  return env;
}

async function launchFleet(root, spawnFleet = spawn) {
  const child = spawnFleet(process.execPath, [path.join(root, "worker", "fleet-supervisor.mjs")], {
    cwd: root,
    env: await fleetEnvironment(root),
    detached: true,
    windowsHide: true,
    stdio: "ignore",
  });
  child.unref?.();
  return child;
}

function armFleetWatchdog(root) {
  if (watchdogTimer) return;
  watchdogTimer = setInterval(() => {
    ensureFleetAvailable({ root, armWatchdog: false }).catch(() => undefined);
  }, FLEET_WATCH_INTERVAL_MS);
  watchdogTimer.unref?.();
}

export async function ensureFleetAvailable({ root = process.cwd(), spawnFleet = spawn, isAlive, timeoutMs, armWatchdog = true } = {}) {
  const current = await readFleetRuntime(root);
  if (fleetRuntimeIsHealthy(current, { isAlive })) {
    if (armWatchdog) armFleetWatchdog(root);
    return current;
  }
  await mkdir(path.join(root, "data"), { recursive: true });
  const guardFile = path.join(root, "data", "fleet-start.guard");
  const runtime = await withFileLock(guardFile, async () => {
    const latest = await readFleetRuntime(root);
    if (fleetRuntimeIsHealthy(latest, { isAlive })) return latest;
    await launchFleet(root, spawnFleet);
    return waitForFleet(root, { timeoutMs, isAlive });
  }, { timeoutMs: Math.max(FLEET_START_TIMEOUT_MS + 5_000, Number(timeoutMs || 0) + 5_000) });
  if (armWatchdog) armFleetWatchdog(root);
  return runtime;
}
