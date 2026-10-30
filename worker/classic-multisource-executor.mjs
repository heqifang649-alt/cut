import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { assertOutputDuration, verifyEncodedSafeDuration } from "../lib/output-duration.mjs";
import { loadRuntimeConfig } from "./runtime-config.mjs";
import { createProductViews, enforceMinimumSafeDuration, MINIMUM_SAFE_DURATION_SECONDS, partitionScheduledProducts, scheduleProductView } from "./shot-scheduler.mjs";
import { renderBatchFromRenderPlans } from "./batch-renderer.mjs";
import { runClassicMultisourceQuality } from "./classic-multisource-quality.mjs";
import { prepareClassicMultisourceAnalyze } from "./classic-multisource-analyze.mjs";
import { writeJsonAtomic } from "../lib/atomic-json.mjs";
import { loadMultisourceExecution, publishMultisourceResults, recordMultisourceVerification, recordMultisourceProgress, updateMultisourceStatus } from "../lib/classic-multisource.mjs";
import { acquireRenderPermit, heartbeatRenderPermit, releaseRenderPermit } from "./resource-governor.mjs";

function boundReceipt(receipt, record, state, verifier) {
  if (!receipt || receipt.state !== state || receipt.taskId !== record.taskId || receipt.handoffKey !== record.handoffKey
    || receipt.manifestSha256 !== record.manifestSha256 || receipt.policyVersion !== record.policyReceipt?.policyVersion
    || receipt.verifier !== verifier) {
    throw new Error("VERIFIER_RECEIPT_MISMATCH");
  }
  return receipt;
}

function productGroups(sources) {
  const groups = new Map();
  for (const source of sources) {
    const current = groups.get(source.bindingKey) || { id: source.bindingKey, label: source.bindingKey, files: [] };
    current.files.push(source.absolutePath);
    groups.set(source.bindingKey, current);
  }
  return [...groups.values()];
}

export function scheduleClassicMultisource({ record, shotPool, scriptTemplate, semanticEvidence }) {
  const views = createProductViews({ shotPool, productGroups: productGroups(record.sources) });
  return views.map((view) => ({ product: view.product, sourceNamesByShotId: view.sourceNamesByShotId,
    scheduleResult: scheduleAvailable(view, record, scriptTemplate, semanticEvidence) }));
}

function scheduleAvailable(view, record, scriptTemplate, semanticEvidence) {
  const planned = enforceMinimumSafeDuration(scheduleProductView({ batchId: record.taskId, productView: view, scriptTemplate,
      createdAt: record.acceptedAt, semanticEvidence, allowPartial: true, preserveSourceOrder: true }));
  if (new Set(view.shots.map(s => s.source)).size > 1 && planned.status === "success") return planned;
  const sourceOrder = new Map(record.sources.map((s,i) => [s.id, s.order ?? i]));
  const ends = new Map();
  const shots = [...view.shots].filter(s => !s.reject && !(semanticEvidence?.records || []).some(r => r.shotId === s.id && (r.wrongSku === true || ["reject", "wrong_sku"].includes(String(r.status).toLowerCase()) || r.result?.usable === false))).sort((a,b) => (sourceOrder.get(a.source) ?? 0)-(sourceOrder.get(b.source) ?? 0) || a.start-b.start).filter(s => {
    if (s.start < (ends.get(s.source) ?? 0)) return false;
    ends.set(s.source, s.end); return true;
  });
  if (!shots.length) return planned;
  return enforceMinimumSafeDuration({ status: "success", renderPlan: { id: `${record.taskId}-${view.product.id}-continuous`, batchId: record.taskId, createdAt: record.acceptedAt, transitionProfile: "hard_cut", slots: shots.map((shot,i) => ({ shot, slot: { id: `segment_${i}`, label: "商品展示", requireTags: [], targetDuration: shot.end-shot.start } })) } });
}

export function assertMultisourceOutputDuration(durationSeconds, minimum = MINIMUM_SAFE_DURATION_SECONDS) {
  return assertOutputDuration(durationSeconds, minimum);
}

function rendererOutputPath(root, output) {
  if (typeof output?.storagePath !== "string" || !output.storagePath) throw new Error("RENDER_OUTPUT_INVALID");
  return path.isAbsolute(output.storagePath) ? output.storagePath : path.resolve(root, output.storagePath);
}

async function outputDigest(file) {
  const digest = createHash("sha256");
  await pipeline(createReadStream(file), new Transform({ transform(chunk, _encoding, callback) {
    digest.update(chunk); callback();
  } }));
  return digest.digest("hex");
}

export async function probeMultisourceDuration(file, ffprobe) {
  return verifyEncodedSafeDuration(ffprobe, file);
}

