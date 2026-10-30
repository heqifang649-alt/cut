import { mkdir, rm } from "node:fs/promises";
import { boundedLogger } from "../lib/bounded-log.mjs";
import { RestartBudget } from "../lib/restart-budget.mjs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJson, writeJsonAtomic } from "../lib/atomic-json.mjs";
import { assertWorkRootReady, workPaths, workerInstancePaths } from "../lib/work-paths.mjs";
import { loadRuntimeConfig, runtimeIdentity } from "./runtime-config.mjs";
import { preflightRuntime } from "./runtime-preflight.mjs";
import { claimsEnabled } from "./claim-control.mjs";
import { canaryBatchIds, sameClaimScope } from "./batch-scope.mjs";
import { classicIntegrationConfig } from "../lib/classic-integration.mjs";

// The fleet can be launched directly by recovery or scheduled-task tooling,
// bypassing the PowerShell launcher that normally injects this setting. Keep
// .env.local as the single source of truth while preserving explicitly passed
// process environment values.
process.loadEnvFile(".env.local");
// An explicit maintenance launch must win even if the child process did not
// inherit the launcher's environment and .env.local enables normal claims.
const FORCE_NO_CLAIM = process.argv.includes("--no-claim") || Boolean(classicIntegrationConfig());
if (FORCE_NO_CLAIM) process.env.CUTFLOW_CLAIM_ENABLED = "false";

const ROOT = process.cwd();
let RUNTIME = await loadRuntimeConfig(ROOT);
function applyRuntimeEnvironment(runtime) {
  process.env.CUT_WORK_ROOT = runtime.workRoot;
  process.env.CUTFLOW_WORKER_TEMP_ROOT = runtime.runtimeTempRoot;
  process.env.CUTFLOW_WORKER_CACHE_ROOT = runtime.runtimeCacheRoot;
  if (runtime.codexHome) process.env.CODEX_HOME = runtime.codexHome;
  else delete process.env.CODEX_HOME;
  if (runtime.codexCliExecutable) process.env.CODEX_CLI_PATH = runtime.codexCliExecutable;
  else delete process.env.CODEX_CLI_PATH;
}
applyRuntimeEnvironment(RUNTIME);
const RESTART_DELAY_MS = Math.max(3_000, Number(process.env.CUTFLOW_FLEET_RESTART_DELAY_MS) || 3_000);
const HEARTBEAT_MS = 5_000;
const runtimeFile = path.join(ROOT, "data", "fleet-runtime.json");
const logFile = path.join(workPaths().worker_scratch, "logs", "fleet-supervisor.log");
const canaryFile = path.join(ROOT, "data", "multi-batch-canary.json");
let canaryEnvironment = {};

export function canaryHoldsGlobalClaims(canary) {
  return ["running", "aborted"].includes(canary?.status);
}

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
  ...(classicIntegrationConfig(ROOT) ? [
    { name: "bridge", script: "auxiliary-supervisor.mjs", args: ["--worker=bridge"] },
    { name: "multisource", script: "auxiliary-supervisor.mjs", args: ["--worker=multisource"] },
  ] : []),
];

const children = new Map();
const restartBudget = new RestartBudget({ baseMs: RESTART_DELAY_MS });
export function fleetRestartDelayMs(failures, baseMs = RESTART_DELAY_MS) {
  return Math.min(5 * 60_000, baseMs * 2 ** Math.min(Math.max(0, failures - 1), 7));
}
let stopping = false;
let heartbeatTimer = null;

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

