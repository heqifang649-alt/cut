import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readdir } from "node:fs/promises";
import { readJson, writeJsonAtomic } from "../lib/atomic-json.mjs";
import { batchWorkspacePath } from "../lib/tenant-paths.mjs";
import { resolveProviderConfig } from "../lib/ai-provider-config.mjs";
import { runSemanticShadow } from "../worker/semantic-shadow.mjs";
import { loadRuntimeConfig } from "../worker/runtime-config.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argument = (name) => process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3);
const sourceId = argument("source");
const shotCount = Number(argument("shots") || 12);
if (!sourceId || !Number.isInteger(shotCount) || shotCount < 4 || shotCount > 24) {
  throw new Error("Usage: node scripts/canary-semantic-concurrency.mjs --source=<completed-or-review-batch-id> [--shots=4..24]");
}

const runtime = await loadRuntimeConfig(ROOT);
const { config } = await resolveProviderConfig(ROOT);
if (!config.baseUrl || !config.apiKey || !config.fastModel || config.maxConcurrency < 2) {
  throw new Error("Current Provider is not ready for an isolated two-lane Canary");
}
const batches = await readJson(path.join(ROOT, "data", "batches.json"), []);
const source = batches.find((item) => item.id === sourceId);
if (!source || !["review", "completed"].includes(source.status)) {
  throw new Error("Canary source must be an existing review/completed Batch; no live Batch is mutated");
}
const sourceDir = batchWorkspacePath(ROOT, source);
const pool = await readJson(path.join(sourceDir, "shot-pool.json"), null);
const groups = await readJson(path.join(sourceDir, "product-groups.json"), null);
if (!Array.isArray(pool?.shots) || pool.shots.length < shotCount || !Array.isArray(groups?.groups)) {
  throw new Error("Canary source lacks the requested real ShotPool and Product Groups");
}

const runId = `semantic-concurrency-${new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-")}`;
const evidenceDir = path.join(ROOT, ".project-governance", "evidence", "semantic-concurrency", runId);
await mkdir(evidenceDir, { recursive: true });
const selected = pool.shots.slice(0, shotCount);
const shotIds = selected.map((item) => item.id);
await writeJsonAtomic(path.join(evidenceDir, "selection.json"), {
  runId, sourceBatchId: source.id, shotIds, model: config.fastModel,
  providerScopeFingerprint: crypto.createHash("sha256").update(config.baseUrl).digest("hex").slice(0, 16),
  runtimeRevision: runtime.runtimeRevision,
});

async function requestMetrics(directory) {
  const eventDir = path.join(directory, "semantic-history", "events");
  const files = await readdir(eventDir).catch(() => []);
  const events = (await Promise.all(files.filter((name) => name.endsWith(".json"))
    .map((name) => readJson(path.join(eventDir, name), null)))).filter(Boolean);
  const requests = events.filter((item) => item.kind === "request_start" || item.kind === "request_end");
  const intervals = requests
    .map((item) => ({ at: Date.parse(item.kind === "request_start" ? item.startAt : item.endAt), delta: item.kind === "request_start" ? 1 : -1 }))
    .filter((item) => Number.isFinite(item.at)).sort((a, b) => a.at - b.at || a.delta - b.delta);
  let active = 0; let peak = 0;
  for (const item of intervals) { active = Math.max(0, active + item.delta); peak = Math.max(peak, active); }
  return { peak, http429: requests.filter((item) => item.kind === "request_end" && item.httpStatus === 429).length };
}

async function runLane(concurrency) {
  const directory = path.join(evidenceDir, concurrency === 1 ? "single" : "dual");
  await mkdir(directory, { recursive: true });
  await writeJsonAtomic(path.join(directory, "product-groups.json"), groups);
  const batch = { ...source, id: crypto.randomUUID(), status: "editing", files: source.files.filter((file) => file.kind === "products" || file.kind === "product_refs") };
  const env = {
    ...process.env,
    ENABLE_HYBRID_PILOT: "true",
    ENABLE_API_SEMANTIC_SCORER: "true",
    ENABLE_NEW_SHOTPOOL: "true",
    ENABLE_FAIR_MULTI_BATCH_SCHEDULER: "true",
  };
  const startedAt = new Date().toISOString();
  const started = Date.now();
  let result;
  try {
    result = await runSemanticShadow({ root: ROOT, batch, batchDir: directory, shotPool: { ...pool, batchId: batch.id, shots: selected }, env, config,
      ffmpeg: runtime.ffmpegExecutable, concurrency, quantumShotLimit: shotCount, stageBudgetMs: 20 * 60_000 });
  } catch (error) {
    await writeJsonAtomic(path.join(directory, "canary-error.json"), { code: error?.code || "UNKNOWN", message: String(error?.message || error).slice(0, 500) });
    throw error;
  }
  const performance = await readJson(path.join(directory, "semantic-performance.v1.json"), null);
  const records = result.evidence?.records || [];
  const requests = await requestMetrics(directory);
  const summary = {
    concurrency, batchId: batch.id, startedAt, endedAt: new Date().toISOString(), wallClockMs: Date.now() - started,
    requestedShots: shotCount, scoredShots: records.filter((item) => item.result).length,
    complete: result.evidence?.complete === true && !result.continuation,
    stopReason: result.evidence?.stopReason || result.continuation?.reason || null,
    observedRequestPeak: requests.peak, http429: requests.http429,
    providerTimeMs: performance?.summary?.totalProviderTimeMs ?? null,
    p50ShotLatencyMs: performance?.summary?.p50LatencyMs ?? null,
    p95ShotLatencyMs: performance?.summary?.p95LatencyMs ?? null,
    timeoutRate: performance?.summary?.timeoutRate ?? null,
    successRate: performance?.summary?.successRate ?? null,
    requestCount: performance?.summary?.requestCount ?? null,
    circuit: result.evidence?.guard?.circuit?.state || null,
  };
  await writeJsonAtomic(path.join(directory, "summary.json"), summary);
  return summary;
}

const single = await runLane(1);
if (!single.complete || single.scoredShots !== shotCount) throw new Error("Single-lane baseline did not finish; dual-lane Canary will not start");
const dual = await runLane(2);
const report = {
  runId, sourceBatchId: source.id, model: config.fastModel, single, dual,
  passed: dual.complete && dual.scoredShots === shotCount && dual.observedRequestPeak === 2 && dual.http429 === 0 && dual.timeoutRate === 0
    && dual.circuit !== "OPEN" && dual.wallClockMs < single.wallClockMs,
  limitation: "Isolated real-shot semantic Canary only; no Batch render or independent creative Review is claimed.",
};
await writeJsonAtomic(path.join(evidenceDir, "report.json"), report);
process.stdout.write(`${JSON.stringify({ evidenceDir, ...report }, null, 2)}\n`);
if (!report.passed) process.exitCode = 1;
