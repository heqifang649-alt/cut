#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AiProviderAdapter, ProviderAdapterError } from '../lib/ai-provider-adapter.mjs';
import { DurableProviderRequestGuard } from '../lib/ai-provider-guard.mjs';
import { resolveProviderConfig } from '../lib/ai-provider-config.mjs';
import { assertProviderAvailable } from '../lib/provider-incident.mjs';
import { readJson, writeJsonAtomic } from '../lib/atomic-json.mjs';
import { batchWorkspacePath } from '../lib/tenant-paths.mjs';
import { extractRepresentativeFrames, semanticPrompt, SEMANTIC_PROMPT_VERSION } from '../worker/semantic-shadow.mjs';
import { SEMANTIC_SHOT_SCHEMA_VERSION } from '../lib/semantic-shot.mjs';
import { loadRuntimeConfig } from '../worker/runtime-config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packDir = path.join(root, 'outputs', 'cut-semantic-human-label-2026-10-08');
const manifestPath = path.join(packDir, 'manifest.json');
const expectedManifestSha = '771ad96aaa6b6ab50922b335212c904c06e8e13ec2c458170413daa392a5a61c';
const expectedLabelsSha = 'b6894377110fd5821800a194075e647badc09ebefe534689376277b2e1358162';
const labelsPath = path.join(packDir, 'frozen-ground-truth', `human-labels-${expectedLabelsSha}.json`);
const models = ['gpt-6-sol', 'gpt-6.1-sol', 'gpt-6-luna'];
const preflightOnly = process.argv.includes('--preflight');
const runArg = process.argv.indexOf('--run-dir');
const outputDir = runArg >= 0 ? path.resolve(process.argv[runArg + 1] || '') :
  path.join(packDir, 'semantic-gt-comparison', `run-${new Date().toISOString().replaceAll(/[:.]/g, '-')}`);
const activeStatuses = new Set(['reference_queued', 'analyzing_reference', 'creating_proxies', 'detecting_products', 'regroup_queued', 'batch_queued', 'editing', 'revision_queued', 'revising']);
const required = ['verdict', 'wrongSku', 'productErrorType', 'severity', 'usable', 'shotType', 'visibility', 'blur', 'occlusion', 'confusingProduct'];

if (runArg >= 0 && (!process.argv[runArg + 1] || process.argv[runArg + 1].startsWith('--'))) throw new Error('--run-dir requires a path');
if (!outputDir.startsWith(`${path.join(packDir, 'semantic-gt-comparison')}${path.sep}`)) throw new Error('Run directory must stay inside benchmark output root');

const sha = (value) => createHash('sha256').update(value).digest('hex');
function hashFile(file) {
  return new Promise((resolve, reject) => {
    const digest = createHash('sha256');
    const stream = createReadStream(file);
    stream.on('data', (chunk) => digest.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolve(digest.digest('hex')));
  });
}
const quantile = (values, portion) => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * portion) - 1] : null;

async function assertProductionIdle() {
  const batches = await readJson(path.join(root, 'data', 'batches.json'), []);
  const queue = await readJson(path.join(root, 'data', 'service-queue.json'), {});
  if (batches.some((batch) => activeStatuses.has(batch.status)) ||
      queue.tasks?.some((task) => !['completed', 'manual', 'canceled'].includes(task.status))) {
    throw Object.assign(new Error('Production work became active; benchmark paused before another request'), { code: 'PRODUCTION_ACTIVE' });
  }
}

function labelComplete(label) {
  if (!label || required.some((field) => typeof label[field] !== 'string' || !label[field])) return false;
  if (label.verdict === 'ACCEPT' && (label.wrongSku !== 'NO' || label.productErrorType !== 'NONE' ||
      label.severity !== 'NONE' || label.usable !== 'YES' || label.visibility !== 'CLEAR' ||
      label.blur !== 'NO' || label.occlusion !== 'NO' || label.confusingProduct !== 'NO')) return false;
  return true;
}

function chooseSamples(manifest, labels) {
  const byId = new Map(labels.samples.map((item) => [item.sampleId, item.annotation]));
  if (byId.size !== 196 || labels.completedCount !== 196 || manifest.rows.length !== 196) throw new Error('Expected 196 complete independent labels');
  for (let i = 0; i < manifest.rows.length; i++) {
    const id = manifest.rows[i].sampleId;
    if (labels.samples[i]?.sampleId !== id || !labelComplete(byId.get(id))) throw new Error(`Human label missing or conflicting: ${id}`);
  }
  const rejects = manifest.rows.filter((row) => byId.get(row.sampleId).verdict === 'REJECT');
  const accepts = manifest.rows.filter((row) => byId.get(row.sampleId).verdict === 'ACCEPT');
  if (rejects.length > 100 || rejects.length + accepts.length !== 196) throw new Error('Unexpected verdict universe');
  const selectedAccepts = accepts.sort((a, b) => sha(a.sampleId).localeCompare(sha(b.sampleId))).slice(0, 100 - rejects.length);
  return [...rejects, ...selectedAccepts].sort((a, b) => a.sampleId.localeCompare(b.sampleId));
}