function truncate(value, limit = 1_000) {
  const text = String(value || "").trim().replace(/\s+/g, " ");
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

const log = boundedLogger(logFile);

async function writeHeartbeat() {
  await writeJsonAtomic(runtimeFile, {
    schemaVersion: 1,
    status: stopping ? "stopping" : "running",
    claimsEnabled: claimsEnabled(),
    ...runtimeIdentity(RUNTIME),
    pid: process.pid,
    at: new Date().toISOString(),
    canaryBatchIds: canaryEnvironment.CUTFLOW_CANARY_BATCH_IDS?.split(",") || [],
    members: FLEET_MEMBERS.map((member) => ({ name: member.name, pid: children.get(member.name)?.pid || null })),
  });
}

async function loadCanaryEnvironment() {
  const canary = await readJson(canaryFile, null);
  if (canary?.status !== "running" || canary?.fairSchedulerEnabled !== true) return {};
  let batchIds;
  try { batchIds = canaryBatchIds(canary.batchIds); } catch { return {}; }
  const batches = await readJson(path.join(ROOT, "data", "batches.json"), []);
  const canceledBatchIds = Array.isArray(batches)
    ? batches.filter((batch) => batchIds.includes(batch?.id) && batch?.status === "canceled").map((batch) => batch.id)
    : [];
  if (canceledBatchIds.length) {
    const endedAt = new Date().toISOString();
    const aborted = {
      ...canary,
      status: "aborted",
      endedAt,
      terminalReason: "canary_batch_canceled",
      canceledBatchIds,
    };
    await writeJsonAtomic(canaryFile, aborted);
    const evidenceRoot = path.resolve(ROOT, ".project-governance", "evidence", "multi-batch-canary");
    const evidenceDir = path.resolve(ROOT, canary.evidenceDir || "");
    const relativeEvidenceDir = path.relative(evidenceRoot, evidenceDir);
    if (relativeEvidenceDir && relativeEvidenceDir !== ".." && !relativeEvidenceDir.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeEvidenceDir)) {
      await writeJsonAtomic(path.join(evidenceDir, "canary-aborted.json"), {
        kind: "CUT_CANARY_ABORTED",
        runId: canary.runId,
        endedAt,
        reason: "canary_batch_canceled",
        canceledBatchIds,
        message: "A selected Canary Batch was canceled. This run cannot meet its declared output target; prior artifacts are retained, and the canary claim scope is released.",
      }).catch(() => undefined);
    }
    await log(`Canary ${canary.runId} aborted because selected Batch ${canceledBatchIds.join(", ")} was canceled; releasing the scoped claim allowlist.`);
    return {};
  }
  return {
    ENABLE_FAIR_MULTI_BATCH_SCHEDULER: "true",
    CUTFLOW_CANARY_BATCH_IDS: batchIds.join(","),
  };
}

async function adoptLiveMembers() {
  const prior = await readJson(runtimeFile, null);
  if (!fleetRuntimeIsRecent(prior)) return;
  const priorMembers = new Map((Array.isArray(prior?.members) ? prior.members : []).map((member) => [member.name, member]));
  const hasLiveMembers = [...priorMembers.values()].some((member) => processIsAlive(Number(member.pid)));
  if (hasLiveMembers && !sameClaimScope(prior, claimsEnabled(), canaryEnvironment.CUTFLOW_CANARY_BATCH_IDS?.split(",") || [])) {
    throw new Error("Live fleet members have a different claim scope; stop the existing fleet before switching scope");
  }
  for (const member of FLEET_MEMBERS) {
    const existing = priorMembers.get(member.name);
    if (processIsAlive(Number(existing?.pid))) {
      children.set(member.name, { pid: Number(existing.pid), adopted: true });
      await log(`${member.name} supervisor adopted (pid ${existing.pid}).`);
    }
  }
}

export function fleetRuntimeIsRecent(prior, now = Date.now()) {
  const at = prior?.at ? new Date(prior.at).getTime() : NaN;
  return Number.isFinite(at) && at <= now && now - at < 60_000;
}

async function repairAdoptedMembers() {
  for (const member of FLEET_MEMBERS) {
    const current = children.get(member.name);
    if (current?.adopted && !processIsAlive(current.pid)) children.delete(member.name);
    if (!children.has(member.name)) await launchMember(member);
  }
}

