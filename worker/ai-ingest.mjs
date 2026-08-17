import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isMetadataSidecar, isShot, isValidationResult } from "../lib/types.ts";
import { readJson, withFileLock, writeJsonAtomic } from "../lib/atomic-json.mjs";
import { resolveStoredWorkspaceFile } from "../lib/tenant-paths.mjs";
import { computeMetadataBudget, normalizeMetadataBudget } from "./metadata-budget.mjs";
import { evaluateTechnical, probeTechnical } from "./ai-video-validator.mjs";
import { analyzeDeterministicMetadataBudget } from "./deterministic-budget.mjs";

const POOL_VERSION = 1;
const INPUTS_VERSION = 1;
const FROZEN_SLOT_IDS = ["hook", "outfit_interest", "front_reason", "sleeve_fabric_reason", "back_or_best_reason"];

export class MetadataSidecarNotFoundError extends Error {
  constructor(videoPath) {
    super(`未找到 Metadata Sidecar：${videoPath}`);
    this.name = "MetadataSidecarNotFoundError";
    this.code = "METADATA_SIDECAR_NOT_FOUND";
  }
}

const withoutExtension = (filePath) => path.join(path.dirname(filePath), path.basename(filePath, path.extname(filePath)));
const poolPathFor = (batchDir) => path.join(batchDir, "shot-pool.json");
const reportPathFor = (batchDir) => path.join(batchDir, "shot-pool-import.json");
const deterministicInputsPathFor = (batchDir) => path.join(batchDir, "deterministic-inputs.v1.json");
const metadataSidecarDirectoryFor = (batchDir) => path.join(batchDir, "metadata-sidecars");

async function firstReadable(paths) {
  for (const candidate of paths) {
    try { await access(candidate); return candidate; } catch {}
  }
  return null;
}

export async function readMetadataSidecar(videoPath, options = {}) {
  const candidates = options.sidecarPath
    ? [options.sidecarPath]
    : [`${videoPath}.json`, `${withoutExtension(videoPath)}.json`];
  const sidecarPath = await firstReadable(candidates);
  if (!sidecarPath) throw new MetadataSidecarNotFoundError(videoPath);
  const value = JSON.parse((await readFile(sidecarPath, "utf8")).replace(/^\uFEFF/, ""));
  if (!isMetadataSidecar(value)) throw new TypeError(`Metadata Sidecar 结构无效：${sidecarPath}`);
  return value;
}

const shotIdFor = ({ videoPath, sidecar, origin, segment }) => createHash("sha256")
  .update(JSON.stringify({ videoPath, video: sidecar.video, duration: sidecar.duration, tags: sidecar.tags, origin, segment: segment || null }))
  .digest("hex").slice(0, 32);

export function createShotFromMetadata({ videoPath, sidecar, validationResult, budget, origin = "real", segment }) {
  if (!isMetadataSidecar(sidecar)) throw new TypeError("Metadata Sidecar 结构无效");
  if (!isValidationResult(validationResult)) throw new TypeError("ValidationResult 结构无效");
  if (validationResult.verdict !== "accept") throw new Error("只有 Validator accept 才能建立 Shot");
  if (!Number.isFinite(sidecar.duration) || sidecar.duration <= 0) throw new TypeError("Sidecar duration 必须大于 0");
  const start = segment == null ? 0 : Number(segment.start);
  const end = segment == null ? sidecar.duration : Number(segment.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > sidecar.duration + 0.001) {
    throw new TypeError("Shot segment is outside the source duration");
  }
  const completeBudget = normalizeMetadataBudget(budget);
  return {
    id: shotIdFor({ videoPath, sidecar, origin, segment: segment ? { id: segment.id, start, end, tags: segment.tags || [] } : null }),
    source: `${sidecar.platform}:${sidecar.video}`,
    path: videoPath,
    start,
    end,
    duration: Math.round((end - start) * 1000) / 1000,
    tags: [...sidecar.tags, ...(segment?.tags || [])],
    reject: false,
    origin,
    ...completeBudget,
  };
}

function emptyPool(batchId) {
  return { version: POOL_VERSION, batchId, shots: [], updatedAt: new Date().toISOString() };
}

export async function loadShotPool(batchId, batchDir) {
  const pool = await readJson(poolPathFor(batchDir), emptyPool(batchId));
  if (!pool || pool.version !== POOL_VERSION || pool.batchId !== batchId || !Array.isArray(pool.shots) || !pool.shots.every(isShot)) {
    throw new TypeError("ShotPool 数据结构无效");
  }
  return pool;
}

