#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AiProviderAdapter, ProviderAdapterError } from "../lib/ai-provider-adapter.mjs";
import { DurableProviderRequestGuard } from "../lib/ai-provider-guard.mjs";
import { resolveProviderConfig } from "../lib/ai-provider-config.mjs";
import { assertProviderAvailable } from "../lib/provider-incident.mjs";
import { readJson, writeJsonAtomic } from "../lib/atomic-json.mjs";
import { productReferencesForGroup } from "../lib/product-reference-match.mjs";
import { batchWorkspacePath } from "../lib/tenant-paths.mjs";
import { batchWorkPaths } from "../lib/work-paths.mjs";
import { semanticPrompt, SEMANTIC_PROMPT_VERSION } from "../worker/semantic-shadow.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const priorRun = "semantic-model-screen-2026-10-08T01-53-08-209Z";
const priorDir = path.join(root, ".project-governance", "evidence", "semantic-model-comparison", priorRun);
const sourceId = "6e1fc4a3-9fb4-4181-a158-2cdd86ebc4a6";
const shotId = "9af58eb4e9eb4d625a0297dbbc41dd55";
const attemptTarget = 40;
const runId = `provider-stability-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
const outputDir = path.join(root, ".project-governance", "evidence", "provider-stability", runId);
const activeStatuses = new Set(["reference_queued", "analyzing_reference", "creating_proxies", "detecting_products", "regroup_queued", "batch_queued", "editing", "revision_queued", "revising"]);

async function assertProductionIdle() {
  const batches = await readJson(path.join(root, "data", "batches.json"), []);
  if (batches.some((batch) => activeStatuses.has(batch.status))) throw Object.assign(new Error("Production Batch became active"), { code: "PRODUCTION_ACTIVE" });
  const queue = await readJson(path.join(root, "data", "service-queue.json"), null);
  if (queue?.tasks?.some((task) => !["completed", "manual", "canceled"].includes(task.status))) throw Object.assign(new Error("Production Queue became active"), { code: "PRODUCTION_ACTIVE" });
}

function fileHash(file) {
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

function summary(rows) {
  const requests = rows.flatMap((row) => row.requests);
  const completed = requests.filter((request) => Number.isInteger(request.httpStatus));
  const latencies = completed.map((request) => request.latencyMs).filter(Number.isFinite);
  const buckets = {};
  for (const request of requests) {
    const at = Date.parse(request.at);
    const key = Number.isFinite(at) ? new Date(Math.floor(at / 300000) * 300000).toISOString() : "unknown";
    buckets[key] ||= { total: 0, http200: 0, http502: 0, http429: 0, timeout: 0, invalidSchema: 0 };
    buckets[key].total += 1;
    if (request.httpStatus === 200) buckets[key].http200 += 1;
    if (request.httpStatus === 502) buckets[key].http502 += 1;
    if (request.httpStatus === 429) buckets[key].http429 += 1;
    if (request.timeout) buckets[key].timeout += 1;
    if (request.invalidSchema) buckets[key].invalidSchema += 1;
  }
  return {
    attempts: rows.length, httpRequests: requests.length, http200: completed.filter((request) => request.httpStatus === 200).length,
    http502: completed.filter((request) => request.httpStatus === 502).length,
    http429: completed.filter((request) => request.httpStatus === 429).length,
    timeout: requests.filter((request) => request.timeout).length,
    invalidSchema: rows.filter((row) => row.errorCode === "PROVIDER_MALFORMED_RESPONSE").length,
    retries: rows.reduce((sum, row) => sum + Math.max(0, row.requests.length - 1), 0),
    scored: rows.filter((row) => row.scored).length,
    successRate: rows.length ? rows.filter((row) => row.scored).length / rows.length : null,
    http200Rate: requests.length ? completed.filter((request) => request.httpStatus === 200).length / requests.length : null,
    http502Rate: requests.length ? completed.filter((request) => request.httpStatus === 502).length / requests.length : null,
    timeoutRate: requests.length ? requests.filter((request) => request.timeout).length / requests.length : null,
    p50HttpLatencyMs: quantile(latencies, 0.5), p95HttpLatencyMs: quantile(latencies, 0.95),
    firstRequestAt: requests[0]?.at || null, lastRequestAt: requests.at(-1)?.at || null,
    fiveMinuteBucketsUtc: buckets,
  };
}

await assertProductionIdle();
const source = (await readJson(path.join(root, "data", "batches.json"), [])).find((batch) => batch.id === sourceId);
if (!source || !["review", "completed"].includes(source.status)) throw new Error("Fixed real source Batch unavailable");
const pool = await readJson(path.join(batchWorkspacePath(root, source), "shot-pool.json"), null);
const shot = pool?.shots?.find((item) => item.id === shotId);
const groups = await readJson(path.join(priorDir, "gpt-6-sol", "product-groups.json"), null);
const group = groups?.groups?.find((item) => item.files?.some((file) => path.basename(shot?.path || "").toLowerCase() === path.basename(file).toLowerCase()));
const priorEvidence = await readJson(path.join(priorDir, "gpt-6-sol", "semantic-evidence.v1.json"), null);
const priorRecord = priorEvidence?.records?.find((item) => item.shotId === shotId);
if (!shot || !group || !priorRecord?.result || priorEvidence.promptVersion !== SEMANTIC_PROMPT_VERSION) throw new Error("Prior real semantic evidence unavailable");
const references = productReferencesForGroup(group, source.files.filter((file) => file.kind === "product_refs"), 2);
if (references.length !== 2) throw new Error("Fixed Shot does not have two traceable Product References");
const duration = Math.max(0.1, Number(shot.end) - Number(shot.start) || Number(shot.duration) || 0.1);
const position = Math.max(0, Number(shot.start || 0) + duration * 0.08).toFixed(3);
const stem = `${createHash("sha256").update(`${shot.id}:${position}`).digest("hex").slice(0, 24)}-1.jpg`;
const priorEnv = { CUT_WORK_ROOT: path.join(priorDir, "work") };
const frame = path.join(batchWorkPaths({ ...source, id: priorEvidence.batchId }, priorEnv).semanticFrames, stem);
const prompt = semanticPrompt({ shot, hardMetrics: { productVisibility: shot.productVisibility, productCentered: shot.productCentered, motionEnergy: shot.motionEnergy, duration: shot.duration, tags: shot.tags }, requirements: source.requirements });
if (createHash("sha256").update(prompt).digest("hex") !== priorRecord.inputFingerprint) throw new Error("Fixed production semantic prompt changed");
const inputFiles = [...references.map((file) => file.absolutePath || file.storagePath), frame];
const inputSnapshot = [];
for (const file of [shot.path, ...inputFiles]) {
  const info = await stat(file);
  if (!info.isFile() || info.size <= 0) throw new Error("Fixed source/reference/frame is unavailable");
  inputSnapshot.push({ path: file, bytes: info.size, sha256: await fileHash(file) });
}
const images = await Promise.all(inputFiles.map(async (file) => {
  const extension = path.extname(file).toLowerCase();
  const mime = extension === ".png" ? "image/png" : extension === ".webp" ? "image/webp" : "image/jpeg";
  return `data:${mime};base64,${(await readFile(file)).toString("base64")}`;
}));
const { config } = await resolveProviderConfig(root);
const productionPath = await readJson(path.join(root, "data", "production-path.json"), {});
if (!config.baseUrl || !config.apiKey || config.fastModel !== "gpt-6-sol" || config.strongModel !== "gpt-6-sol" || productionPath.modelFast !== "gpt-6-sol" || productionPath.modelStrong !== "gpt-6-sol") throw new Error("Production model contract changed");
const modelConfig = { ...config, maxConcurrency: 1, retryLimit: 0, pilotRequestCap: attemptTarget, requestTimeoutMs: 90_000 };
await mkdir(outputDir, { recursive: true });
const guard = new DurableProviderRequestGuard({ root: outputDir, providerId: modelConfig.providerId, baseUrl: modelConfig.baseUrl,
  apiKey: modelConfig.apiKey, providerName: modelConfig.providerName, protocolMode: modelConfig.protocolMode,
  candidateModels: ["gpt-6-sol"], fastModel: "gpt-6-sol", strongModel: "gpt-6-sol",
  maxConcurrency: 1, requestCap: attemptTarget, retryLimit: 0, requestTimeoutMs: 90_000 });
const adapter = new AiProviderAdapter(modelConfig, { guard, root: outputDir });
const report = { artifact: "cut-provider-stability.v1", runId, status: "RUNNING", createdAt: new Date().toISOString(),
  model: "gpt-6-sol", sourceBatchId: sourceId, shotId, promptVersion: SEMANTIC_PROMPT_VERSION,
  inputFingerprint: priorRecord.inputFingerprint, inputSnapshot, targetRequests: attemptTarget,
  samePromptSchemaImages: true, concurrency: 1, retryLimit: 0, requestTimeoutMs: 90_000, shotBudgetMs: 90_000,
  productionConfigChanged: false, rows: [], summary: null,
  limitation: "One fixed real Shot measures this Provider route over one observation window; not a full-day or production Batch success-rate estimate." };
const reportPath = path.join(outputDir, "report.json");
await writeJsonAtomic(reportPath, report);
let consecutive502 = 0;
try {
  for (let index = 0; index < attemptTarget; index += 1) {
    await assertProductionIdle();
    await assertProviderAvailable(config, "gpt-6-sol", { root });
    const startedAt = new Date().toISOString();
    const events = [];
    let scored = false;
    let errorCode = null;
    let errorStatus = null;
    let resultSignature = null;
    const controller = new AbortController();
    const budgetCode = "SEMANTIC_SHOT_BUDGET_EXCEEDED";
    const timer = setTimeout(() => controller.abort(new ProviderAdapterError(budgetCode, { code: budgetCode, retryable: false })), 90_000);
    try {
      const response = await adapter.scoreShot({ model: "gpt-6-sol", prompt, images, shotId,
        signal: controller.signal,
        onRequestEvent: async (event) => { events.push({ ...event }); } });
      scored = true;
      resultSignature = { shot_type: response.result.shot_type, usable: response.result.usable, product_match: response.result.product_match };
    } catch (error) {
      errorCode = controller.signal.aborted ? controller.signal.reason?.code || budgetCode : error?.code || "UNKNOWN";
      errorStatus = Number(error?.status) || null;
    } finally {
      clearTimeout(timer);
    }
    const starts = events.filter((event) => event.phase === "start");
    const ends = events.filter((event) => event.phase === "end");
    const requests = starts.map((start) => {
      const end = ends.find((item) => item.requestId === start.requestId);
      return { at: start.at || startedAt, httpStatus: Number(end?.httpStatus) || errorStatus,
        latencyMs: Number.isFinite(end?.latencyMs) ? end.latencyMs : null,
        timeout: end?.timeout === true || ["PROVIDER_TIMEOUT", budgetCode].includes(errorCode),
        invalidSchema: errorCode === "PROVIDER_MALFORMED_RESPONSE" };
    });
    report.rows.push({ index: index + 1, startedAt, endedAt: new Date().toISOString(), scored, errorCode, errorStatus, requests, resultSignature });
    report.summary = summary(report.rows);
    await writeJsonAtomic(reportPath, report);
    consecutive502 = requests.some((request) => request.httpStatus === 502) ? consecutive502 + 1 : 0;
    if (requests.length === 0) { report.status = "STOPPED_NO_DISPATCH"; break; }
    if (requests.some((request) => request.httpStatus === 429)) { report.status = "STOPPED_PROVIDER_BACKPRESSURE"; break; }
    if (consecutive502 >= 3) { report.status = "STOPPED_REPEATED_502"; break; }
    if ((index + 1) % 5 === 0) process.stdout.write(`${JSON.stringify({ attempts: index + 1, http200: report.summary.http200, http502: report.summary.http502, timeout: report.summary.timeout, successRate: report.summary.successRate })}\n`);
  }
  if (report.status === "RUNNING") report.status = report.rows.length === attemptTarget ? "COMPLETE" : "INCOMPLETE";
} catch (error) {
  report.status = error?.code === "PRODUCTION_ACTIVE" ? "STOPPED_FOR_PRODUCTION" : "ABORTED";
  report.stopCode = error?.code || "UNKNOWN";
} finally {
  report.finishedAt = new Date().toISOString();
  report.summary = summary(report.rows);
  await writeJsonAtomic(reportPath, report);
  process.stdout.write(`${JSON.stringify({ status: report.status, reportPath, summary: report.summary })}\n`);
}
if (report.status !== "COMPLETE") process.exitCode = 1;
