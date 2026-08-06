import { createHash } from "node:crypto";
import { isRenderPlan, isShot, isSlot } from "../lib/types.ts";

const EPSILON = 1e-9;

export const isNewSchedulerEnabled = (env = process.env) => env.ENABLE_NEW_SCHEDULER === "true";

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

function compareCandidates(left, right) {
  if (left.preferredTags !== right.preferredTags) return right.preferredTags - left.preferredTags;
  if (Math.abs(left.targetDistance - right.targetDistance) > EPSILON) return left.targetDistance - right.targetDistance;
  if (left.shot.source !== right.shot.source) return left.shot.source.localeCompare(right.shot.source);
  return left.shot.id.localeCompare(right.shot.id);
}

function planIdFor(batchId, scriptTemplate, slots, contextKey = "") {
  return createHash("sha256")
    .update(JSON.stringify({ batchId, templateId: scriptTemplate.id, contextKey, slots: slots.map(({ slot, shot }) => ({ slotId: slot.id, shotId: shot.id })) }))
    .digest("hex").slice(0, 32);
}

function scheduleShots({ batchId, shots, scriptTemplate, createdAt, contextKey }) {
  const selected = [];
  const usedShotIds = new Set();
  for (const slot of scriptTemplate.slots) {
    const candidates = shots
      .filter((shot) => !usedShotIds.has(shot.id) && matchesSlot(shot, slot))
      .map((shot) => rankCandidate(shot, slot))
      .sort(compareCandidates);
    const best = candidates[0]?.shot;
    if (!best) return { status: "failed", reason: "no_matching_shot", slotId: slot.id };
    usedShotIds.add(best.id);
    selected.push({ slot, shot: best });
  }
  const renderPlan = {
    id: planIdFor(batchId, scriptTemplate, selected, contextKey),
    batchId,
    slots: selected,
    createdAt,
  };
  if (!isRenderPlan(renderPlan)) throw new Error("Scheduler produced an invalid RenderPlan");
  return { status: "success", renderPlan };
}

export function scheduleShotPool({ batchId, shotPool, scriptTemplate, createdAt = new Date().toISOString() }) {
  validateInputs(batchId, shotPool, scriptTemplate);
  return scheduleShots({ batchId, shots: shotPool.shots, scriptTemplate, createdAt, contextKey: "legacy-shot-pool" });
}

export function scheduleProductView({ batchId, productView, scriptTemplate, createdAt = new Date().toISOString() }) {
  if (typeof batchId !== "string" || batchId.length === 0) throw new TypeError("batchId is required");
  validateProductView(productView);
  validateScriptTemplate(scriptTemplate);
  return scheduleShots({ batchId, shots: productView.shots, scriptTemplate, createdAt, contextKey: productView.product.id });
}
