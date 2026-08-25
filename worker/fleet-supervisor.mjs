import { appendFile, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJson, writeJsonAtomic } from "../lib/atomic-json.mjs";

const ROOT = process.cwd();
const RESTART_DELAY_MS = Math.max(3_000, Number(process.env.CUTFLOW_FLEET_RESTART_DELAY_MS) || 3_000);
const HEARTBEAT_MS = 5_000;
const runtimeFile = path.join(ROOT, "data", "fleet-runtime.json");
const logFile = path.join(ROOT, "logs", "fleet-supervisor.log");
const tempRoot = process.env.CUTFLOW_WORKER_TEMP_ROOT || path.join(os.tmpdir(), "cutflow-workers");
const cacheRoot = process.env.CUTFLOW_WORKER_CACHE_ROOT || path.join(os.tmpdir(), "cutflow-worker-cache");

export const FLEET_MEMBERS = [
  ...["analyze", "clip", "render"].flatMap((service) => [1, 2, 3].map((index) => ({
    name: `${service}-${index}`,
    script: "service-supervisor.mjs",
    args: [`--service=${service}`, `--instance=${service}-${index}`],
  }))),
  ...["template", "delivery", "chatcut"].map((worker) => ({
    name: worker,
    script: "auxiliary-supervisor.mjs",
    args: [`--worker=${worker}`],
  })),
];

const children = new Map();
let stopping = false;
let heartbeatTimer = null;

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function truncate(value, limit = 1_000) {
  const text = String(value || "").trim().replace(/\s+/g, " ");
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

async function log(message) {
  await mkdir(path.dirname(logFile), { recursive: true });
  await appendFile(logFile, `${new Date().toISOString()} ${message}\n`, "utf8");
}

async function writeHeartbeat() {
  await writeJsonAtomic(runtimeFile, {
    schemaVersion: 1,
    status: stopping ? "stopping" : "running",
    pid: process.pid,
    at: new Date().toISOString(),
    members: FLEET_MEMBERS.map((member) => ({ name: member.name, pid: children.get(member.name)?.pid || null })),
  });
}

async function adoptLiveMembers() {
  const prior = await readJson(runtimeFile, null);
  const recent = Number.isFinite(new Date(prior?.at || 0).getTime()) && Date.now() - new Date(prior.at).getTime() < 60_000;
  if (!recent) return;
  const priorMembers = new Map((Array.isArray(prior?.members) ? prior.members : []).map((member) => [member.name, member]));
  for (const member of FLEET_MEMBERS) {
    const existing = priorMembers.get(member.name);
    if (processIsAlive(Number(existing?.pid))) {
      children.set(member.name, { pid: Number(existing.pid), adopted: true });
      await log(`${member.name} supervisor adopted (pid ${existing.pid}).`);
    }
  }
}

async function repairAdoptedMembers() {
  for (const member of FLEET_MEMBERS) {
    const current = children.get(member.name);
    if (current?.adopted && !processIsAlive(current.pid)) children.delete(member.name);
    if (!children.has(member.name)) await launchMember(member);
  }
}

function memberEnvironment(member) {
  const workerTemp = path.join(tempRoot, member.name);
  const workerCache = path.join(cacheRoot, member.name);
  return {
    ...process.env,
    TEMP: workerTemp,
    TMP: workerTemp,
    TMPDIR: workerTemp,
    XDG_CACHE_HOME: workerCache,
    ...(member.script === "service-supervisor.mjs" ? { CUTFLOW_SERVICE_INSTANCE: member.name } : {}),
  };
}

async function launchMember(member) {
  if (stopping || children.has(member.name)) return;
  const workerTemp = path.join(tempRoot, member.name);
  const workerCache = path.join(cacheRoot, member.name);
  await mkdir(workerTemp, { recursive: true });
  await mkdir(workerCache, { recursive: true });
  const child = spawn(process.execPath, [path.join(ROOT, "worker", member.script), ...member.args], {
    cwd: ROOT,
    env: memberEnvironment(member),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.set(member.name, child);
  await log(`${member.name} supervisor started (pid ${child.pid}).`);
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => log(`[${member.name}] ${truncate(chunk)}`).catch(() => undefined));
  }
  child.once("error", (error) => log(`${member.name} supervisor error: ${truncate(error.message)}`).catch(() => undefined));
  child.once("exit", (code, signal) => {
    children.delete(member.name);
    if (stopping) return;
    log(`${member.name} supervisor exited (code ${code ?? "unknown"}${signal ? `, signal ${signal}` : ""}); restarting.`).catch(() => undefined);
    setTimeout(() => launchMember(member).catch((error) => log(`${member.name} restart failed: ${truncate(error.message)}`)), RESTART_DELAY_MS);
  });
  await writeHeartbeat();
}

async function stop() {
  if (stopping) return;
  stopping = true;
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  for (const child of children.values()) {
    if (!child.adopted && !child.killed) child.kill();
  }
  await writeHeartbeat();
}

async function main() {
  process.once("SIGINT", () => { stop().catch(() => undefined); });
  process.once("SIGTERM", () => { stop().catch(() => undefined); });
  await adoptLiveMembers();
  for (const member of FLEET_MEMBERS.filter((candidate) => !children.has(candidate.name))) {
    await launchMember(member);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  heartbeatTimer = setInterval(() => {
    repairAdoptedMembers()
      .then(() => writeHeartbeat())
      .catch((error) => log(`Heartbeat failed: ${truncate(error.message)}`));
  }, HEARTBEAT_MS);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

export { launchMember, writeHeartbeat };
