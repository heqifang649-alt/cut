// Metadata only: never mutate the signed manifest or immutable edit policy.
export const normalizeVideoType = value => value === "unboxing" ? "unboxing" : "ootd";
export function sourceVideoType(source = {}, fallback) {
  for (const key of ["videoType", "video_type"]) {
    if (Object.hasOwn(source, key)) return normalizeVideoType(source[key]);
  }
  return normalizeVideoType(fallback);
}
export const manifestVideoType = manifest => sourceVideoType(manifest.source || {}, manifest.edit_intent?.video_type);
export const batchVideoType = batch => Object.hasOwn(batch, "videoType") ? normalizeVideoType(batch.videoType)
  : sourceVideoType(batch.libtvSource?.source || {});
export const UNBOXING_ACTIONS = ["packaging_reveal", "opening", "extracting", "unfolding", "lifting"];
export const UNBOXING_PROMPT = "Also return unboxing_action: {action, confidence, evidence_frames}. action is packaging_reveal, opening, extracting, unfolding, lifting, or none. Confirm only meaningful real packaging/product reveal or active unpacking visible across at least two chronological VIDEO_FRAME indices. Idle low visibility, pauses and repeated movements are none. Never infer actions or invent packaging/products. Product detail and overall display remain the priority; preserve original graphics, color, text and structure. All existing product identity and artifact checks still apply.";
export function confirmedUnboxing(evidence) {
  return UNBOXING_ACTIONS.includes(evidence?.action) && Number.isFinite(evidence.confidence) && evidence.confidence >= .85 && evidence.confidence <= 1
    && Array.isArray(evidence.evidence_frames) && new Set(evidence.evidence_frames).size >= 2
    && evidence.evidence_frames.every(n => Number.isInteger(n) && n >= 0 && n <= 4);
}
// A small narrative allowance; the majority of the output remains product display.
export function selectUnboxingShots(shots, typeForShot) {
  let actionSeconds = 0;
  const displaySeconds = shots.filter(s => s.productVisibility >= .2).reduce((n,s) => n+s.end-s.start,0);
  return [...shots].sort((a,b) => a.start-b.start).filter(s => {
    if (typeForShot(s) !== "unboxing" || s.productVisibility >= .2) return true;
    const duration = s.end-s.start;
    if (!confirmedUnboxing(s.unboxingAction) || actionSeconds+duration > Math.min(3, displaySeconds/3)) return false;
    actionSeconds += duration; return true;
  });
}
