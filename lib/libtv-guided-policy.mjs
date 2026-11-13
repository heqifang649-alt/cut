import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";

export const GUIDED_POLICY = {
  version: "yiying-ootd/2", origin: "yiying-studio", mode: "automatic", strategy: "guided_auto",
  templateFamily: "ootd", templateSelection: "cut_local_optional", grouping: "multi_segment_assembly",
  confirmation: "source_policy", returnOutputs: true, garmentCheck: "exclude_mismatch_review_uncertain",
  selectionPolicy: { removeVisualFailures: true, removeSlowOrRedundantShots: true, removeUnclearProductShots: true,
    preferProductVisibility: true, preferNaturalMotion: true, allowCrossAssetAssembly: true, preserveSourceOrder: true },
  assemblyPolicy: { structure: "auto_product_edit", avoidEmptyGaps: true, transition: "hard_cut" },
  audioPolicy: { sourceAudio: "mute", bgm: "auto_match", beatSync: true }, sourceApproval: "not_required",
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hash = /^[a-f0-9]{64}$/;
export const policyHash = (policy) => createHash("sha256").update(JSON.stringify(policy)).digest("hex");
export function validateGuidedPolicy(manifest, input) {
  if (!isDeepStrictEqual(manifest.edit_policy, GUIDED_POLICY) || !isDeepStrictEqual(input.editPolicy, manifest.edit_policy)) throw new Error("EDIT_POLICY_INVALID");
  // This protocol revision grants only one source. A capability flag is not a cross-file authorization.
  if (manifest.assets?.length !== 1 || !uuid.test(manifest.source?.task_id || "")) throw new Error("SOURCE_SCOPE_INVALID");
  const asset = manifest.assets[0];
  if (!uuid.test(asset.asset_id || "") || asset.role !== "generated_video" || !hash.test(asset.sha256 || "")
    || !Number.isSafeInteger(asset.size_bytes) || asset.size_bytes <= 0) throw new Error("INVALID_ASSET");
  if (!Array.isArray(manifest.product_references) || !manifest.product_references.length || manifest.product_references.length > 5) throw new Error("PRODUCT_REFERENCE_REQUIRED");
  const ids = new Set([asset.asset_id]);
  for (const ref of manifest.product_references) {
    if (!uuid.test(ref.asset_id || "") || ids.has(ref.asset_id) || ref.task_id !== manifest.source.task_id
      || ref.applies_to_asset_id !== asset.asset_id || ref.role !== "product_reference" || !hash.test(ref.sha256 || "")
      || !Number.isSafeInteger(ref.size_bytes) || ref.size_bytes <= 0 || ref.size_bytes > 5 * 1024 * 1024
      || !["image/png", "image/jpeg", "image/webp"].includes(ref.mime_type)
      || ![ref.width, ref.height].every((n) => Number.isSafeInteger(n) && n > 0 && n <= 12000)
      || ref.width * ref.height > 40_000_000) throw new Error("INVALID_PRODUCT_REFERENCE");
    ids.add(ref.asset_id);
  }
  return { state: "accepted", policyVersion: GUIDED_POLICY.version, strategy: "guided_auto", manifestSha256: input.manifestSha256,
    policy: structuredClone(manifest.edit_policy) };
}
export function isGuidedBatch(batch) {
  const source = batch?.libtvSource, receipt = source?.editPolicyReceipt;
  return receipt?.state === "accepted" && receipt.policyVersion === GUIDED_POLICY.version && receipt.strategy === "guided_auto"
    && receipt.manifestSha256 === source.manifestSha256 && isDeepStrictEqual(receipt.policy, GUIDED_POLICY)
    && batch.productDetection?.sourcePolicy?.version === GUIDED_POLICY.version
    && batch.productDetection.sourcePolicy.manifestSha256 === source.manifestSha256
    && batch.productDetection.sourcePolicy.handoffId === source.handoffId;
}
