import { validateSemanticShot } from "./semantic-shot.mjs";
import { isShot } from "./types.ts";

export const SCHEDULER_V2 = "scheduler-v2-shadow.1";
export const LEGACY_SCHEDULER = "v0-pilot";
export const LEVELS = Object.freeze({
  A: ["opening", "product", "detail", "variation", "end"],
  B: ["opening", "product", "variation", "end"],
  C: ["opening", "product", "end"],
});
const normalize = (value) => String(value).replaceAll("/", "\\").toLowerCase();
export const sourceKey = (shot) => normalize(shot.path);

// Existing 0.5 safety thresholds are preserved. No creative property gates entry.
export function eligibleShots({ batchId, productView, semanticEvidence }) {
  const blocked = [], incomplete = [], eligible = [];
  const records = semanticEvidence?.records;
  if (!Array.isArray(records) || semanticEvidence.batchId !== batchId || semanticEvidence.complete === false) {
    return { eligible, blocked, incomplete: [{ reason: "analysis_incomplete" }] };
  }
  const byId = new Map();
  for (const record of records) {
    if (byId.has(record.shotId)) incomplete.push({ shotId: record.shotId, reason: "duplicate_evidence" });
    byId.set(record.shotId, record);
  }
  for (const shot of productView.shots) {
    const record = byId.get(shot.id);
    const source = productView.sourceNamesByShotId?.[shot.id];
    const files = productView.product?.files || [];
    const groupCorrect = source && files.includes(source)
      && (sourceKey(shot) === normalize(source) || sourceKey(shot).endsWith(`\\${normalize(source)}`));
    if (!isShot(shot) || !groupCorrect || shot.reject !== false || shot.rejectReason !== undefined) {
      blocked.push({ shotId: shot.id, reason: "shot_or_product_group_blocked" }); continue;
    }
    if ([record?.status, record?.verdict, record?.decision].some((value) => ["review", "reject", "evidence_insufficient", "wrong_sku"].includes(String(value).toLowerCase())) || record?.wrongSku === true) {
      blocked.push({ shotId: shot.id, reason: "explicit_quality_block" }); continue;
    }
    let semantic;
    try {
      if (!["scored", "cache_hit"].includes(record?.status)) throw new Error("not_scored");
      semantic = validateSemanticShot(record.result, { expectedShotId: shot.id });
    } catch {
      incomplete.push({ shotId: shot.id, reason: "missing_or_invalid_evidence" }); continue;
    }
    if (!semantic.usable || semantic.product_match < 0.5 || semantic.clothing_visibility < 0.5 || semantic.confidence < 0.5) {
      blocked.push({ shotId: shot.id, reason: "existing_safety_threshold" }); continue;
    }
    eligible.push({ shot, semantic, sourceName: source });
  }
  eligible.sort((a, b) => a.shot.id.localeCompare(b.shot.id));
  return { eligible, blocked, incomplete };
}

// Multiple roles per Shot, derived only from fields already in validated evidence.
export function creativePreferences({ shot, semantic: s }) {
  const product = (s.clothing_visibility + s.product_match) / 2;
  const full = ["overall", "front_full_body"].includes(s.shot_type);
  const detail = s.shot_type === "detail";
  const variation = ["back_full_body", "overall"].includes(s.shot_type);
  const motion = { low: 0, medium: 0.5, high: 1 }[shot.motionEnergy] ?? 0;
  return {
    scores: { opening: (s.hook_value * 2 + motion + product) / 4, product: product + (full ? 1 : 0), detail: s.visual_quality + (detail ? 1 : 0), variation: s.visual_quality + (variation ? 1 : 0), end: product },
    roles: ["product", "end", ...(s.hook_value >= 0.5 || motion >= 0.5 || full ? ["opening"] : []), ...(detail ? ["detail"] : []), ...(variation ? ["variation"] : [])],
  };
}

export function pairConflict(left, right, distinctPairs = [], frameHashesByShot = {}) {
  if (left.id === right.id) return "duplicate_shot";
  const a = frameHashesByShot[left.id], b = frameHashesByShot[right.id];
  if (Array.isArray(a) && a.length >= 3 && Array.isArray(b) && b.length === a.length && a.every((hash, i) => hash === b[i])) return "identical_sampled_frames";
  if (sourceKey(left) !== sourceKey(right)) return null;
  if (Math.min(left.end, right.end) - Math.max(left.start, right.start) > 1e-9) return "source_overlap";
  // Different timestamps/types alone do not establish visually distinct content.
  const verified = distinctPairs.some((p) => p.visuallyDistinct === true && typeof p.evidenceRef === "string" && p.evidenceRef.length > 0
    && p.shotIds?.length === 2 && p.shotIds.includes(left.id) && p.shotIds.includes(right.id));
  return verified ? null : "same_source_visual_difference_unverified";
}