function memberEnvironment(member) {
  const { temp: workerTemp, cache: workerCache } = workerInstancePaths(member.name);
  const canaryScoped = !FORCE_NO_CLAIM && Boolean(canaryEnvironment.CUTFLOW_CANARY_BATCH_IDS);
  return {
    ...process.env,
    TEMP: workerTemp,
    TMP: workerTemp,
    TMPDIR: workerTemp,
    XDG_CACHE_HOME: workerCache,
    // Canary service queues may run under the explicit Batch allowlist while
    // auxiliary workers remain in no-claim mode (they otherwise scan global
    // template, delivery, and ChatCut work outside the Batch queue scope).
    ...(canaryScoped ? {
      // The Fleet itself stays in No-Claim mode. Only stage workers get a
      // claim capability, and service-runner still fences every claim to the
      // explicit CUTFLOW_CANARY_BATCH_IDS allowlist above.
      CUTFLOW_CLAIM_ENABLED: member.script === "service-supervisor.mjs" ? "true" : "false",
    } : {}),
    ...(member.script === "service-supervisor.mjs" ? { CUTFLOW_SERVICE_INSTANCE: member.name, ...canaryEnvironment } : {}),
  };
}

async function launchMember(member) {
  if (stopping || children.has(member.name) || !restartBudget.acquire(member.name)) return;
  try {
  RUNTIME = await loadRuntimeConfig(ROOT);
  applyRuntimeEnvironment(RUNTIME);
  const { temp: workerTemp, cache: workerCache } = workerInstancePaths(member.name);
  await mkdir(workerTemp, { recursive: true });
  await mkdir(workerCache, { recursive: true });
  const child = spawn(RUNTIME.nodeExecutable, [path.join(ROOT, "worker", member.script), ...member.args], {
    cwd: ROOT,
    env: memberEnvironment(member),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.startedAt = Date.now();
  children.set(member.name, child);
  await log(`${member.name} supervisor started (pid ${child.pid}).`);
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => log(`[${member.name}] ${truncate(chunk)}`).catch(() => undefined));
  }
  child.once("error", (error) => log(`${member.name} supervisor error: ${truncate(error.message)}`).catch(() => undefined));
  child.once("exit", (code, signal) => {
    children.delete(member.name);
    if (stopping) return;
    const { delayMs, circuitOpen } = restartBudget.failed(member.name, Date.now() - child.startedAt >= 60_000);
    log(`${member.name} supervisor exited (code ${code ?? "unknown"}${signal ? `, signal ${signal}` : ""}); ${circuitOpen ? "retry budget exhausted; cooldown" : "restarting"} in ${delayMs}ms.`).catch(() => undefined);
    // Periodic repair is the only retry owner. No competing timer can bypass
    // the budget or create a second child during asynchronous launch setup.
  });
  await writeHeartbeat();
  } catch (error) {
    if (!children.has(member.name)) restartBudget.failed(member.name);
    throw error;
  } finally {
    restartBudget.release(member.name);
  }
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
  try {
    await preflightRuntime({ root: ROOT, capability: "fleet", config: RUNTIME });
    // A previous preflight failure is an incident record, not permanent
    // runtime state. Leaving it behind after a later successful launch makes
    // /api/health report a false outage indefinitely.
    await rm(path.join(ROOT, "data", "runtime-health", "fleet.json"), { force: true }).catch(() => undefined);
  } catch (error) {
    if (error?.code === "RUNTIME_DEPENDENCY_UNAVAILABLE") {
      await writeJsonAtomic(runtimeFile, { schemaVersion: 1, status: error.code, unavailable: error.unavailable || [], failureStage: error.failureStage || "preflight", detectedAt: error.detectedAt || new Date().toISOString(), ...runtimeIdentity(RUNTIME), at: new Date().toISOString(), pid: process.pid, members: [] });
    }
    throw error;
  }
  const health = await assertWorkRootReady({ maxAgeMs: 0 });
  const canaryControl = await readJson(canaryFile, null);
  if (canaryHoldsGlobalClaims(canaryControl)) process.env.CUTFLOW_CLAIM_ENABLED = "false";
  canaryEnvironment = FORCE_NO_CLAIM ? {} : await loadCanaryEnvironment();
  await log(`CUT_WORK_ROOT ready: ${health.root}; free ${(health.freeBytes / 2 ** 30).toFixed(2)} GiB.`);
  if (canaryEnvironment.CUTFLOW_CANARY_BATCH_IDS) await log(`Canary isolation active for ${canaryEnvironment.CUTFLOW_CANARY_BATCH_IDS}.`);
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