export async function mergeShotsIntoPool(batchId, batchDir, shots) {
  if (!Array.isArray(shots) || !shots.every((shot) => isShot(shot) && shot.reject === false)) throw new TypeError("ShotPool 只接受完整的非 rejected Shot");
  const file = poolPathFor(batchDir);
  await mkdir(path.dirname(file), { recursive: true });
  return withFileLock(file, async () => {
    const current = await loadShotPool(batchId, batchDir);
    const byId = new Map(current.shots.map((shot) => [shot.id, shot]));
    for (const shot of shots) byId.set(shot.id, shot);
    const next = { ...current, shots: [...byId.values()], updatedAt: new Date().toISOString() };
    await writeJsonAtomic(file, next);
    return next;
  });
}

export const isNewShotPoolEnabled = (env = process.env) => env.ENABLE_NEW_SHOTPOOL === "true";

function isInsideNasRoot(root, candidate) {
  const relative = path.win32.relative(path.win32.resolve(root), path.win32.resolve(candidate));
  return relative !== "" && !relative.startsWith("..") && !path.win32.isAbsolute(relative);
}

function resolveBatchSource(root, batch, batchDir, file) {
  if (batch.storageVersion !== 2) return file.absolutePath || (path.isAbsolute(file.storagePath) ? file.storagePath : path.resolve(root, file.storagePath));
  if (file.sourceType === "nas") {
    const source = file.absolutePath || file.storagePath;
    if (typeof batch.nasPath !== "string" || !source || !isInsideNasRoot(batch.nasPath, source)) throw new Error("NAS source escapes the Batch claim");
    return source;
  }
  return resolveStoredWorkspaceFile(root, batchDir, file.storagePath);
}

function parseTimelineDuration(timeline) {
  if (typeof timeline !== "string") return Number.NaN;
  const values = [...timeline.matchAll(/(\d+(?:\.\d+)?)\s*(?:-|–|—|至|到)\s*(\d+(?:\.\d+)?)/g)]
    .flatMap((match) => [Number(match[1]), Number(match[2])])
    .filter(Number.isFinite);
  if (values.length < 2) return Number.NaN;
  const start = values[0];
  const end = values[values.length - 1];
  return end > start ? Math.round((end - start) * 1000) / 1000 : Number.NaN;
}

function cleanLabel(value, fallback) {
  const text = typeof value === "string" ? value.replace(/[\u0000-\u001f]/g, " ").trim() : "";
  return text.slice(0, 160) || fallback;
}

function deterministicTemplateId(batch, structure) {
  return createHash("sha256")
    .update(JSON.stringify({ templateId: batch?.templateId || null, structure }))
    .digest("hex").slice(0, 24);
}

/**
 * Convert an already-confirmed reference profile into the frozen ScriptTemplate
 * shape. No visual tags or quality thresholds are invented here: slots carry
 * only the duration and human-confirmed structure text. Shot-level quality and
 * semantic fields are still supplied by a real analyzer before ShotPool entry.
 */
export function deriveScriptTemplate(batch) {
  const profile = batch?.referenceProfile;
  if (!profile || !Array.isArray(profile.structure) || profile.structure.length < 4) {
    throw new TypeError("Confirmed referenceProfile.structure requires at least four stages");
  }
  const durations = profile.structure.slice(0, 5).map((entry, index) => {
    const value = parseTimelineDuration(entry?.timeline);
    if (!Number.isFinite(value) || value <= 0) throw new TypeError(`Reference structure timeline is invalid at index ${index}`);
    return value;
  });
  const labels = profile.structure.slice(0, 5).map((entry, index) => cleanLabel(entry?.purpose, `Structure ${index + 1}`));
  if (durations.length === 4) {
    const detail = durations[2];
    durations.splice(2, 1, Math.round(detail * 0.55 * 1000) / 1000, Math.round(detail * 0.45 * 1000) / 1000);
    const valueLabel = labels[2];
    labels.splice(2, 1, `${valueLabel} / front`, `${valueLabel} / fabric detail`);
  }
  const slotIds = FROZEN_SLOT_IDS;
  if (durations.length !== slotIds.length) throw new TypeError("Confirmed reference profile cannot be mapped to the five-slot production contract");
  const total = durations.reduce((sum, value) => sum + value, 0);
  // A confirmed batch may impose a stricter duration cap than the global
  // 13-second ceiling. Scale the frozen structure once, deterministically,
  // instead of generating an edit plan that the renderer must reject later.
  const batchCap = Number(batch?.durationMax);
  const durationCap = Number.isFinite(batchCap) && batchCap > 0 ? Math.min(13, batchCap) : 13;
  const scale = total > durationCap ? durationCap / total : 1;
  const slots = slotIds.map((id, index) => ({
    id,
    label: labels[index],
    requireTags: [],
    targetDuration: Math.round(durations[index] * scale * 1000) / 1000,
  }));
  return {
    id: `derived-${deterministicTemplateId(batch, profile.structure)}`,
    name: cleanLabel(batch.templateName || profile.summary, "Confirmed reference template"),
    slots,
    totalDuration: Math.round(slots.reduce((sum, slot) => sum + slot.targetDuration, 0) * 1000) / 1000,
  };
}

