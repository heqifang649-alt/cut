import { analyzeDeterministicMetadataBudget } from "./deterministic-budget.mjs";
import { evaluateTechnical } from "./ai-video-validator.mjs";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { verifyProductImage } from "../lib/libtv-auto-policy.mjs";
import { createShotFromMetadata, prepareDeterministicInputs, readMetadataSidecar } from "./ai-ingest.mjs";

const SHA256 = /^[a-f0-9]{64}$/;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

function groupReferences(record, sources, productReferences) {
  if (record.sourceBinding?.kind === "brand" && (!Array.isArray(productReferences) || !productReferences.length)) {
    throw Object.assign(new Error("BRAND_REFERENCE_FREE_QUALITY_NOT_IMPLEMENTED"), {
      code: "BRAND_REFERENCE_FREE_QUALITY_NOT_IMPLEMENTED",
    });
  }
  if (!Array.isArray(productReferences) || !productReferences.length) throw new Error("PRODUCT_REFERENCE_REQUIRED");
  const sourceIds = new Set(sources.map((source) => source.id));
  const bindingKeys = new Set(sources.map((source) => source.bindingKey));
  const result = new Map([...bindingKeys].map((bindingKey) => [bindingKey, []]));
  for (const reference of productReferences) {
    const bindingKey = reference.bindingKey ?? reference.productId ?? reference.brandIdentity;
    if (!reference || typeof reference.id !== "string" || !reference.id || !bindingKeys.has(bindingKey)
      || reference.sourceTaskId !== record.taskId || reference.origin !== "original_task_product_image"
      || reference.verified !== true || typeof reference.absolutePath !== "string" || !SHA256.test(reference.sha256 || "")
      || reference.referenceForSourceId && !sourceIds.has(reference.referenceForSourceId)) throw new Error("PRODUCT_REFERENCE_BINDING_INVALID");
    result.get(bindingKey).push({ ...reference, bindingKey });
  }
  if ([...result.values()].some((references) => !references.length)) throw new Error("PRODUCT_REFERENCE_REQUIRED");
  return result;
}

export async function prepareClassicMultisourceAnalyze({
  record, sources, batchDir, ffmpeg, referenceProfile, productReferences, prepare = prepareDeterministicInputs,
}) {
  if (!record || !Array.isArray(sources) || sources.length < 1 || !batchDir || !ffmpeg || !referenceProfile) {
    throw new Error("MULTISOURCE_ANALYZE_INPUT_INVALID");
  }
  const referencesByProduct = groupReferences(record, sources, productReferences);
  for (const references of referencesByProduct.values()) for (const reference of references) {
    const bytes = await readFile(reference.absolutePath);
    if (hash(bytes) !== reference.sha256) throw new Error("PRODUCT_REFERENCE_HASH_CHANGED");
    await verifyProductImage(bytes, { mime_type: reference.mimeType, width: reference.width, height: reference.height });
  }
  const batch = { id: record.taskId, ownerId: record.ownerId, storageVersion: 1, referenceProfile,
    durationMax: Math.min(13, Math.max(1, Number(referenceProfile.duration_seconds) || 13)),
    files: sources.map((source) => ({ id: source.id, kind: "products", name: path.basename(source.absolutePath),
      relativePath: source.relativePath, storagePath: source.absolutePath, absolutePath: source.absolutePath,
      sourceType: "upload", sha256: source.sha256 })) };
  const prepared = await prepare({ batch, batchDir, ffmpeg });
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const candidatesBySource = new Map();
  for (const input of prepared.sidecars || []) {
    const source = sourceById.get(input.fileId);
    if (!source || !Array.isArray(input.segments) || !input.segments.length) continue;
    if (sources.length === 1 && prepare === prepareDeterministicInputs) {
      const segments = [];
      for (let start = 0; start < input.technical.duration - .001; start += 3) {
        const end = Math.min(start + 3, input.technical.duration);
        const quality = await analyzeDeterministicMetadataBudget(input.videoPath, { ffmpeg, technical: input.technical, start, duration: end-start });
        segments.push({ id: `continuous-${segments.length}`, start, end, tags: [], budget: quality.budget });
      }
      input.segments = segments;
    }
    const sidecar = await readMetadataSidecar(input.videoPath, { sidecarPath: input.sidecarPath });
    candidatesBySource.set(source.id, input.segments.map((segment) => ({
      ...createShotFromMetadata({ videoPath: input.videoPath, sidecar,
        validationResult: { verdict: "accept", artifacts: [] }, budget: segment.budget, segment }),
      technicalVerdict: input.technical && !evaluateTechnical(input.technical) ? "accept" : "reject", sourceId: source.id, productId: source.productId, bindingKey: source.bindingKey,
    })));
  }
  if (!candidatesBySource.size) throw new Error("SOURCE_CANDIDATES_INVALID");
  return { batch, scriptTemplate: JSON.parse(await readFile(path.join(batchDir, "script-template.json"), "utf8")),
    candidatesBySource, referencesByProduct, prepared };
}