function coverage(selected, labels) {
  const byId = new Map(labels.samples.map((item) => [item.sampleId, item.annotation]));
  const values = selected.map((row) => byId.get(row.sampleId));
  const count = (predicate) => values.filter(predicate).length;
  return {
    shots: values.length, accept: count((x) => x.verdict === 'ACCEPT'), reject: count((x) => x.verdict === 'REJECT'),
    wrongSku: count((x) => x.wrongSku === 'YES'), productError: count((x) => !['NONE', 'UNCERTAIN'].includes(x.productErrorType)),
    unusable: count((x) => x.usable === 'NO'), blur: count((x) => x.blur === 'YES'),
    occlusion: count((x) => x.occlusion === 'YES'), lowVisibility: count((x) => x.visibility === 'LOW'),
    confusingProduct: count((x) => x.confusingProduct === 'YES'),
  };
}

function summarize(rows, sampleCount) {
  const successful = rows.filter((row) => row.result);
  const latencies = successful.map((row) => row.latencyMs).filter(Number.isFinite);
  const requests = rows.flatMap((row) => row.requests);
  const counts = (status) => requests.filter((entry) => entry.httpStatus === status).length;
  const started = rows[0] ? Date.parse(rows[0].startedAt) : null;
  const finished = rows.at(-1) ? Date.parse(rows.at(-1).endedAt) : null;
  const wallMs = started !== null && finished !== null ? Math.max(0, finished - started) : null;
  return { attempted: rows.length, target: sampleCount, scored: successful.length, successRate: rows.length ? successful.length / rows.length : null,
    httpRequests: requests.length, http200: counts(200), http502: counts(502), http429: counts(429),
    timeout: rows.filter((row) => row.timeout).length, invalidSchema: rows.filter((row) => row.errorCode === 'PROVIDER_MALFORMED_RESPONSE').length,
    retry: Math.max(0, requests.length - rows.length), p50LatencyMs: quantile(latencies, 0.5), p95LatencyMs: quantile(latencies, 0.95),
    wallMs, shotsPerHour: wallMs > 0 ? successful.length * 3_600_000 / wallMs : null };
}

await assertProductionIdle();
if (await hashFile(manifestPath) !== expectedManifestSha || await hashFile(labelsPath) !== expectedLabelsSha) throw new Error('Frozen manifest or human-label SHA-256 changed');
const manifest = await readJson(manifestPath, null);
const labels = await readJson(labelsPath, null);
if (manifest?.artifact !== 'cut-semantic-human-label-pack.v1' || labels?.artifact !== 'cut-semantic-shot-human-labels.v1' ||
    labels.manifestSha256 !== expectedManifestSha) throw new Error('Frozen pack/label contract mismatch');
const selected = chooseSamples(manifest, labels);
const selectedCoverage = coverage(selected, labels);
if (selected.length !== 100 || selectedCoverage.wrongSku < 20 || selectedCoverage.productError < 5) throw new Error('Selected subset lacks required product-error coverage');
const batches = await readJson(path.join(root, 'data', 'batches.json'), []);
const batchById = new Map(batches.map((batch) => [batch.id, batch]));
const poolByBatch = new Map();
for (const row of selected) {
  if (poolByBatch.has(row.batchId)) continue;
  const batch = batchById.get(row.batchId);
  if (!batch || !['review', 'completed'].includes(batch.status)) throw new Error(`Frozen Batch unavailable: ${row.batchId}`);
  const pool = await readJson(path.join(batchWorkspacePath(root, batch), 'shot-pool.json'), null);
  if (!Array.isArray(pool?.shots)) throw new Error(`ShotPool unavailable: ${row.batchId}`);
  poolByBatch.set(row.batchId, new Map(pool.shots.map((shot) => [shot.id, shot])));
}
const runtime = await loadRuntimeConfig(root);
const runEnv = { ...process.env, CUT_WORK_ROOT: path.join(outputDir, 'work') };
await mkdir(outputDir, { recursive: true });

