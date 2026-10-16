#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AiProviderAdapter } from "../lib/ai-provider-adapter.mjs";
import { DurableProviderRequestGuard } from "../lib/ai-provider-guard.mjs";
import { resolveProviderConfig } from "../lib/ai-provider-config.mjs";
import { assertProviderAvailable } from "../lib/provider-incident.mjs";
import { readJson, writeJsonAtomic } from "../lib/atomic-json.mjs";
import { batchWorkspacePath } from "../lib/tenant-paths.mjs";
import { readQualityEvidenceV2, validateWithQualityGateV2 } from "../worker/quality-gate-v2.mjs";
import { loadRuntimeConfig } from "../worker/runtime-config.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(root, "benchmarks", "quality-gate-v2", "reference-v1", "reference-valid-manifest.v1.json");
const models = ["gpt-6-sol", "gpt-6.1-sol", "gpt-6-luna"];
const verifyOnly = process.argv.includes("--verify-only");
const runId = `model-screen-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
const outputDir = path.join(root, ".project-governance", "evidence", "model-comparison", runId);
const activeStatuses = new Set(["reference_queued", "analyzing_reference", "creating_proxies", "detecting_products", "regroup_queued", "batch_queued", "editing", "revision_queued", "revising"]);

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const digest = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("data", (chunk) => digest.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolve(digest.digest("hex")));
  });
}

function selectSamples(manifest, batchIndex) {
  const confirmed = manifest.samples.filter((sample) => {
    const batch = batchIndex.get(sample.batchId);
    const file = batch?.files?.find((entry) => entry.id === sample.fileId && entry.kind === "products");
    return sample.groundTruth?.status === "confirmed" && sample.groundTruth?.annotatedFrom === "manual" && Boolean(file?.absolutePath || file?.storagePath);
  });
  const sorted = (predicate) => confirmed.filter(predicate).sort((a, b) => a.id.localeCompare(b.id)).slice(0, 4);
  const wrongSku = sorted((sample) => sample.groundTruth.wrongSku === true && sample.groundTruth.expectedVerdict === "reject");
  const artifact = sorted((sample) => sample.groundTruth.expectedVerdict === "reject" && sample.groundTruth.wrongSku !== true && ["handArtifact", "bodyArtifact", "objectArtifact", "temporalArtifact"].some((key) => sample.groundTruth[key] === true));
  const acceptable = sorted((sample) => sample.groundTruth.expectedVerdict === "accept");
  if ([wrongSku, artifact, acceptable].some((group) => group.length !== 4)) throw new Error("Frozen human-labelled sample strata are incomplete");
  return [...wrongSku, ...artifact, ...acceptable].map((sample, index) => ({ ...sample, stratum: index < 4 ? "wrong_sku" : index < 8 ? "artifact_reject" : "accept" }));
}

async function assertNoActiveProduction() {
  const batches = await readJson(path.join(root, "data", "batches.json"), []);
  const active = batches.filter((batch) => activeStatuses.has(batch.status));
  if (active.length) throw new Error(`Production became active; isolated comparison paused before dispatch (${active.length} active Batch)`);
}

function quantile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function summarize(rows) {
  const measured = rows.filter((row) => Number.isFinite(row.providerLatencyMs));
  return {
    evaluated: rows.length,
    providerComplete: rows.filter((row) => row.analysisStatus === "complete").length,
    providerErrors: rows.filter((row) => ["provider_error", "schema_invalid"].includes(row.analysisStatus)).length,
    criticalMisses: rows.filter((row) => row.expectedVerdict === "reject" && row.verdict === "accept").map((row) => row.sampleId),
    wrongSkuAccepted: rows.filter((row) => row.stratum === "wrong_sku" && row.verdict === "accept").map((row) => row.sampleId),
    acceptFalseRejects: rows.filter((row) => row.stratum === "accept" && row.verdict === "reject").map((row) => row.sampleId),
    reviewCases: rows.filter((row) => row.verdict === "review").map((row) => row.sampleId),
    p50ProviderLatencyMs: quantile(measured.map((row) => row.providerLatencyMs), 0.5),
    p95ProviderLatencyMs: quantile(measured.map((row) => row.providerLatencyMs), 0.95),
    p50EndToEndMs: quantile(rows.map((row) => row.wallClockMs), 0.5),
    p95EndToEndMs: quantile(rows.map((row) => row.wallClockMs), 0.95),
  };
}

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const batches = await readJson(path.join(root, "data", "batches.json"), []);
const batchIndex = new Map(batches.map((batch) => [batch.id, batch]));
const selected = selectSamples(manifest, batchIndex);
const sourceChecks = [];
const referenceChecks = [];
const verifiedFiles = new Map();
for (const sample of selected) {
  const batch = batchIndex.get(sample.batchId);
  const file = batch?.files?.find((entry) => entry.id === sample.fileId && entry.kind === "products");
  const source = file?.absolutePath || file?.storagePath;
  if (!source || !sample.source?.sha256 || !Number.isFinite(sample.source.bytes)) throw new Error(`Incomplete frozen source: ${sample.id}`);
  const info = await stat(source);
  const actualHash = await hashFile(source);
  const match = info.size === sample.source.bytes && actualHash === sample.source.sha256;
  sourceChecks.push({ sampleId: sample.id, status: match ? "match" : "mismatch", expectedSha256: sample.source.sha256, actualSha256: actualHash });
  if (!match) throw new Error(`Frozen source mismatch: ${sample.id}`);
  const references = sample.referenceOverride?.references?.length
    ? sample.referenceOverride.references.map((reference) => ({ sourcePath: reference.sourcePath, expectedSha256: reference.sha256 || null }))
    : (sample.referenceFileIds || []).map((id) => {
      const reference = batch.files.find((entry) => entry.id === id && entry.kind === "product_refs");
      return { sourcePath: reference?.absolutePath || reference?.storagePath || null, expectedSha256: reference?.sha256 || null };
    });
  if (!references.length || references.some((reference) => !reference.sourcePath)) throw new Error(`Reference source unavailable: ${sample.id}`);
  for (const reference of references) {
    let checked = verifiedFiles.get(reference.sourcePath);
    if (!checked) {
      const referenceInfo = await stat(reference.sourcePath);
      checked = { bytes: referenceInfo.size, sha256: await hashFile(reference.sourcePath) };
      verifiedFiles.set(reference.sourcePath, checked);
    }
    if (reference.expectedSha256 && reference.expectedSha256 !== checked.sha256) throw new Error(`Frozen reference mismatch: ${sample.id}`);
    referenceChecks.push({ sampleId: sample.id, sha256: checked.sha256, bytes: checked.bytes, matchedFrozenHash: reference.expectedSha256 ? true : null });
  }
}

const report = {
  artifact: "cut-provider-model-screen.v1",
  runId,
  createdAt: new Date().toISOString(),
  productionConfigChanged: false,
  sourceManifest: path.relative(root, manifestPath).replaceAll("\\", "/"),
  manifestVersion: `${manifest.manifestVersion}-model-screen.v1`,
  policyVersion: manifest.policyVersion,
  selectionRule: "first four ID-sorted, currently indexed, confirmed human-labelled samples per stratum; screening only",
  sourceChecks,
  referenceChecks,
  selected: selected.map((sample) => ({ id: sample.id, stratum: sample.stratum, expectedVerdict: sample.groundTruth.expectedVerdict, groundTruth: sample.groundTruth, sha256: sample.source.sha256 })),
  models: Object.fromEntries(models.map((model) => [model, { rows: [], summary: null }])),
  status: verifyOnly ? "SOURCE_VERIFIED_ONLY" : "RUNNING",
  limitation: "12 frozen reference-valid samples are a screening subset, not a full benchmark, repeatability test, render Canary, or production cutover.",
};
await mkdir(outputDir, { recursive: true });
const reportPath = path.join(outputDir, "report.json");
await writeJsonAtomic(reportPath, report);
if (verifyOnly) {
  console.log(JSON.stringify({ status: report.status, sourceVerified: sourceChecks.length, referencesVerified: referenceChecks.length, output: reportPath }));
  process.exit(0);
}

const resolved = await resolveProviderConfig(root);
const productionPath = await readJson(path.join(root, "data", "production-path.json"), {});
if (!resolved.config.baseUrl || !resolved.config.apiKey || resolved.config.fastModel !== "gpt-6-sol" || resolved.config.strongModel !== "gpt-6-sol" || productionPath.modelStrong !== "gpt-6-sol") {
  throw new Error("Current production Provider/model contract changed; comparison refused before dispatch");
}
await assertNoActiveProduction();
const ffmpeg = (await loadRuntimeConfig(root)).ffmpegExecutable;
const runners = new Map();
for (const model of models) {
  const config = { ...resolved.config, fastModel: model, strongModel: model, maxConcurrency: 1, pilotRequestCap: 24, retryLimit: 0, requestTimeoutMs: 90_000 };
  const guard = new DurableProviderRequestGuard({
    root: path.join(outputDir, model),
    providerId: config.providerId,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    providerName: config.providerName,
    protocolMode: config.protocolMode,
    candidateModels: [model],
    fastModel: model,
    strongModel: model,
    maxConcurrency: 1,
    requestCap: 24,
    retryLimit: 0,
    requestTimeoutMs: 90_000,
  });
  runners.set(model, new AiProviderAdapter(config, { guard, root: path.join(outputDir, model) }));
}

try {
  for (const sample of selected) {
    const batch = batchIndex.get(sample.batchId);
    const file = batch.files.find((entry) => entry.id === sample.fileId && entry.kind === "products");
    const batchDir = batchWorkspacePath(root, batch);
    const referenceOverrides = sample.referenceOverride?.references?.map((reference) => ({ ...reference, absolutePath: reference.sourcePath, name: reference.mappedFilename })) || [];
    for (const model of models) {
      await assertNoActiveProduction();
      await assertProviderAvailable(resolved.config, model, { root });
      const artifactDir = path.join(outputDir, model, sample.id);
      const started = Date.now();
      let verdict = "review";
      let exception = null;
      try {
        const result = await validateWithQualityGateV2({
          root, batch, batchDir, sourceBatchDir: batchDir, artifactDir, evidenceStateDir: artifactDir,
          file, ffmpeg, referenceOverrides, adapter: runners.get(model),
          env: { ...process.env, MODEL_FAST: model, MODEL_STRONG: model },
        });
        verdict = result.verdict;
      } catch (error) {
        exception = { code: String(error?.code || "UNEXPECTED"), message: String(error?.message || error).slice(0, 300) };
      }
      const evidence = await readQualityEvidenceV2(artifactDir);
      const source = evidence?.sources?.find((entry) => entry.sourceId === file.id);
      const row = {
        sampleId: sample.id, stratum: sample.stratum, expectedVerdict: sample.groundTruth.expectedVerdict,
        verdict, analysisStatus: source?.analysisStatus || (exception ? "exception" : "missing_evidence"),
        providerErrorCode: source?.providerError?.code || exception?.code || null,
        providerLatencyMs: source?.telemetry?.latencyMs ?? null,
        wallClockMs: Date.now() - started,
      };
      report.models[model].rows.push(row);
      report.models[model].summary = summarize(report.models[model].rows);
      await writeJsonAtomic(reportPath, report);
      console.log(JSON.stringify({ model, sample: sample.id, verdict, analysisStatus: row.analysisStatus, providerLatencyMs: row.providerLatencyMs, completed: report.models[model].rows.length }));
      if (row.providerErrorCode === "PROVIDER_BACKPRESSURE") throw new Error("Provider backpressure; comparison stopped without further dispatch");
      if (report.models[model].summary.providerErrors >= 2) throw new Error(`Repeated Provider errors for ${model}; comparison stopped`);
    }
  }
  report.status = "SCREEN_COMPLETE_NOT_PRODUCTION_ELIGIBLE";
} catch (error) {
  report.status = "SCREEN_PARTIAL_STOPPED";
  report.stopReason = String(error?.message || error).slice(0, 300);
  process.exitCode = 1;
}
report.finishedAt = new Date().toISOString();
await writeJsonAtomic(reportPath, report);
console.log(JSON.stringify({ status: report.status, output: reportPath, summaries: Object.fromEntries(models.map((model) => [model, report.models[model].summary])), stopReason: report.stopReason || null }));
