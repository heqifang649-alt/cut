import { createHash } from "node:crypto";
import { isRenderPlan } from "../lib/types.ts";
import { SCHEDULER_V2, LEVELS, eligibleShots, creativePreferences, pairConflict } from "../lib/scheduler-policy-v2.mjs";

// Shadow entry only: not imported by the production worker or legacy scheduler.
export function scheduleProductViewV2({ batchId, productView, semanticEvidence, targetDuration = 10, durationCap = 13, createdAt = "1970-01-01T00:00:00.000Z", distinctPairs = [], frameHashesByShot = {} }) {
  if (!batchId || !productView?.product?.id || !Array.isArray(productView.shots)) throw new TypeError("Product View required");
  if (![targetDuration, durationCap].every((n) => Number.isFinite(n) && n > 0)) throw new TypeError("Positive duration target/cap required");
  const admission = eligibleShots({ batchId, productView, semanticEvidence });
  const base = { policyVersion: SCHEDULER_V2, shadowOnly: true, admission, attemptedLevels: [] };
  if (admission.incomplete.length) return { ...base, status: "failed", reason: "ANALYSIS_INCOMPLETE" };
  const candidates = admission.eligible.map((entry) => ({ ...entry, ...creativePreferences(entry) }));
  const conflicts = [];
  for (let i = 0; i < candidates.length; i++) for (let j = i + 1; j < candidates.length; j++) {
    const reason = pairConflict(candidates[i].shot, candidates[j].shot, distinctPairs, frameHashesByShot);
    if (reason) conflicts.push({ shotIds: [candidates[i].shot.id, candidates[j].shot.id], reason });
  }
  const conflictSet = new Set(conflicts.map((c) => [...c.shotIds].sort().join("|")));
  for (const [level, roles] of Object.entries(LEVELS)) {
    base.attemptedLevels.push(level);
    let best = null;
    const desiredDuration = Math.min(targetDuration, durationCap);
    // Exhaustive combination-level assignment, with safe score upper-bound pruning.
    // No candidate truncation: a scarce candidate cannot disappear in a top-K list.
    const ranked = roles.map((role) => [...candidates].sort((a, b) => b.scores[role] - a.scores[role] || a.shot.id.localeCompare(b.shot.id)));
    const upper = roles.map((_, index) => roles.slice(index).reduce((sum, role, offset) => sum + (ranked[index + offset][0]?.scores[role] || 0), 0));
    function search(selected, score, duration) {
      const index = selected.length;
      if (index === roles.length) {
        // Existing minimum useful cut (4s), now measured from actual edit intervals.
        duration = Math.min(duration, desiredDuration);
        if (duration + 1e-9 < 4) return;
        const key = selected.map((c) => c.shot.id).join("|");
        if (!best || score > best.score + 1e-9 || (Math.abs(score - best.score) <= 1e-9 && (duration > best.duration + 1e-9 || (Math.abs(duration - best.duration) <= 1e-9 && key < best.key)))) best = { selected: [...selected], score, duration, key };
        return;
      }
      if (best && score + upper[index] < best.score - 1e-9) return;
      for (const c of ranked[index]) {
        if (selected.some((s) => s.shot.id === c.shot.id || conflictSet.has([s.shot.id, c.shot.id].sort().join("|")))) continue;
        const available = Math.min(c.shot.duration, c.shot.end - c.shot.start);
        if (available <= 0) continue;
        search([...selected, c], score + c.scores[roles[index]], duration + available);
      }
    }
    search([], 0, 0);
    if (!best) continue;
    const available = best.selected.map((c) => Math.min(c.shot.duration, c.shot.end - c.shot.start));
    // Water-fill unused time from short shots into other available intervals.
    let remaining = best.duration;
    const durations = new Array(available.length).fill(0);
    for (const i of available.map((_, i) => i).sort((a, b) => available[a] - available[b] || a - b)) {
      const count = durations.filter((d) => d === 0).length;
      durations[i] = Math.min(available[i], remaining / count);
      remaining -= durations[i];
    }
    const slots = best.selected.map((c, i) => ({ slot: { id: roles[i], label: roles[i] === "opening" && level === "C" ? "Strong Opening" : roles[i], requireTags: [], targetDuration: durations[i] }, shot: c.shot }));
    const id = createHash("sha256").update(JSON.stringify({ policy: SCHEDULER_V2, batchId, productId: productView.product.id, level, slots })).digest("hex").slice(0, 32);
    const renderPlan = { id, batchId, slots, createdAt };
    if (!isRenderPlan(renderPlan)) throw new Error("Invalid V2 RenderPlan");
    return { ...base, status: "success", level, renderPlan, actualCutDuration: best.duration, shotCount: slots.length,
      skippedRoles: LEVELS.A.filter((r) => !roles.includes(r)),
      substitutedRoles: best.selected.flatMap((c, i) => c.roles.includes(roles[i]) ? [] : [{ role: roles[i], shotId: c.shot.id, shotType: c.semantic.shot_type }]),
      selections: slots.map(({ shot, slot }, i) => ({ shotId: shot.id, source: shot.path, sourceName: best.selected[i].sourceName, start: shot.start, end: shot.start + slot.targetDuration, roles: best.selected[i].roles, assignedRole: slot.id })),
      duplicateOverlap: { selectedConflicts: [], preventedConflicts: conflicts, exactFrameHashShots: Object.keys(frameHashesByShot).length, crossSourceVisualDuplicates: "exact_sampled_frame_bytes_checked_where_available; perceptual_near_duplicates_not_assessed" },
      cta: { placement: "last_suitable_shot", shotId: slots.at(-1).shot.id },
    };
  }
  return { ...base, status: "failed", reason: admission.blocked.length ? "QUALITY_BLOCKED" : "INSUFFICIENT_MATERIAL", duplicateOverlap: { preventedConflicts: conflicts }, actualCutDuration: 0, shotCount: 0 };
}