// Verify every selected source and reference against the frozen sample manifest before an API call.
const sourcePaths = new Set(selected.flatMap((row) => [row.sourcePath, ...row.referencePaths]));
for (const file of sourcePaths) {
  const frozen = manifest.sourceFiles?.[file];
  if (!frozen || !(await stat(file)).isFile() || await hashFile(file) !== frozen.sha256) throw new Error(`Frozen source changed: ${file}`);
}

const inputs = [];
for (const [position, row] of selected.entries()) {
  const batch = batchById.get(row.batchId);
  const original = poolByBatch.get(row.batchId).get(row.shotId);
  if (!original) throw new Error(`ShotPool did not contain ${row.sampleId}`);
  const shot = { ...original, id: row.shotId, path: row.sourcePath, start: row.startSeconds, end: row.endSeconds,
    duration: row.endSeconds - row.startSeconds };
  const prompt = semanticPrompt({ shot, hardMetrics: { productVisibility: shot.productVisibility, productCentered: shot.productCentered,
    motionEnergy: shot.motionEnergy, duration: shot.duration, tags: shot.tags }, requirements: batch.requirements });
  const frames = await extractRepresentativeFrames({ root, batch, batchDir: batchWorkspacePath(root, batch), shot,
    env: runEnv, ffmpeg: runtime.ffmpegExecutable, maxImages: 3 - row.referencePaths.length });
  const imagePaths = [...row.referencePaths, ...frames.slice(0, 3 - row.referencePaths.length)];
  if (imagePaths.length !== 3) throw new Error(`Three-image semantic input unavailable: ${row.sampleId}`);
  const imageHashes = await Promise.all(imagePaths.map(hashFile));
  inputs.push({ sampleId: row.sampleId, shotId: row.shotId, prompt, imagePaths, imageHashes,
    promptSha256: sha(prompt), inputFingerprint: sha(JSON.stringify({ prompt, imageHashes, schema: SEMANTIC_SHOT_SCHEMA_VERSION })) });
  if ((position + 1) % 20 === 0) process.stdout.write(`prepared ${position + 1}/${selected.length} frozen semantic inputs\n`);
}

const { config } = await resolveProviderConfig(root);
const productionPath = await readJson(path.join(root, 'data', 'production-path.json'), {});
if (!config.baseUrl || !config.apiKey || config.fastModel !== 'gpt-6-sol' || config.strongModel !== 'gpt-6-sol' ||
    productionPath.modelFast !== 'gpt-6-sol' || productionPath.modelStrong !== 'gpt-6-sol') throw new Error('Production provider/model contract changed');
const reportPath = path.join(outputDir, 'report.json');
const prior = await readJson(reportPath, null);
const report = prior || { artifact: 'cut-semantic-gt-comparison.v1', runId: path.basename(outputDir), createdAt: new Date().toISOString(),
  status: 'READY', frozenLabelsSha256: expectedLabelsSha, frozenManifestSha256: expectedManifestSha,
  promptVersion: SEMANTIC_PROMPT_VERSION, schemaVersion: SEMANTIC_SHOT_SCHEMA_VERSION,
  providerGroupContext: 'User reported an API group change on 2026-10-09; group identity is external and not independently verified. This run excludes prior-group attempts.',
  method: 'CUT semanticPrompt + AiProviderAdapter.scoreShot; same frozen images/prompt/schema; single channel; no retries; no Scheduler/Quality Gate/production-model mutation',
  selectionRule: 'all 25 human REJECT shots + lowest SHA-256(sampleId) 75 ACCEPT shots; sorted by sampleId',
  coverage: selectedCoverage, selection: inputs.map(({ sampleId, shotId, imageHashes, promptSha256, inputFingerprint }) =>
    ({ sampleId, shotId, imageHashes, promptSha256, inputFingerprint })),
  limits: { samples: 100, concurrency: 1, retryLimit: 0, timeoutMs: 90_000, requestCapPerModel: 100 }, models: {},
  limitation: 'Frozen sample has zero human-positive blur, occlusion, low-visibility, or confusing-product cases. Product/usable/shot-type track only; not a complete model-selection gate.' };
if (prior && (prior.frozenLabelsSha256 !== expectedLabelsSha || prior.frozenManifestSha256 !== expectedManifestSha ||
    JSON.stringify(prior.selection) !== JSON.stringify(inputs.map(({ sampleId, shotId, imageHashes, promptSha256, inputFingerprint }) =>
      ({ sampleId, shotId, imageHashes, promptSha256, inputFingerprint }))))) throw new Error('Resume input snapshot changed');
await writeJsonAtomic(reportPath, report);
if (preflightOnly) { process.stdout.write(JSON.stringify({ status: 'PREFLIGHT_PASS', coverage: report.coverage, reportPath }) + '\n'); process.exit(0); }

