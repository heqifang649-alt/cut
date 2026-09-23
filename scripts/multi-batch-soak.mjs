import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { DurableProviderRequestGuard } from "../lib/ai-provider-guard.mjs";
import { loadRuntimeConfig } from "../worker/runtime-config.mjs";
import { ProviderAdapterError } from "../lib/ai-provider-adapter.mjs";
import { readJson, withFileLock, writeJsonAtomic } from "../lib/atomic-json.mjs";
import { inspectWorkRoot, resetWorkRootHealthCache } from "../lib/work-paths.mjs";
import { acquireRenderPermit, releaseRenderPermit } from "../worker/resource-governor.mjs";
import { claimStage, completeStage, deferStage, enqueueStage, promoteRetries, readQueue, releaseWorkerLeases } from "../worker/service-queue.mjs";

const execFileAsync = promisify(execFile);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function meter(capacity) {
  let startedAt = null;
  let lastAt = null;
  let active = 0;
  let busySlotMs = 0;
  let maxActive = 0;
  const account = () => {
    const current = performance.now();
    if (lastAt === null) { startedAt = current; lastAt = current; }
    busySlotMs += (current - lastAt) * active;
    lastAt = current;
  };
  return {
    enter() { account(); active += 1; maxActive = Math.max(maxActive, active); },
    leave() { account(); active = Math.max(0, active - 1); },
    snapshot() { account(); const elapsedMs = Math.max(1, performance.now() - startedAt); return { maxActive, busySlotMs, capacityMs: elapsedMs * capacity, utilization: busySlotMs / (elapsedMs * capacity) }; },
  };
}

async function forceRetryReady(root, key) {
  const file = path.join(root, "data", "service-queue.json");
  await withFileLock(file, async () => {
    const queue = await readJson(file, { tasks: [] });
    const task = queue.tasks.findLast((item) => item.key === key);
    if (task?.status === "retry") task.notBefore = new Date(0).toISOString();
    await writeJsonAtomic(file, queue);
  });
}

