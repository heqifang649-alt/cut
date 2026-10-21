import { isDeepStrictEqual } from "node:util";
import { createRequire } from "node:module";
import path from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const POLICY = { version: "yiying-ootd/1", origin: "yiying-studio", mode: "automatic", templateFamily: "ootd",
  grouping: "single_source", confirmation: "source_policy", returnOutputs: true, garmentCheck: "exclude_mismatch_review_uncertain" };
const keys = [...Object.keys(POLICY), "templateId", "requestedBy"].sort();

export function assertAutoOotdTemplate(template) {
  const p = template?.profile;
  if (template?.status !== "ready" || !p || typeof p.summary !== "string" || typeof p.hook_text !== "string" || typeof p.cvr_text !== "string"
    || !Array.isArray(p.structure) || ![4, 5].includes(p.structure.length)
    || p.structure.some((entry) => {
      const range = String(entry?.timeline || "").match(/(\d+(?:\.\d+)?)\s*(?:-|–|—|至|到)\s*(\d+(?:\.\d+)?)/);
      return !range || Number(range[2]) <= Number(range[1]);
    })) throw new Error("TEMPLATE_NOT_READY");
}

export function validateAutoPolicy(manifest, input, mapping) {
  if (manifest.schema_version === "libtv-to-cutflow/1.1") {
    if (manifest.edit_policy !== undefined || input.editPolicy !== undefined || manifest.product_references !== undefined) throw new Error("EDIT_POLICY_INVALID");
    return null;
  }
  const policy = manifest.edit_policy;
  if (manifest.schema_version !== "libtv-to-cutflow/1.2" || !policy || !isDeepStrictEqual(Object.keys(policy).sort(), keys)
    || !isDeepStrictEqual(policy, input.editPolicy) || Object.entries(POLICY).some(([key, value]) => policy[key] !== value)
    || policy.requestedBy !== input.userId || policy.templateId !== mapping.templateId
    || mapping.ootdTemplateId !== policy.templateId) throw new Error("EDIT_POLICY_INVALID");
  if (!UUID.test(manifest.source?.task_id || "") || manifest.assets.length !== 1 || manifest.assets[0].role !== "generated_video"
    || !UUID.test(manifest.assets[0].asset_id || "") || !Array.isArray(manifest.product_references)
    || manifest.product_references.length < 1 || manifest.product_references.length > 5) throw new Error("PRODUCT_REFERENCE_REQUIRED");
  const ids = new Set([manifest.assets[0].asset_id]);
  for (const ref of manifest.product_references) {
    if (!UUID.test(ref.asset_id || "") || ids.has(ref.asset_id) || ref.task_id !== manifest.source.task_id
      || ref.role !== "product_reference" || ref.applies_to_asset_id !== manifest.assets[0].asset_id
      || !["PRODUCT_REFERENCE", "SUBJECT_REFERENCE"].includes(ref.source_type)
      || !HASH.test(ref.sha256 || "") || !Number.isSafeInteger(ref.size_bytes) || ref.size_bytes < 1 || ref.size_bytes > 5 * 1024 * 1024
      || !["image/jpeg", "image/png", "image/webp"].includes(ref.mime_type)
      || ![ref.width, ref.height].every((n) => Number.isSafeInteger(n) && n > 0 && n <= 12000)
      || ref.width * ref.height > 40_000_000 || typeof ref.original_filename !== "string" || !ref.original_filename.trim()
      || !(ref.source_image_output_id === null ? ref.provenance === "uploaded_product_reference_provenance_unverified"
        : UUID.test(ref.source_image_output_id || "") && ref.provenance === "generated_image_reference")) throw new Error("INVALID_PRODUCT_REFERENCE");
    ids.add(ref.asset_id);
  }
  return { state: "accepted", policy: structuredClone(policy), manifestSha256: input.manifestSha256 };
}

export async function verifyProductImage(bytes, ref) {
  const nextPackage = createRequire(path.join(process.cwd(), "package.json")).resolve("next/package.json");
  const sharp = createRequire(nextPackage)("sharp");
  const image = sharp(bytes, { limitInputPixels: 40_000_000, failOn: "warning" });
  const meta = await image.metadata();
  const mime = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp" }[meta.format];
  if (mime !== ref.mime_type || meta.width !== ref.width || meta.height !== ref.height || (meta.pages || 1) !== 1) throw new Error("PRODUCT_REFERENCE_METADATA_MISMATCH");
  await image.raw().toBuffer(); // Full decode; a matching header is insufficient.
}

export function isAutoOotdBatch(batch) {
  const receipt = batch?.libtvSource?.editPolicyReceipt;
  const p = receipt?.policy;
  return receipt?.state === "accepted" && receipt.manifestSha256 === batch.libtvSource.manifestSha256
    && !!p && isDeepStrictEqual(Object.keys(p).sort(), keys) && Object.entries(POLICY).every(([key, value]) => p[key] === value)
    && p.templateId === batch.templateId && p.requestedBy === batch.libtvSource.source?.user_id
    && batch.productDetection?.sourcePolicy?.manifestSha256 === receipt.manifestSha256
    && batch.productDetection.sourcePolicy.version === p.version
    && batch.productDetection.sourcePolicy.confirmation === "source_policy"
    && batch.productDetection.sourcePolicy.requestedBy === p.requestedBy
    && batch.productDetection.sourcePolicy.sourceVersion === batch.workflowVersion
    && batch.productDetection.sourcePolicy.handoffId === batch.libtvSource.handoffId;
}

export function bridgePublicFailure(batch) {
  if (batch?.status !== "failed") return null;
  if (["NO_MATCHING_HOOK", "SOURCE_INSUFFICIENT", "TEMPLATE_NOT_READY", "QUALITY_REJECTED", "BGM_MISSING", "SOURCE_SCOPE_INVALID"].includes(batch.bridgeErrorCode)) return batch.bridgeErrorCode;
  return "EXECUTION_FAILED";
}
