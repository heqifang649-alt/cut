import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { resolveProviderConfig } from "../lib/ai-provider-config.mjs";
import { AiProviderAdapter } from "../lib/ai-provider-adapter.mjs";
import { DurableProviderRequestGuard } from "../lib/ai-provider-guard.mjs";
import { readJson, writeJsonAtomic } from "../lib/atomic-json.mjs";
import { acquireRenderPermit, releaseRenderPermit } from "../worker/resource-governor.mjs";

const execFileAsync = promisify(execFile);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function meter(capacity) {
  let startedAt = null, lastAt = null, active = 0, maxActive = 0, busySlotMs = 0;
  const account = () => {
    const current = performance.now();
    if (lastAt === null) { startedAt = current; lastAt = current; }
    busySlotMs += (current - lastAt) * active;
    lastAt = current;
  };
  return {
    enter() { account(); active += 1; maxActive = Math.max(maxActive, active); },
    leave() { account(); active = Math.max(0, active - 1); },
    snapshot() { account(); const elapsedMs = Math.max(1, performance.now() - startedAt); return { maxActive, utilization: busySlotMs / (elapsedMs * capacity), elapsedMs }; },
  };
}

async function generateMp4(ffmpeg, file, identity) {
  const color = `0x${hash(identity).slice(0, 6)}`;
  await execFileAsync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=c=${color}:s=64x64:d=0.12:r=10`, "-metadata", `comment=${identity}`, "-c:v", "mpeg4", "-pix_fmt", "yuv420p", "-movflags", "+faststart", file], { windowsHide: true });
  await execFileAsync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", file, "-f", "null", "-"], { windowsHide: true });
}

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
}

export async function runRealProvider10x5({ projectRoot = process.cwd(), root, ffmpeg, keep = true } = {}) {
  const ownedRoot = !root;
  root ||= await mkdtemp(path.join(os.tmpdir(), "cutflow-real-provider-10x5-"));
  if (!ffmpeg) throw new Error("ffmpeg is required");
  const { config } = await resolveProviderConfig(projectRoot);
  if (!config.apiKey || !config.baseUrl || !config.fastModel) throw new Error("Real Provider is not configured");
  const batches = Array.from({ length: 10 }, (_, index) => ({ id: `real-batch-${String(index + 1).padStart(2, "0")}`, productId: `real-product-${String(index + 1).padStart(2, "0")}` }));
  const workItems = batches.flatMap((batch) => Array.from({ length: 5 }, (_, index) => ({ ...batch, outputIndex: index + 1 })));
  const startedAt = performance.now();
  const providerMeter = meter(2);
  const renderMeter = meter(2);
  const completionTimes = new Map();
  let cursor = 0;
  let backpressureEvents = 0;
  await mkdir(path.join(root, "provider-evidence"), { recursive: true });

  const fetchImpl = async (...args) => {
    providerMeter.enter();
    try { return await fetch(...args); }
    finally { providerMeter.leave(); }
  };
  const adapters = Array.from({ length: 4 }, () => {
    const guard = new DurableProviderRequestGuard({ ...config, root, fairMultiBatch: true });
    return new AiProviderAdapter(config, { root, guard, fetchImpl });
  });

  const runProviderWorker = async (workerIndex) => {
    while (true) {
      const itemIndex = cursor++;
      if (itemIndex >= workItems.length) return;
      const item = workItems[itemIndex];
      const evidenceFile = path.join(root, "provider-evidence", `${item.id}-${item.outputIndex}.json`);
      if (await stat(evidenceFile).then((info) => info.isFile()).catch(() => false)) continue;
      while (true) {
        try {
          const result = await adapters[workerIndex].complete({
            model: config.fastModel,
            prompt: `CUT 10x5 production readiness probe. Batch ${item.id}, output ${item.outputIndex}. Reply with exactly READY.`,
            retryLimit: 0,
            maxOutputTokens: 8,
          });
          const text = String(result.text || "").trim();
          if (!/READY/i.test(text)) throw new Error(`Unexpected Provider response for ${item.id}/${item.outputIndex}`);
          await writeJsonAtomic(evidenceFile, { batchId: item.id, productId: item.productId, outputIndex: item.outputIndex, model: config.fastModel, responseHash: hash(text), completedAt: new Date().toISOString() });
          break;
        } catch (error) {
          if (error?.code !== "PROVIDER_BACKPRESSURE") throw error;
          backpressureEvents += 1;
          const retryAt = Date.parse(error.retryAt || "") || Date.now() + Math.max(30_000, Number(error.retryAfterMs) || 0);
          await wait(Math.max(250, retryAt - Date.now()));
        }
      }
    }
  };
  await Promise.all([0, 1, 2, 3].map(runProviderWorker));
  const providerMetrics = providerMeter.snapshot();

  cursor = 0;
  const runRenderWorker = async (workerIndex) => {
    while (true) {
      const itemIndex = cursor++;
      if (itemIndex >= workItems.length) return;
      const item = workItems[itemIndex];
      const outputDir = path.join(root, "outputs", item.id);
      await mkdir(outputDir, { recursive: true });
      const outputFile = path.join(outputDir, `${item.productId}-${String(item.outputIndex).padStart(2, "0")}.mp4`);
      let permit;
      while (!permit) {
        const result = await acquireRenderPermit({ root, batchId: item.id, taskKey: `${item.id}:render:${item.outputIndex}`, workerId: `real-render-${workerIndex}` });
        if (result.state === "acquired") permit = result.permit;
        else await wait(Math.max(5, Date.parse(result.retryAt) - Date.now()));
      }
      renderMeter.enter();
      try {
        if (!(await stat(outputFile).then((info) => info.isFile()).catch(() => false))) await generateMp4(ffmpeg, outputFile, `${item.id}:${item.productId}:${item.outputIndex}`);
      } finally {
        renderMeter.leave();
        await releaseRenderPermit({ root, permit });
      }
      if (item.outputIndex === 5) completionTimes.set(item.id, performance.now());
    }
  };
  await Promise.all([0, 1, 2].map(runRenderWorker));
  const renderMetrics = renderMeter.snapshot();

  const manifests = [];
  for (const batch of batches) {
    const files = [];
    for (let index = 1; index <= 5; index += 1) {
      const file = path.join(root, "outputs", batch.id, `${batch.productId}-${String(index).padStart(2, "0")}.mp4`);
      await execFileAsync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", file, "-f", "null", "-"], { windowsHide: true });
      const bytes = await readFile(file);
      files.push({ name: path.basename(file), productId: batch.productId, sha256: hash(bytes), size: bytes.length });
    }
    const manifest = { batchId: batch.id, targetOutputsPerBatch: 5, count: files.length, files };
    await writeJsonAtomic(path.join(root, "outputs", batch.id, "render-manifest.json"), manifest);
    manifests.push(manifest);
  }
  const finishedAt = performance.now();
  const makespanMs = finishedAt - startedAt;
  const allFiles = manifests.flatMap((manifest) => manifest.files);
  const durations = batches.map((batch) => completionTimes.get(batch.id) - startedAt);
  const report = {
    schemaVersion: 1,
    provider: { providerId: config.providerId, model: config.fastModel, protocolMode: config.protocolMode },
    workload: { batches: 10, targetOutputsPerBatch: 5, providerRequests: 50, totalOutputs: allFiles.length },
    passed: allFiles.length === 50 && new Set(allFiles.map((file) => file.sha256)).size === 50 && providerMetrics.maxActive <= 2 && renderMetrics.maxActive <= 2,
    assertions: {
      providerEvidenceComplete: (await Promise.all(workItems.map((item) => readJson(path.join(root, "provider-evidence", `${item.id}-${item.outputIndex}.json`), null)))).every(Boolean),
      validMp4: allFiles.length === 50 && allFiles.every((file) => file.size > 0),
      uniqueOutputs: new Set(allFiles.map((file) => file.sha256)).size === 50,
      noWrongProduct: manifests.every((manifest, index) => manifest.files.every((file) => file.productId === batches[index].productId)),
      manifestsConsistent: manifests.every((manifest) => manifest.count === 5 && manifest.files.length === 5),
      providerConcurrencyAtMostTwo: providerMetrics.maxActive <= 2,
      renderConcurrencyAtMostTwo: renderMetrics.maxActive <= 2,
    },
    metrics: {
      totalMakespanMs: Math.round(makespanMs),
      outputsPerHour: Number((50 / (makespanMs / 3_600_000)).toFixed(2)),
      p50BatchCompletionMs: Math.round(percentile(durations, 0.5)),
      p95BatchCompletionMs: Math.round(percentile(durations, 0.95)),
      providerUtilization: Number(providerMetrics.utilization.toFixed(4)),
      renderUtilization: Number(renderMetrics.utilization.toFixed(4)),
      providerMaxConcurrency: providerMetrics.maxActive,
      renderMaxConcurrency: renderMetrics.maxActive,
      providerBackpressureEvents: backpressureEvents,
    },
  };
  if (!report.passed || !Object.values(report.assertions).every(Boolean)) throw new Error(`Real Provider 10x5 failed: ${JSON.stringify(report.assertions)}`);
  await writeJsonAtomic(path.join(root, "real-provider-10x5-report.json"), report);
  if (ownedRoot && !keep) await rm(root, { recursive: true, force: true });
  return { root, report };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const ffmpeg = process.argv.find((arg) => arg.startsWith("--ffmpeg="))?.slice("--ffmpeg=".length) || process.env.FFMPEG_PATH;
  const result = await runRealProvider10x5({ ffmpeg, keep: true });
  process.stdout.write(`${JSON.stringify(result.report, null, 2)}\nArtifacts: ${result.root}\n`);
}
