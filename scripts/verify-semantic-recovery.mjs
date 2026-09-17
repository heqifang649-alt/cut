import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, readdir } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { readJson, writeJsonAtomic } from "../lib/atomic-json.mjs";
import { preserveSemanticSnapshot, writeSemanticPerformance } from "../lib/semantic-observation.mjs";

const manifestPath = path.resolve(process.argv.find((arg) => arg.startsWith("--manifest="))?.slice(11) || "");
const manifest = await readJson(manifestPath, null);
if (!manifest?.batchDir || !manifest?.root) throw new Error("Invalid manifest");
if (process.env.SEMANTIC_TEST_PROVIDER_URL) throw new Error("Real verification cannot use a fixture Provider");
const resultPath = path.join(manifest.batchDir, "recovery-verification.json");
const previousStatus = process.argv.includes("--resume") ? await readJson(resultPath, null) : null;
if (process.argv.includes("--resume") && !previousStatus?.killedPid) throw new Error("No prior real crash verification to resume");
if (Number(previousStatus?.resumeCount || 0) >= 3) throw new Error("Bounded verification resume limit reached");
const status = previousStatus || { batchId: manifest.batch.id, state: "waiting", realProvider: true, concurrency: 1, qualityGateV2: false, startedAt: new Date().toISOString() };
if (previousStatus) {
  await preserveSemanticSnapshot(manifest.batchDir, previousStatus);
  const snapshots = await readdir(path.join(manifest.batchDir, "semantic-history/snapshots"));
  const restarts = [status.firstRestartAt, status.restartAt].filter(Boolean);
  for (const name of snapshots.filter((name) => name.endsWith(".json"))) {
    const old = await readJson(path.join(manifest.batchDir, "semantic-history/snapshots", name), null);
    if (old?.killedPid === status.killedPid && old?.restartAt) restarts.push(old.firstRestartAt || old.restartAt);
  }
  status.firstRestartAt = restarts.sort()[0];
  status.resumeCount = Number(status.resumeCount || 0) + 1;
  const report = await writeSemanticPerformance(manifest.batchDir);
  status.completedBeforeResume = report.shots.filter((shot) => shot.resultStatus === "success").map((shot) => ({ shotId: shot.shotId, requestCount: shot.requestCount }));
}
const save = async () => writeJsonAtomic(resultPath, status);
status.state = "waiting";
status.waitForAllAnalyzeWorkers = process.argv.includes("--wait-for-analyze-idle");
await save();
// Wait for the selected production batch to finish its old in-memory analysis.
// The verification then replaces that analysis workload, rather than adding
// another simultaneous batch while its original Worker is still occupied.
const waitDeadline = Date.now() + 90 * 60_000;
while (true) {
  const queue = await readJson(path.join(manifest.root, "data/service-queue.json"), null);
  if (!Array.isArray(queue?.tasks)) throw new Error("Cannot verify live queue");
  if (!queue.tasks.some((task) => (status.waitForAllAnalyzeWorkers || task.batchId === manifest.batch.id) && task.stage === "analyze" && task.status === "leased")) break;
  if (Date.now() >= waitDeadline) throw new Error("Waiting for original analysis exceeded deadline");
  await delay(5000);
}

async function historyHashes() {
  const directory = path.join(manifest.batchDir, "semantic-history");
  const result = {};
  for (const name of await readdir(directory, { recursive: true }).catch(() => [])) {
    if (name.endsWith(".json")) result[name] = createHash("sha256").update(await readFile(path.join(directory, name))).digest("hex");
  }
  return result;
}
const worker = fileURLToPath(new URL("../worker/semantic-verification.mjs", import.meta.url));
async function launch(crashCheckpoint) {
  const child = spawn(process.execPath, [worker, `--manifest=${manifestPath}`, ...(crashCheckpoint ? ["--crash-checkpoint"] : [])], { cwd: manifest.root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (chunk) => process.stdout.write(chunk));
  // Worker output is deliberately a status allowlist; no credential-bearing
  // provider body or runtime environment is printed by the controller.
  child.stderr.on("data", () => { status.workerStderr = true; });
  let exited = false;
  const done = once(child, "exit").then(([code, signal]) => { exited = true; return { code, signal }; });
  status.state = crashCheckpoint ? "running_before_kill" : "running_after_restart";
  status.workerPid = child.pid;
  await save();
  if (!crashCheckpoint) return done;
  while (!exited) {
    const ready = await readJson(path.join(manifest.batchDir, "crash-ready.json"), null);
    if (ready?.pid === child.pid) {
      status.beforeHashes = await historyHashes();
      const report = await writeSemanticPerformance(manifest.batchDir);
      status.completedBeforeKill = report.shots.filter((shot) => shot.resultStatus === "success").map((shot) => ({ shotId: shot.shotId, requestCount: shot.requestCount }));
      status.killedPid = child.pid;
      status.killAt = new Date().toISOString();
      await save();
      child.kill("SIGKILL");
      const exit = await done;
      status.killedExit = exit;
      status.state = "killed";
      await save();
      return exit;
    }
    await delay(250);
  }
  return done;
}

if (!previousStatus) await launch(true);
if (status.killedPid) {
  await delay(1000);
  status.restartAt = new Date().toISOString();
  status.firstRestartAt ||= status.restartAt;
  status.restartExit = await launch(false);
}
const performance = await writeSemanticPerformance(manifest.batchDir);
status.afterHashes = await historyHashes();
status.evidencePreserved = Boolean(status.beforeHashes) && Object.entries(status.beforeHashes).every(([name, hash]) => status.afterHashes[name] === hash);
status.completedShotsNotRedispatched = Boolean(status.completedBeforeKill?.length) && status.completedBeforeKill.every((before) => performance.shots.find((shot) => shot.shotId === before.shotId)?.requestCount === before.requestCount);
if (status.completedBeforeResume) status.completedShotsNotRedispatched &&= status.completedBeforeResume.every((before) => performance.shots.find((shot) => shot.shotId === before.shotId)?.requestCount === before.requestCount);
status.fullBatchObserved = performance.summary.fullCoverage;
status.summary = performance.summary;
status.finishedAt = new Date().toISOString();
status.state = status.evidencePreserved && status.completedShotsNotRedispatched && status.fullBatchObserved ? "verified" : "incomplete";
await save();
await preserveSemanticSnapshot(manifest.batchDir, status);
process.stdout.write(`${JSON.stringify({ state: status.state, summary: status.summary })}\n`);
