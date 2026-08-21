import { createHash } from "node:crypto";
import { isRenderPlan, isShot, isSlot, isTransitionProfile } from "../lib/types.ts";

const EPSILON = 1e-9;

export const isNewSchedulerEnabled = (env = process.env) => env.ENABLE_NEW_SCHEDULER === "true";
export const SEMANTIC_SCHEDULER_POLICY = "v0-pilot";
const MIN_PARTIAL_SLOTS = 2;
const MIN_PARTIAL_DURATION_SECONDS = 4;

function isAcceptShot(shot) {
  return isShot(shot) && shot.reject === false && shot.rejectReason === undefined;
}

function validateScriptTemplate(scriptTemplate) {
  if (!scriptTemplate || typeof scriptTemplate !== "object" || typeof scriptTemplate.id !== "string" || typeof scriptTemplate.name !== "string" || !Array.isArray(scriptTemplate.slots) || !scriptTemplate.slots.every(isSlot) || !Number.isFinite(scriptTemplate.totalDuration)) {
    throw new TypeError("ScriptTemplate structure is invalid");
  }
}

function validateInputs(batchId, shotPool, scriptTemplate) {
  if (typeof batchId !== "string" || batchId.length === 0) throw new TypeError("batchId is required");
  if (!shotPool || !Array.isArray(shotPool.shots) || !shotPool.shots.every(isAcceptShot)) {
    throw new TypeError("Scheduler only accepts a complete Quality Gate accept ShotPool");
  }
  validateScriptTemplate(scriptTemplate);
}

const normalizedPath = (value) => String(value).replaceAll("/", "\\").toLowerCase();
const sourceBaseName = (value) => normalizedPath(value).split("\\").at(-1);

function groupForProductView(group) {
  if (!group || typeof group !== "object" || typeof group.id !== "string" || group.id.length === 0 || typeof group.label !== "string" || !Array.isArray(group.files) || !group.files.every((file) => typeof file === "string" && file.length > 0)) {
    throw new TypeError("Product View requires a confirmed product group");
  }
  return { id: group.id, label: group.label, files: [...group.files] };
}

function matchingGroupFile(shotPath, group) {
  const source = normalizedPath(shotPath);
  const exact = group.files.find((file) => source.endsWith(`\\${normalizedPath(file)}`) || source === normalizedPath(file));
  if (exact) return exact;
  const base = sourceBaseName(source);
  const baseMatches = group.files.filter((file) => sourceBaseName(file) === base);
  return baseMatches.length === 1 ? baseMatches[0] : null;
}

export function createProductViews({ shotPool, productGroups }) {
  if (!shotPool || !Array.isArray(shotPool.shots) || !shotPool.shots.every(isAcceptShot)) throw new TypeError("Product View requires a complete Quality Gate accept ShotPool");
  if (!Array.isArray(productGroups) || !productGroups.length) throw new TypeError("Product View requires confirmed product groups");
  const views = productGroups.map((group) => ({ product: groupForProductView(group), shots: [], sourceNamesByShotId: {} }));
  if (new Set(views.map((view) => view.product.id)).size !== views.length) throw new Error("Product View group ids must be unique");

  for (const shot of shotPool.shots) {
    const matches = views
      .map((view) => ({ view, sourceName: matchingGroupFile(shot.path, view.product) }))
      .filter(({ sourceName }) => sourceName);
    if (matches.length > 1) throw new Error(`Shot ${shot.id} belongs to multiple product groups`);
    if (!matches.length) continue;
    const { view, sourceName } = matches[0];
    view.shots.push(shot);
    view.sourceNamesByShotId[shot.id] = sourceName;
  }
  return views;
}

function validateProductView(productView) {
  if (!productView || typeof productView !== "object" || !productView.product || typeof productView.product.id !== "string" || typeof productView.product.label !== "string" || !Array.isArray(productView.shots) || !productView.shots.every(isAcceptShot)) {
    throw new TypeError("Scheduler requires a complete Product View");
  }
}