function candidateSegments(duration, scriptTemplate) {
  const maximum = Math.max(...scriptTemplate.slots.map((slot) => slot.targetDuration));
  const window = Math.min(duration, Math.max(maximum, Math.min(3.2, duration / 2)));
  if (duration <= window + 0.05) return [{ id: "full", start: 0, end: duration, tags: ["window:full"] }];
  const segments = [
    { id: "early", start: 0, end: window, tags: ["window:early"] },
  ];
  if (duration >= (window * 2) + 0.2) {
    const middleStart = Math.round(((duration - window) / 2) * 1000) / 1000;
    segments.push({ id: "middle", start: middleStart, end: Math.round((middleStart + window) * 1000) / 1000, tags: ["window:middle"] });
  }
  segments.push({ id: "late", start: Math.round(Math.max(0, duration - window) * 1000) / 1000, end: duration, tags: ["window:late"] });
  return segments;
}

function sidecarKey(videoPath) {
  return createHash("sha256").update(String(videoPath)).digest("hex").slice(0, 32);
}

async function readDeterministicInputs(batchDir) {
  const value = await readJson(deterministicInputsPathFor(batchDir), null);
  if (!value || value.version !== INPUTS_VERSION || !Array.isArray(value.sidecars)) return null;
  return value;
}

/**
 * Prepare isolated, reproducible inputs for a confirmed NAS batch. Technical
 * duration is measured with the existing ffprobe-compatible probeTechnical
 * entry point. Sidecars are written under the batch workspace, never beside
 * source files on the NAS. This function intentionally does not create any
 * productVisibility/productCentered/motionEnergy values.
 */
export async function prepareDeterministicInputs({ batch, batchDir, ffmpeg, probe = probeTechnical, analyzeBudget = analyzeDeterministicMetadataBudget } = {}) {
  const scriptTemplate = deriveScriptTemplate(batch);
  await mkdir(batchDir, { recursive: true });
  const scriptTemplatePath = path.join(batchDir, "script-template.json");
  let existingTemplate = await readJson(scriptTemplatePath, null);
  const existingSlotIds = Array.isArray(existingTemplate?.slots) ? existingTemplate.slots.map((slot) => slot?.id) : [];
  const existingMatchesFrozenContract = existingSlotIds.length === FROZEN_SLOT_IDS.length
    && existingSlotIds.every((id, index) => id === FROZEN_SLOT_IDS[index])
    && Number(existingTemplate.totalDuration) === Number(scriptTemplate.totalDuration)
    && existingTemplate.id === scriptTemplate.id;
  if (!existingTemplate || !existingMatchesFrozenContract) {
    await writeJsonAtomic(scriptTemplatePath, scriptTemplate);
    existingTemplate = scriptTemplate;
  }

  const sidecarDir = metadataSidecarDirectoryFor(batchDir);
  await mkdir(sidecarDir, { recursive: true });
  const sidecars = [];
  const skipped = [];
  for (const file of (batch.files || []).filter((item) => item.kind === "products")) {
    let videoPath;
    try {
      videoPath = resolveBatchSource(process.cwd(), batch, batchDir, file);
      const technical = await probe(videoPath, { ffmpeg });
      if (!Number.isFinite(technical?.duration) || technical.duration <= 0) throw new Error("Technical probe returned no usable duration");
      const sidecarPath = path.join(sidecarDir, `${sidecarKey(videoPath)}.json`);
      const sidecar = {
        video: file.relativePath || path.basename(videoPath),
        tags: [],
        duration: technical.duration,
        platform: file.sourceType === "nas" ? "nas" : "camera",
      };
      await writeJsonAtomic(sidecarPath, sidecar);
      const segments = [];
      for (const segment of candidateSegments(technical.duration, scriptTemplate)) {
        const quality = await analyzeBudget(videoPath, { ffmpeg, technical, start: segment.start, duration: segment.end - segment.start });
        segments.push({ ...segment, budget: quality.budget, evidence: quality.evidence });
      }
      sidecars.push({ fileId: file.id, videoPath, sidecarPath, duration: technical.duration, technical, segments });
    } catch (error) {
      skipped.push({ fileId: file.id, videoPath, status: "skipped", reason: error?.code || error?.message || String(error) });
    }
  }
  const report = {
    version: INPUTS_VERSION,
    isolated: true,
    batchId: batch.id,
    generatedAt: new Date().toISOString(),
    scriptTemplate: { path: scriptTemplatePath, id: existingTemplate.id },
    sidecars,
    skipped,
    qualityFieldsRequired: ["productVisibility", "productCentered", "motionEnergy"],
    qualityAnalyzer: "grayscale_foreground_temporal_v1",
    qualityAnalyzerRequired: true,
  };
  await writeJsonAtomic(deterministicInputsPathFor(batchDir), report);
  return report;
}