try {
  report.status = 'RUNNING';
  await writeJsonAtomic(reportPath, report);
  for (const model of models) {
    const modelDir = path.join(outputDir, model);
    await mkdir(modelDir, { recursive: true });
    const modelConfig = { ...config, fastModel: model, strongModel: model, maxConcurrency: 1,
      retryLimit: 0, pilotRequestCap: 100, requestTimeoutMs: 90_000 };
    const guard = new DurableProviderRequestGuard({ root: modelDir, providerId: config.providerId, baseUrl: config.baseUrl,
      apiKey: config.apiKey, providerName: config.providerName, protocolMode: config.protocolMode,
      candidateModels: [model], fastModel: model, strongModel: model, maxConcurrency: 1,
      requestCap: 100, retryLimit: 0, requestTimeoutMs: 90_000 });
    const adapter = new AiProviderAdapter(modelConfig, { guard, root: modelDir });
    const state = report.models[model] ||= { rows: [], summary: null };
    const finished = new Set(state.rows.map((row) => row.sampleId));
    for (const input of inputs) {
      if (finished.has(input.sampleId)) continue;
      await assertProductionIdle();
      await assertProviderAvailable(config, model, { root });
      const startedAt = new Date().toISOString();
      const events = [];
      const images = await Promise.all(input.imagePaths.map(async (file) => {
        const ext = path.extname(file).toLowerCase();
        const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
        return `data:${mime};base64,${(await readFile(file)).toString('base64')}`;
      }));
      const controller = new AbortController();
      const budgetCode = 'SEMANTIC_SHOT_BUDGET_EXCEEDED';
      const timer = setTimeout(() => controller.abort(new ProviderAdapterError(budgetCode, { code: budgetCode, retryable: false })), 90_000);
      let result = null; let latencyMs = null; let usage = null; let errorCode = null; let errorStatus = null;
      try {
        const scored = await adapter.scoreShot({ model, prompt: input.prompt, images, shotId: input.shotId,
          signal: controller.signal, onRequestEvent: async (event) => { events.push({ ...event }); } });
        result = scored.result; latencyMs = scored.telemetry.latencyMs; usage = scored.telemetry.usage;
      } catch (error) {
        errorCode = controller.signal.aborted ? controller.signal.reason?.code || budgetCode : error?.code || 'UNKNOWN';
        errorStatus = Number(error?.status) || null;
      } finally { clearTimeout(timer); }
      const starts = events.filter((event) => event.phase === 'start');
      const ends = events.filter((event) => event.phase === 'end');
      const requests = starts.map((start) => {
        const end = ends.find((event) => event.requestId === start.requestId);
        return { at: start.at || startedAt, httpStatus: Number(end?.httpStatus) || errorStatus,
          latencyMs: Number.isFinite(end?.latencyMs) ? end.latencyMs : null, timeout: end?.timeout === true };
      });
      state.rows.push({ sampleId: input.sampleId, startedAt, endedAt: new Date().toISOString(),
        inputFingerprint: input.inputFingerprint, result, latencyMs, usage, errorCode, errorStatus,
        timeout: controller.signal.aborted || requests.some((request) => request.timeout), requests });
      state.summary = summarize(state.rows, inputs.length);
      await writeJsonAtomic(reportPath, report);
      if (state.rows.length % 5 === 0) process.stdout.write(`${model} ${state.rows.length}/${inputs.length} scored=${state.summary.scored} http502=${state.summary.http502} p50=${state.summary.p50LatencyMs}\n`);
      const lastTwo = state.rows.slice(-2);
      if (lastTwo.length === 2 && lastTwo.every((row) => ['SEMANTIC_SHOT_BUDGET_EXCEEDED', 'PROVIDER_TIMEOUT'].includes(row.errorCode))) {
        throw Object.assign(new Error('Two consecutive Provider shot timeouts'), { code: 'PROVIDER_TIMEOUT_BURST' });
      }
    }
  }
  report.status = 'COMPLETE';
} catch (error) {
  report.status = error?.code === 'PRODUCTION_ACTIVE' ? 'PAUSED_FOR_PRODUCTION' :
    error?.code === 'PROVIDER_TIMEOUT_BURST' ? 'PAUSED_PROVIDER_TIMEOUT' : 'ABORTED';
  report.stopCode = error?.code || 'BENCHMARK_ERROR';
} finally {
  report.finishedAt = new Date().toISOString();
  await writeJsonAtomic(reportPath, report);
  process.stdout.write(JSON.stringify({ status: report.status, reportPath,
    models: Object.fromEntries(Object.entries(report.models).map(([model, state]) => [model, state.summary])) }) + '\n');
}
if (report.status !== 'COMPLETE') process.exitCode = 1;