function matchesSlot(shot, slot) {
  if (!slot.requireTags.every((tag) => shot.tags.includes(tag))) return false;
  if (slot.minDuration !== undefined && shot.duration + EPSILON < slot.minDuration) return false;
  if (slot.maxDuration !== undefined && shot.duration - EPSILON > slot.maxDuration) return false;
  if (slot.minProductVisibility !== undefined && shot.productVisibility + EPSILON < slot.minProductVisibility) return false;
  if (slot.requireProductCentered === true && shot.productCentered !== true) return false;
  if (slot.requireMotionEnergy !== undefined && shot.motionEnergy !== slot.requireMotionEnergy) return false;
  return true;
}

function rankCandidate(shot, slot) {
  const preferredTags = slot.preferTags?.reduce((count, tag) => count + (shot.tags.includes(tag) ? 1 : 0), 0) || 0;
  const targetDistance = Math.abs(shot.duration - slot.targetDuration);
  return { shot, preferredTags, targetDistance };
}

function semanticRecordMap(semanticEvidence) {
  if (semanticEvidence === undefined) return null;
  if (!semanticEvidence || typeof semanticEvidence !== "object" || !Array.isArray(semanticEvidence.records)) throw new TypeError("semanticEvidence.records is required");
  return new Map(semanticEvidence.records
    .filter((record) => record && typeof record.shotId === "string" && record.result && typeof record.result === "object")
    .map((record) => [record.shotId, record.result]));
}

const SHOT_TYPES_BY_SLOT = Object.freeze({
  hook: new Set(["front_full_body", "overall", "detail"]),
  outfit_interest: new Set(["front_full_body", "overall"]),
  front_reason: new Set(["front_full_body", "detail", "overall"]),
  sleeve_fabric_reason: new Set(["detail"]),
  back_or_best_reason: new Set(["back_full_body", "overall", "detail"]),
});

function semanticEligible(shot, semantic, slot, semanticRequired) {
  if (!semantic) return !semanticRequired;
  if (semantic.usable !== true) return false;
  const productMatch = Number(semantic.product_match);
  const clothingVisibility = Number(semantic.clothing_visibility);
  const confidence = Number(semantic.confidence);
  if (![productMatch, clothingVisibility, confidence].every(Number.isFinite)) return false;
  if (productMatch < 0.5 || clothingVisibility < 0.5 || confidence < 0.5) return false;
  const allowedTypes = SHOT_TYPES_BY_SLOT[slot.id];
  if (allowedTypes && !allowedTypes.has(semantic.shot_type)) return false;
  if (slot.id === "hook" && (!Number.isFinite(Number(semantic.hook_value)) || Number(semantic.hook_value) < 0.5)) return false;
  return true;
}