export function validateTechnicalCandidate(technical) {
  const failure = evaluateTechnical(technical);
  return failure || { verdict: "accept", artifacts: [] };
}

export async function importBatchToShotPool({ batch, batchDir, validate, budget, origin = "real", admissionPolicy = "full_validator" }) {
  if (!new Set(["full_validator", "technical_metadata_shadow"]).has(admissionPolicy)) throw new TypeError("ShotPool admissionPolicy is invalid");
  if (admissionPolicy === "full_validator" && typeof validate !== "function") throw new TypeError("ShotPool full_validator admission requires validate");
  const records = [];
  const shots = [];
  const deterministicInputs = await readDeterministicInputs(batchDir);
  const inputByPath = new Map((deterministicInputs?.sidecars || []).map((item) => [item.videoPath, item]));
  for (const file of (batch.files || []).filter((item) => item.kind === "products")) {
    const videoPath = resolveBatchSource(process.cwd(), batch, batchDir, file);
    try {
      const prepared = inputByPath.get(videoPath);
      const sidecar = await readMetadataSidecar(videoPath, { sidecarPath: prepared?.sidecarPath });
      if (admissionPolicy === "technical_metadata_shadow" && (!prepared?.technical || !Array.isArray(prepared?.segments) || !prepared.segments.length)) {
        throw new Error("Technical shadow admission requires prepared deterministic evidence");
      }
      const validationResult = admissionPolicy === "technical_metadata_shadow"
        ? validateTechnicalCandidate(prepared.technical)
        : await validate(videoPath, { sidecar });
      if (!isValidationResult(validationResult)) throw new TypeError("Validator 返回了无效 ValidationResult");
      if (validationResult.verdict !== "accept") {
        records.push({ videoPath, status: validationResult.verdict, rejectReason: validationResult.rejectReason });
        continue;
      }
      const segments = Array.isArray(prepared?.segments) && prepared.segments.length ? prepared.segments : [null];
      for (const segment of segments) {
        const metadataBudget = await computeMetadataBudget(videoPath, { budget: segment?.budget || prepared?.budget, analyze: budget });
        const shot = createShotFromMetadata({ videoPath, sidecar, validationResult, budget: metadataBudget, origin, segment });
        shots.push(shot);
        records.push({ videoPath, status: "imported", shotId: shot.id, segmentId: segment?.id, admissionPolicy });
      }
    } catch (error) {
      records.push({ videoPath, status: "skipped", reason: error?.code || error?.message || String(error) });
    }
  }
  const pool = shots.length ? await mergeShotsIntoPool(batch.id, batchDir, shots) : await loadShotPool(batch.id, batchDir);
  const report = { isolated: true, batchId: batch.id, admissionPolicy, imported: shots.length, records, updatedAt: new Date().toISOString() };
  await mkdir(batchDir, { recursive: true });
  await writeFile(reportPathFor(batchDir), JSON.stringify(report, null, 2), "utf8");
  return { pool, report };
}
