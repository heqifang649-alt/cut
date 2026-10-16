#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AiProviderAdapter } from "../lib/ai-provider-adapter.mjs";
import { DurableProviderRequestGuard } from "../lib/ai-provider-guard.mjs";
import { resolveProviderConfig } from "../lib/ai-provider-config.mjs";
import { assertProviderAvailable } from "../lib/provider-incident.mjs";
import { readJson, writeJsonAtomic } from "../lib/atomic-json.mjs";
import { batchWorkspacePath } from "../lib/tenant-paths.mjs";
import { runSemanticShadow } from "../worker/semantic-shadow.mjs";
import { loadRuntimeConfig } from "../worker/runtime-config.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceId = "6e1fc4a3-9fb4-4181-a158-2cdd86ebc4a6";
const models = ["gpt-6-sol", "gpt-6.1-sol", "gpt-6-luna"];
const runId = `semantic-model-screen-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
const outputDir = path.join(root, ".project-governance", "evidence", "semantic-model-comparison", runId);
const activeStatuses = new Set(["reference_queued", "analyzing_reference", "creating_proxies", "detecting_products", "regroup_queued", "batch_queued", "editing", "revision_queued", "revising"]);

async function assertNoActiveProduction() {
  const batches = await readJson(path.join(root, "data", "batches.json"), []);
  const active = batches.filter((batch) => activeStatuses.has(batch.status));
  if (active.length) throw Object.assign(new Error("Production Batch active; screen stopped before another Provider request"), { code: "PRODUCTION_ACTIVE" });
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const digest = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("data", (chunk) => digest.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolve(digest.digest("hex")));
  });
}

function quantile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

await assertNoActiveProduction();
const batches = await readJson(path.join(root, "data", "batches.json"), []);
const source = batches.find((batch) => batch.id === sourceId);
if (!source || !["review", "completed"].includes(source.status)) throw new Error("Frozen source Batch is unavailable");
const sourceDir = batchWorkspacePath(root, source);
const pool = await readJson(path.join(sourceDir, "shot-pool.json"), null);
const groups = await readJson(path.join(sourceDir, "product-groups.json"), null);
if (!Array.isArray(pool?.shots) || !Array.isArray(groups?.groups) || groups.groups.length < 4) throw new Error("Source lacks four real product groups and ShotPool");
const selected = groups.groups.slice(0, 4).map((group) => {
  const shot = pool.shots.find((candidate) => group.files.some((file) => path.basename(candidate.path).toLowerCase() === path.basename(file).toLowerCase()));
  if (!shot) throw new Error(`No real Shot for ${group.id}`);
  return { ...shot, groupId: group.id };
});
const files = [...new Set([...selected.map((shot) => shot.path), ...source.files.filter((file) => file.kind === "product_refs").map((file) => file.absolutePath || file.storagePath)])];
const sourceSnapshot = [];
for (const file of files) {
  const info = await stat(file);
  if (!info.isFile() || info.size === 0) throw new Error("Source or reference is not a readable file");
  sourceSnapshot.push({ path: file, bytes: info.size, sha256: await hashFile(file) });
}
const { config } = await resolveProviderConfig(root);
const productionPath = await readJson(path.join(root, "data", "production-path.json"), {});
if (!config.baseUrl || !config.apiKey || config.fastModel !== "gpt-6-sol" || config.strongModel !== "gpt-6-sol" || productionPath.modelFast !== "gpt-6-sol" || productionPath.modelStrong !== "gpt-6-sol" || productionPath.flags?.ENABLE_API_SEMANTIC_SCORER !== "true") {
  throw new Error("Production semantic/model contract changed; comparison refused");
}
const runtime = await loadRuntimeConfig(root);
const report = {
  artifact: "cut-semantic-model-screen.v1", runId, sourceBatchId: source.id,
  createdAt: new Date().toISOString(), status: "RUNNING", productionConfigChanged: false,
  sourceIntegrity: "snapshot-only; no pre-existing frozen semantic manifest or independent Shot scores",
  selection: selected.map((shot) => ({ shotId: shot.id, groupId: shot.groupId, source: shot.path, start: shot.start, end: shot.end })),
  sourceSnapshot, models: {},
  limits: { shotsPerModel: 4, concurrency: 1, retryLimit: 0, requestTimeoutMs: 90_000, requestCapPerModel: 4 },
  limitation: "Live production semantic scorer path, but isolated evidence and Provider guard; no human semantic Ground Truth, render, or production switch.",
};
await mkdir(outputDir, { recursive: true });
const reportPath = path.join(outputDir, "report.json");
await writeJsonAtomic(reportPath, report);
const env = { ...process.env, CUT_WORK_ROOT: path.join(outputDir, "work"), ENABLE_HYBRID_PILOT: "true", ENABLE_API_SEMANTIC_SCORER: "true", ENABLE_NEW_SHOTPOOL: "true", ENABLE_FAIR_MULTI_BATCH_SCHEDULER: "true" };

try {
  for (const model of models) {
    await assertNoActiveProduction();
    const directory = path.join(outputDir, model);
    await mkdir(directory, { recursive: true });
    await writeJsonAtomic(path.join(directory, "product-groups.json"), groups);
    const modelConfig = { ...config, fastModel: model, strongModel: model, maxConcurrency: 1, retryLimit: 0, pilotRequestCap: 4, requestTimeoutMs: 90_000 };
    const guard = new DurableProviderRequestGuard({ root: directory, providerId: modelConfig.providerId, baseUrl: modelConfig.baseUrl,
      apiKey: modelConfig.apiKey, providerName: modelConfig.providerName, protocolMode: modelConfig.protocolMode,
      candidateModels: [model], fastModel: model, strongModel: model, maxConcurrency: 1,
      requestCap: 4, retryLimit: 0, requestTimeoutMs: 90_000 });
    const provider = new AiProviderAdapter(modelConfig, { guard, root: directory });
    const adapter = { guard, scoreShot: async (input) => { await assertNoActiveProduction(); await assertProviderAvailable(config, model, { root }); return provider.scoreShot(input); } };
    const batch = { ...source, id: randomUUID(), status: "editing", files: source.files.filter((file) => ["products", "product_refs"].includes(file.kind)) };
    const started = Date.now();
    try {
      const result = await runSemanticShadow({ root, batch, batchDir: directory,
        shotPool: { ...pool, batchId: batch.id, shots: selected }, env, adapter, config: modelConfig,
        ffmpeg: runtime.ffmpegExecutable, concurrency: 1, quantumShotLimit: 4,
        shotBudgetMs: 95_000, stageBudgetMs: 7 * 60_000 });
      const performance = await readJson(path.join(directory, "semantic-performance.v1.json"), null);
      const records = result.evidence?.records || [];
      const latencies = performance?.shots?.filter((entry) => entry.resultStatus === "success").map((entry) => entry.latencyMs).filter(Number.isFinite) || [];
      report.models[model] = { complete: result.evidence?.complete === true && !result.continuation,
        scoredShots: records.filter((entry) => Boolean(entry.result)).length, requestedShots: selected.length,
        errors: records.filter((entry) => entry.status === "error").map((entry) => ({ shotId: entry.shotId, code: entry.error?.code || "UNKNOWN" })),
        stopReason: result.evidence?.stopReason || result.continuation?.reason || null,
        wallClockMs: Date.now() - started, p50ShotLatencyMs: quantile(latencies, 0.5), p95ShotLatencyMs: quantile(latencies, 0.95),
        requestCount: performance?.summary?.requestCount ?? null,
        scores: records.filter((entry) => entry.result).map((entry) => ({ shotId: entry.shotId, result: entry.result })) };
    } catch (error) {
      report.models[model] = { complete: false, wallClockMs: Date.now() - started, errorCode: error?.code || "UNKNOWN" };
      if (error?.code === "PRODUCTION_ACTIVE") { report.status = "STOPPED_FOR_PRODUCTION"; break; }
    }
    await writeJsonAtomic(reportPath, report);
    process.stdout.write(`${model}: ${JSON.stringify({ complete: report.models[model].complete, scoredShots: report.models[model].scoredShots, wallClockMs: report.models[model].wallClockMs, errors: report.models[model].errors, errorCode: report.models[model].errorCode })}\n`);
    if (model === "gpt-6-sol" && !report.models[model].complete) {
      report.status = "BASELINE_UNHEALTHY";
      report.stopReason = "Current production model did not complete all four semantic Shots; candidate comparisons cannot be interpreted as a fair model A/B.";
      break;
    }
  }
  for (const file of sourceSnapshot) {
    const info = await stat(file.path);
    if (info.size !== file.bytes || await hashFile(file.path) !== file.sha256) throw new Error("Source/reference changed during isolated screen");
  }
  if (report.status === "RUNNING") report.status = models.every((model) => report.models[model]?.complete) ? "SCREEN_COMPLETE" : "SCREEN_PARTIAL";
} catch (error) {
  report.status = "SCREEN_ABORTED";
  report.errorCode = error?.code || "SOURCE_OR_RUNTIME_ERROR";
} finally {
  report.finishedAt = new Date().toISOString();
  await writeJsonAtomic(reportPath, report);
  process.stdout.write(`${JSON.stringify({ status: report.status, reportPath })}\n`);
}
if (report.status !== "SCREEN_COMPLETE") process.exitCode = 1;
