import { createHash } from "node:crypto";
import { isRenderPlan, isShot, isSlot } from "../lib/types.ts";

const EPSILON = 1e-9;

export const isNewSchedulerEnabled = (env = process.env) => env.ENABLE_NEW_SCHEDULER === "true";

function validateInputs(batchId, shotPool, scriptTemplate) {
  if (typeof batchId !== "string" || batchId.length === 0) throw new TypeError("batchId is required");
  if (!shotPool || !Array.isArray(shotPool.shots) || !shotPool.shots.every((shot) => isShot(shot) && shot.reject === false && shot.rejectReason === undefined)) {
    throw new TypeError("Scheduler 只接受完整的 Quality Gate accept ShotPool");
  }
  if (!scriptTemplate || typeof scriptTemplate !== "object" || typeof scriptTemplate.id !== "string" || typeof scriptTemplate.name !== "string" || !Array.isArray(scriptTemplate.slots) || !scriptTemplate.slots.every(isSlot) || !Number.isFinite(scriptTemplate.totalDuration)) {
    throw new TypeError("ScriptTemplate 结构无效");
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

function planIdFor(batchId, scriptTemplate, slots) {
  return createHash("sha256")
    .update(JSON.stringify({ batchId, templateId: scriptTemplate.id, slots: slots.map(({ slot, shot }) => ({ slotId: slot.id, shotId: shot.id })) }))
    .digest("hex").slice(0, 32);
}

export function scheduleShotPool({ batchId, shotPool, scriptTemplate, createdAt = new Date().toISOString() }) {
  validateInputs(batchId, shotPool, scriptTemplate);
  const selected = [];
  const usedShotIds = new Set();
  for (const slot of scriptTemplate.slots) {
    const candidates = shotPool.shots
      .filter((shot) => !usedShotIds.has(shot.id) && matchesSlot(shot, slot))
      .map((shot) => rankCandidate(shot, slot))
      .sort(compareCandidates);
    const best = candidates[0]?.shot;
    if (!best) return { status: "failed", reason: "no_matching_shot", slotId: slot.id };
    usedShotIds.add(best.id);
    selected.push({ slot, shot: best });
  }
  const renderPlan = {
    id: planIdFor(batchId, scriptTemplate, selected),
    batchId,
    slots: selected,
    createdAt,
  };
  if (!isRenderPlan(renderPlan)) throw new Error("Scheduler 生成了无效 RenderPlan");
  return { status: "success", renderPlan };
}