function semanticScore(semantic) {
  if (!semantic) return 0;
  const values = [semantic.product_match, semantic.clothing_visibility, semantic.visual_quality, semantic.hook_value, semantic.confidence].map(Number);
  return values.every(Number.isFinite) ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function compareCandidates(left, right) {
  if (left.preferredTags !== right.preferredTags) return right.preferredTags - left.preferredTags;
  if (Math.abs(left.semanticScore - right.semanticScore) > EPSILON) return right.semanticScore - left.semanticScore;
  if (Math.abs(left.targetDistance - right.targetDistance) > EPSILON) return left.targetDistance - right.targetDistance;
  if (left.shot.source !== right.shot.source) return left.shot.source.localeCompare(right.shot.source);
  return left.shot.id.localeCompare(right.shot.id);
}

function planIdFor(batchId, scriptTemplate, slots, contextKey = "", transitionProfile) {
  return createHash("sha256")
    .update(JSON.stringify({ batchId, templateId: scriptTemplate.id, contextKey, transitionProfile: transitionProfile || null, slots: slots.map(({ slot, shot }) => ({ slotId: slot.id, shotId: shot.id })) }))
    .digest("hex").slice(0, 32);
}

function scheduleShots({ batchId, shots, scriptTemplate, createdAt, contextKey, transitionProfile, semanticEvidence, allowPartial = false }) {
  if (transitionProfile !== undefined && !isTransitionProfile(transitionProfile)) throw new TypeError("transitionProfile is invalid");
  const semanticByShotId = semanticRecordMap(semanticEvidence);
  const semanticRequired = semanticByShotId !== null;
  const selected = [];
  const usedShotIds = new Set();
  let firstMissingSlotId = null;
  for (const slot of scriptTemplate.slots) {
    const candidates = shots
      .filter((shot) => !usedShotIds.has(shot.id) && matchesSlot(shot, slot) && semanticEligible(shot, semanticByShotId?.get(shot.id), slot, semanticRequired))
      .map((shot) => ({ ...rankCandidate(shot, slot), semanticScore: semanticScore(semanticByShotId?.get(shot.id)) }))
      .sort(compareCandidates);
    const best = candidates[0]?.shot;
    if (!best) {
      firstMissingSlotId ||= slot.id;
      if (!allowPartial || slot.id === "hook") return { status: "failed", reason: "no_matching_shot", slotId: slot.id };
      continue;
    }
    usedShotIds.add(best.id);
    selected.push({ slot, shot: best });
  }
  const plannedDuration = selected.reduce((sum, entry) => sum + Number(entry.slot.targetDuration || 0), 0);
  if (!selected.length || (firstMissingSlotId && (selected.length < MIN_PARTIAL_SLOTS || plannedDuration + EPSILON < MIN_PARTIAL_DURATION_SECONDS))) {
    return { status: "failed", reason: "no_matching_shot", slotId: firstMissingSlotId || scriptTemplate.slots[0]?.id || "unknown" };
  }
  const renderPlan = {
    id: planIdFor(batchId, scriptTemplate, selected, contextKey, transitionProfile),
    batchId,
    slots: selected,
    createdAt,
    ...(transitionProfile ? { transitionProfile } : {}),
  };
  if (!isRenderPlan(renderPlan)) throw new Error("Scheduler produced an invalid RenderPlan");
  return { status: "success", renderPlan };
}

export function scheduleShotPool({ batchId, shotPool, scriptTemplate, createdAt = new Date().toISOString(), transitionProfile, semanticEvidence }) {
  validateInputs(batchId, shotPool, scriptTemplate);
  return scheduleShots({ batchId, shots: shotPool.shots, scriptTemplate, createdAt, contextKey: "legacy-shot-pool", transitionProfile, semanticEvidence });
}

export function scheduleProductView({ batchId, productView, scriptTemplate, createdAt = new Date().toISOString(), transitionProfile, semanticEvidence, allowPartial = false }) {
  if (typeof batchId !== "string" || batchId.length === 0) throw new TypeError("batchId is required");
  validateProductView(productView);
  validateScriptTemplate(scriptTemplate);
  return scheduleShots({ batchId, shots: productView.shots, scriptTemplate, createdAt, contextKey: productView.product.id, transitionProfile, semanticEvidence, allowPartial });
}

export function partitionScheduledProducts(scheduledProducts) {
  if (!Array.isArray(scheduledProducts)) throw new TypeError("scheduledProducts must be an array");
  const renderable = [];
  const excludedProducts = [];
  for (const entry of scheduledProducts) {
    const productId = entry?.product?.id;
    if (typeof productId !== "string" || !productId) throw new TypeError("Scheduled Product requires product.id");
    if (entry?.scheduleResult?.status === "success") {
      renderable.push(entry);
      continue;
    }
    const failure = entry?.scheduleResult || {};
    excludedProducts.push({
      product_id: productId,
      reason: `schedule:${failure.slotId || failure.reason || "unknown"}`,
    });
  }
  return { renderable, excludedProducts };
}