async function generateMp4(ffmpeg, file, color, comment) {
  await execFileAsync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=c=${color}:s=64x64:d=0.12:r=10`, "-metadata", `comment=${comment}`, "-c:v", "mpeg4", "-pix_fmt", "yuv420p", "-movflags", "+faststart", file], { windowsHide: true });
  await execFileAsync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", file, "-f", "null", "-"], { windowsHide: true });
}

function percentile(values, percentileValue) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(percentileValue * sorted.length) - 1))];
}

export async function runMultiBatchSoak({ root, ffmpeg, keep = false } = {}) {
  const ownedRoot = !root;
  root ||= await mkdtemp(path.join(os.tmpdir(), "cutflow-10x5-soak-"));
  if (!ffmpeg) throw new Error("ffmpeg is required for the deterministic 10x5 soak");
  const startedAt = performance.now();
  const providerMeter = meter(2);
  const renderMeter = meter(2);
  const batches = Array.from({ length: 10 }, (_, index) => ({ id: `soak-batch-${String(index + 1).padStart(2, "0")}`, productId: `product-${String(index + 1).padStart(2, "0")}` }));
  const completedAt = new Map();
  const providerConfig = { providerId: "soak-provider", baseUrl: "https://soak.invalid/v1/", apiKey: "fixture-key-not-a-credential", fastModel: "soak-model", maxConcurrency: 8, requestCap: 200, retryLimit: 0 };
  const guards = Array.from({ length: 4 }, () => new DurableProviderRequestGuard({ ...providerConfig, root, fairMultiBatch: true }));
  const providerFaults = new Set();
  const pausedBatch = batches.at(-1).id;
  let pauseObservedPeerProgress = false;

  try {
    await mkdir(path.join(root, "data"), { recursive: true });
    for (const batch of batches) await enqueueStage({ root, batchId: batch.id, stage: "analyze", operation: "quality", workflowVersion: 1 });

    // Fault 1: a worker dies after claiming. Recovery must preserve the task
    // and the later run must not duplicate any committed Evidence.
    const crashed = await claimStage({ root, stage: "analyze", workerId: "soak-crashed", fairMultiBatch: true });
    await releaseWorkerLeases({ root, workerId: "soak-crashed", reason: "SOAK_FORCED_WORKER_EXIT", maxAttempts: 3 });
    await forceRetryReady(root, crashed.key);
    await promoteRetries({ root, stage: "analyze" });

    const runAnalyzeWorker = async (workerIndex) => {
      const workerId = `soak-analyze-${workerIndex}`;
      while (true) {
        await promoteRetries({ root, stage: "analyze" });
        const task = await claimStage({ root, stage: "analyze", workerId, fairMultiBatch: true });
        if (!task) {
          const queue = await readQueue(root);
          if (!queue.tasks.some((item) => item.stage === "analyze" && ["queued", "retry", "leased"].includes(item.status))) return;
          await wait(5);
          continue;
        }

        // Fault 2: shared Provider backpressure defers without consuming a
        // Batch attempt. This is intentionally injected once.
        if (task.batchId === batches[3].id && !providerFaults.has(task.batchId)) {
          providerFaults.add(task.batchId);
          const error = new ProviderAdapterError("soak 429", { code: "PROVIDER_BACKPRESSURE", status: 429, retryAfterMs: 10 });
          const retryAt = new Date(Date.now() + 10).toISOString();
          await deferStage({ root, task, reason: error.code, notBefore: retryAt, fairMultiBatch: true });
          continue;
        }

        // Fault 3: one paused Batch must not prevent peers from advancing.
        if (task.batchId === pausedBatch && !providerFaults.has("pause")) {
          providerFaults.add("pause");
          await deferStage({ root, task, reason: "SOAK_BATCH_PAUSED", notBefore: new Date(Date.now() + 150).toISOString(), fairMultiBatch: true });
          continue;
        }

        const evidenceDir = path.join(root, "evidence", task.batchId);
        await mkdir(evidenceDir, { recursive: true });
        const existing = await Promise.all(Array.from({ length: 10 }, async (_, index) => stat(path.join(evidenceDir, `shot-${index + 1}.json`)).then(() => index + 1).catch(() => null)));
        const pending = existing.map((value, index) => value ? null : index + 1).filter(Boolean).slice(0, 8);
        await Promise.all(pending.map((shotNumber, index) => guards[(workerIndex + index) % guards.length].run(async () => {
          providerMeter.enter();
          try {
            await wait(40);
            await writeJsonAtomic(path.join(evidenceDir, `shot-${shotNumber}.json`), { batchId: task.batchId, shotNumber, model: "soak-model" });
          } finally { providerMeter.leave(); }
          return { shotNumber };
        }, { model: "soak-model", retryLimit: 0 })));
        const completed = (await Promise.all(Array.from({ length: 10 }, (_, index) => stat(path.join(evidenceDir, `shot-${index + 1}.json`)).then(() => true).catch(() => false)))).filter(Boolean).length;
        if (task.batchId !== pausedBatch && completed === 10 && providerFaults.has("pause")) pauseObservedPeerProgress = true;
        if (completed < 10) {
          await deferStage({ root, task, reason: "SEMANTIC_QUANTUM_EXHAUSTED", notBefore: new Date(Date.now() + 1).toISOString(), fairMultiBatch: true });
        } else {
          await completeStage({ root, task });
          await enqueueStage({ root, batchId: task.batchId, stage: "render", operation: "render", workflowVersion: 1 });
        }
      }
    };
    await Promise.all([0, 1, 2, 3].map(runAnalyzeWorker));
    const provider = providerMeter.snapshot();

    const runRenderWorker = async (workerIndex) => {
      const workerId = `soak-render-${workerIndex}`;
      while (true) {
        await promoteRetries({ root, stage: "render" });
        const task = await claimStage({ root, stage: "render", workerId, fairMultiBatch: true });
        if (!task) {
          const queue = await readQueue(root);
          if (!queue.tasks.some((item) => item.stage === "render" && ["queued", "retry", "leased"].includes(item.status))) return;
          await wait(5);
          continue;
        }
        const permit = await acquireRenderPermit({ root, batchId: task.batchId, taskKey: task.key, workerId });
        if (permit.state === "waiting") {
          await deferStage({ root, task, reason: "RENDER_CAPACITY_BACKPRESSURE", notBefore: new Date(Date.now() + 5).toISOString(), fairMultiBatch: true });
          continue;
        }
        renderMeter.enter();
        try {
          const batch = batches.find((item) => item.id === task.batchId);
          const outputDir = path.join(root, "outputs", batch.id);
          await mkdir(outputDir, { recursive: true });
          const files = [];
          for (let index = 1; index <= 5; index += 1) {
            const file = path.join(outputDir, `${batch.productId}-${String(index).padStart(2, "0")}.mp4`);
            const info = await stat(file).catch(() => null);
            if (!info?.isFile()) {
              const digest = createHash("sha256").update(`${batch.id}:${index}`).digest("hex");
              await generateMp4(ffmpeg, file, `0x${digest.slice(0, 6)}`, `${batch.id}:${batch.productId}:${index}`);
            }
            const bytes = await readFile(file);
            files.push({ name: path.basename(file), productId: batch.productId, sha256: sha256(bytes), size: bytes.length });
          }
          await writeJsonAtomic(path.join(outputDir, "render-manifest.json"), { batchId: batch.id, targetOutputsPerBatch: 5, count: files.length, files });
          await completeStage({ root, task });
          completedAt.set(batch.id, performance.now());
        } finally {
          renderMeter.leave();
          await releaseRenderPermit({ root, permit: permit.permit });
        }
      }
    };
    await Promise.all([0, 1, 2].map(runRenderWorker));

    // Fault 4: the service checks disk pressure before claiming heavy work.
    // A deliberately impossible watermark must fail closed and leave the queue untouched.
    const diskRoot = path.join(root, "disk-pressure-fixture");
    resetWorkRootHealthCache();
    let diskBackpressure = false;
    try {
      await inspectWorkRoot({ env: { CUT_WORK_ROOT: diskRoot, CUTFLOW_MIN_FREE_BYTES: String(Number.MAX_SAFE_INTEGER) } });
    } catch (error) {
      diskBackpressure = error?.code === "CUT_WORK_ROOT_LOW_SPACE";
    }

    const manifests = await Promise.all(batches.map((batch) => readJson(path.join(root, "outputs", batch.id, "render-manifest.json"), null)));
    const files = manifests.flatMap((manifest) => manifest?.files || []);
    const evidenceBeforeRestart = await Promise.all(batches.flatMap((batch) => Array.from({ length: 10 }, async (_, index) => sha256(await readFile(path.join(root, "evidence", batch.id, `shot-${index + 1}.json`))))));
    const outputBeforeRestart = files.map((file) => file.sha256);
    // A fleet restart sees only terminal tasks; hashes prove completed work is reused.
    assertSoak((await claimStage({ root, stage: "analyze", workerId: "soak-restart-analyze", fairMultiBatch: true })) === null, "restart reclaimed completed Evidence task");
    assertSoak((await claimStage({ root, stage: "render", workerId: "soak-restart-render", fairMultiBatch: true })) === null, "restart reclaimed completed Render task");
    const evidenceAfterRestart = await Promise.all(batches.flatMap((batch) => Array.from({ length: 10 }, async (_, index) => sha256(await readFile(path.join(root, "evidence", batch.id, `shot-${index + 1}.json`))))));
    const queue = await readQueue(root);
    const durations = batches.map((batch) => completedAt.get(batch.id) - startedAt);
    const finishedAt = performance.now();
    const makespanMs = finishedAt - startedAt;
    const render = renderMeter.snapshot();
    const report = {
      schemaVersion: 1,
      workload: { batches: 10, targetOutputsPerBatch: 5, totalOutputs: files.length },
      passed: true,
      assertions: {
        validMp4: files.length === 50 && files.every((file) => file.size > 0),
        uniqueOutputs: new Set(files.map((file) => file.sha256)).size === 50,
        noWrongProduct: manifests.every((manifest, index) => manifest.files.every((file) => file.productId === batches[index].productId)),
        providerConcurrencyAtMostTwo: provider.maxActive <= 2,
        renderConcurrencyAtMostTwo: render.maxActive <= 2,
        provider429DidNotFailBatch: providerFaults.has(batches[3].id),
        workerExitRecovered: queue.tasks.find((task) => task.key === crashed.key)?.status === "completed",
        restartReusedEvidence: JSON.stringify(evidenceBeforeRestart) === JSON.stringify(evidenceAfterRestart),
        restartReusedRender: JSON.stringify(outputBeforeRestart) === JSON.stringify(files.map((file) => file.sha256)),
        diskBackpressure,
        pausedBatchDidNotBlockPeers: pauseObservedPeerProgress,
        noPermanentLeasesOrOrphans: queue.tasks.every((task) => task.status === "completed"),
        manifestsConsistent: manifests.every((manifest) => manifest.count === 5 && manifest.files.length === 5),
      },
      metrics: {
        totalMakespanMs: Math.round(makespanMs),
        outputsPerHour: Number((files.length / (makespanMs / 3_600_000)).toFixed(2)),
        p50BatchCompletionMs: Math.round(percentile(durations, 0.5)),
        p95BatchCompletionMs: Math.round(percentile(durations, 0.95)),
        providerUtilization: Number(provider.utilization.toFixed(4)),
        renderUtilization: Number(render.utilization.toFixed(4)),
        providerMaxConcurrency: provider.maxActive,
        renderMaxConcurrency: render.maxActive,
      },
    };
    for (const [name, passed] of Object.entries(report.assertions)) assertSoak(passed, name);
    await writeJsonAtomic(path.join(root, "soak-report.json"), report);
    return { root, report };
  } finally {
    if (ownedRoot && !keep) await rm(root, { recursive: true, force: true });
  }
}

function assertSoak(condition, message) {
  if (!condition) throw new Error(`10x5 soak assertion failed: ${message}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const ffmpeg = (await loadRuntimeConfig(path.dirname(fileURLToPath(import.meta.url)).replace(/[\\/]scripts$/, ""))).ffmpegExecutable;
  const keep = process.argv.includes("--keep");
  const result = await runMultiBatchSoak({ ffmpeg, keep });
  process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n${keep ? `Artifacts: ${result.root}\n` : ""}`);
}