export async function executeClassicMultisource({
  root, config, taskId, workspaceDir, ffmpeg, scriptTemplate, referenceProfile, productReferences,
  analyze = prepareClassicMultisourceAnalyze, analyzeOptions = {},
  qualityVerifier = runClassicMultisourceQuality, qualityOptions = {}, rendererBatch = {},
  renderer = renderBatchFromRenderPlans, lease, workerId = `multisource-${process.pid}`,
  renderLimit = Math.max(1, Math.min(5, Number(process.env.CUTFLOW_MULTISOURCE_RENDER_LIMIT) || 5)),
}) {
  if (typeof qualityVerifier !== "function" || !workspaceDir || !ffmpeg) {
    throw new Error("MISSING_TRUSTED_DEPENDENCY");
  }
  const record = await loadMultisourceExecution(root, config, taskId);
  await updateMultisourceStatus(root, taskId, "uploading", undefined, config, lease);
  const progress = (stage, value, startAttempt = false) => recordMultisourceProgress(root, config, taskId, { stage, progress: value, startAttempt, lease });
  await progress("analyze", 10, true);
  let stage = "analyze";
  try {
    let resolvedTemplate = scriptTemplate;
    let resolvedQualityOptions = qualityOptions;
    if (!resolvedQualityOptions.candidatesBySource || !resolvedQualityOptions.referencesByProduct) {
      const analyzed = await analyze({ root, record, sources: record.sources,
        batchDir: path.join(workspaceDir, taskId, "analyze"), ffmpeg, referenceProfile, productReferences, ...analyzeOptions });
      resolvedTemplate ||= analyzed.scriptTemplate;
      resolvedQualityOptions = { ...resolvedQualityOptions, candidatesBySource: analyzed.candidatesBySource,
        referencesByProduct: analyzed.referencesByProduct };
    }
    if (!resolvedTemplate) throw new Error("MISSING_SCRIPT_TEMPLATE");
    stage = "quality";
    await progress(stage, 30);
    const quality = await qualityVerifier({ root, record, sources: record.sources, ffmpeg,
      batchDir: path.join(workspaceDir, taskId, "quality"), verifier: config.qualityVerifier, ...resolvedQualityOptions,
      onProgress: ({ completed, total }) => progress("quality", 30 + 35 * completed / total) });
    const qualityReceipt = boundReceipt(quality?.receipt, record, "accepted", config.qualityVerifier);
    if (!quality?.shotPool || !Array.isArray(quality.shotPool.shots)) throw new Error("QUALITY_RESULT_INVALID");
    await recordMultisourceVerification(root, taskId, { qualityReceipt, lease });
    await updateMultisourceStatus(root, taskId, "editing", undefined, config, lease);

    stage = "scheduler";
    await progress(stage, 70);
    const scheduledProducts = scheduleClassicMultisource({ record, shotPool: quality.shotPool,
      scriptTemplate: resolvedTemplate, semanticEvidence: quality.semanticEvidence });
    await writeJsonAtomic(path.join(workspaceDir, taskId, "edit", "multisource-schedule-result.json"), {
      taskId, manifestSha256: record.manifestSha256, templateSlots: resolvedTemplate.slots.length,
      admittedShots: quality.shotPool.shots.length, scheduledProducts,
    });
    const { renderable, excludedProducts } = partitionScheduledProducts(scheduledProducts);
    if (!renderable.length) {
      const failed = scheduledProducts.find((item) => item.scheduleResult.status !== "success");
      throw Object.assign(new Error("MULTISOURCE_SCHEDULING_FAILED"), {
        code: "MULTISOURCE_SCHEDULING_FAILED", detailCode: "SCHEDULER_NO_MATCHING_SHOT",
        schedulerDetails: { slotId: failed?.scheduleResult.slotId, reason: failed?.scheduleResult.reason,
          admittedShots: quality.shotPool.shots.length, templateSlots: resolvedTemplate.slots.length },
      });
    }

    const batchDir = path.join(workspaceDir, taskId);
    const batch = { ...rendererBatch, id: taskId, status: "editing", storageVersion: 1,
      files: Array.isArray(rendererBatch.files) ? rendererBatch.files : [], durationMax: resolvedTemplate.totalDuration,
      targetOutputsPerBatch: renderable.length, coveragePolicy: "all_products_required",
      colorStrategy: "none", transitionMode: "standard" };
    stage = "render";
    await progress(stage, 80);
    let renderPermit;
    while (!renderPermit) {
      const permitResult = await acquireRenderPermit({ root, batchId: taskId, taskKey: `${taskId}:multisource:render`, workerId,
        leaseMs: 120_000, limit: renderLimit });
      if (permitResult.state === "acquired") renderPermit = permitResult.permit;
      else await new Promise((resolve) => setTimeout(resolve, Math.max(25, Date.parse(permitResult.retryAt) - Date.now())));
    }
    const renderHeartbeat = setInterval(() => heartbeatRenderPermit({ root, permit: renderPermit, leaseMs: 120_000,
      limit: renderLimit }).catch(() => undefined), 30_000);
    renderHeartbeat.unref?.();
    let rendered;
    try {
      rendered = await renderer({ root, batch, batchDir, editDir: path.join(batchDir, "edit"),
        outputDir: path.join(batchDir, "output"), ffmpeg, scheduledProducts: renderable, excludedProducts,
        semanticEvidence: quality.semanticEvidence });
    } finally {
      clearInterval(renderHeartbeat);
      await releaseRenderPermit({ root, permit: renderPermit, limit: renderLimit }).catch(() => undefined);
    }
    if (!Array.isArray(rendered?.files) || !rendered.files.length) throw new Error("RENDER_OUTPUT_INVALID");
    const runtime = await loadRuntimeConfig(root);
    const outputs = [];
    for (const output of rendered.files) {
      const sourcePath = rendererOutputPath(root, output);
      const info = await stat(sourcePath);
      const durationSeconds = await probeMultisourceDuration(sourcePath, runtime.ffprobeExecutable);
      outputs.push({ id: randomUUID(), sourcePath, sha256: await outputDigest(sourcePath), size: info.size,
        durationSeconds });
    }
    stage = "publish";
    await progress(stage, 95);
    return await publishMultisourceResults(root, config, taskId, outputs, "review", { ffmpeg, ffprobe: runtime.ffprobeExecutable, lease });
  } catch (error) {
    error.stage ||= stage;
    await updateMultisourceStatus(root, taskId, "failed", error, config, lease).catch(() => undefined);
    throw error;
  }
}
