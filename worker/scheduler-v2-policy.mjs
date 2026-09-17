import { isRenderPlan, isTransitionProfile } from "../lib/types.ts";
import { eligibleShots, creativePreferences, pairConflict, sourceKey } from "../lib/scheduler-policy-v2.mjs";
import { digest, validatedDistinctPairs } from "../lib/scheduler-v2-visual-evidence.mjs";

export const SCHEDULER_V2_POLICY = "scheduler-v2.0-mva5";
export const MINIMUM_AD_SECONDS = 5;
const STRUCTURES = { A: ["opening", "product", "detail", "variation", "end"], B: ["opening", "product", "variation", "end"] };
const durationOf = ({ shot }) => Math.min(shot.duration, shot.end - shot.start);
const normalized = (s) => String(s).replaceAll("/", "\\").toLowerCase();

export function scheduleV2Policy({ batchId, productView, semanticEvidence, targetDuration = 10, durationCap = 13, createdAt = "1970-01-01T00:00:00.000Z", transitionProfile, visualReview, frameHashesByShot = {}, upstreamImport }) {
  if (!batchId || !productView?.product?.id || !Array.isArray(productView.shots)) throw new TypeError("Product View required");
  if (![targetDuration, durationCap].every((n) => Number.isFinite(n) && n > 0)) throw new TypeError("Positive target/cap required");
  if (transitionProfile !== undefined && !isTransitionProfile(transitionProfile)) throw new TypeError("Invalid transition profile");
  const admission = eligibleShots({ batchId, productView, semanticEvidence });
  const base = { policyVersion: SCHEDULER_V2_POLICY, admission, attemptedLevels: [] };
  const upstreamBlocks = upstreamImport?.batchId === batchId ? (upstreamImport.records || []).filter((r) => productView.product.files.some((f) => normalized(r.videoPath).endsWith(`\\${normalized(f)}`)) && ["reject", "review", "skipped"].includes(r.status)) : [];
  if (!productView.shots.length && upstreamBlocks.length) return { ...base, status: "failed", reason: "UPSTREAM_BLOCKED", upstreamBlocks };
  if (admission.incomplete.length) return { ...base, status: "failed", reason: "ANALYSIS_INCOMPLETE" };
  if (!admission.eligible.length) return { ...base, status: "failed", reason: upstreamBlocks.length ? "UPSTREAM_BLOCKED" : admission.blocked.length ? "QUALITY_BLOCKED" : "ANALYSIS_INCOMPLETE", detail: "no_eligible_shots; upstream_admission_evidence_required", upstreamBlocks };
  const candidates = admission.eligible.map((e) => ({ ...e, ...creativePreferences(e) }));
  const distinctPairs = validatedDistinctPairs({ batchId, productId: productView.product.id, eligible: admission.eligible, frameHashesByShot, visualReview });
  const conflicts = [];
  for (let i = 0; i < candidates.length; i++) for (let j = i + 1; j < candidates.length; j++) {
    const reason = pairConflict(candidates[i].shot, candidates[j].shot, distinctPairs, frameHashesByShot);
    if (reason) conflicts.push({ shotIds: [candidates[i].shot.id, candidates[j].shot.id], reason });
  }
  const keys = new Set(conflicts.map((p) => [...p.shotIds].sort().join("|")));
  const compatible = (selected, c) => selected.every((s) => s.shot.id !== c.shot.id && !keys.has([s.shot.id, c.shot.id].sort().join("|")));
  // target is a preference, not a ceiling below the minimum viable duration.
  const desired = Math.min(durationCap, Math.max(MINIMUM_AD_SECONDS, targetDuration));
  const actualDuration = (selected) => Math.min(desired, selected.reduce((sum, c) => sum + durationOf(c), 0));
  const hasProduct = (selected) => selected.some((c) => c.semantic.clothing_visibility >= 0.5 && c.semantic.product_match >= 0.5);
  // Proof of infeasibility for every structure; avoid exponential searches when
  // even the optimistic total or hard cap cannot reach the five-second minimum.
  if (Math.min(desired, candidates.reduce((sum, c) => sum + Math.max(0, durationOf(c)), 0)) + 1e-9 < MINIMUM_AD_SECONDS) {
    return { ...base, attemptedLevels: ["A", "B", "MVA"], status: "failed", reason: admission.blocked.length ? "QUALITY_BLOCKED" : "INSUFFICIENT_MATERIAL", detail: "actual_duration_upper_bound_below_5_seconds", actualCutDuration: 0, shotCount: 0, duplicateOverlap: { preventedConflicts: conflicts } };
  }
  function finish(level, roles, selected) {
    let remaining = actualDuration(selected);
    const duration = remaining, amounts = new Array(selected.length).fill(0);
    for (const i of selected.map((_, i) => i).sort((a, b) => durationOf(selected[a]) - durationOf(selected[b]) || a - b)) {
      amounts[i] = Math.min(durationOf(selected[i]), remaining / amounts.filter((n) => n === 0).length);
      remaining -= amounts[i];
    }
    const slots = selected.map((c, i) => ({ slot: { id: roles[i], label: roles[i], requireTags: [], targetDuration: amounts[i] }, shot: c.shot }));
    const id = digest(JSON.stringify({ policy: SCHEDULER_V2_POLICY, batchId, productId: productView.product.id, slots, transitionProfile: transitionProfile || null })).slice(0, 32);
    const renderPlan = { id, batchId, slots, createdAt, ...(transitionProfile ? { transitionProfile } : {}) };
    if (!isRenderPlan(renderPlan)) throw new Error("Invalid V2 policy RenderPlan");
    const sameSourceReuse = [];
    for (let i = 0; i < selected.length; i++) for (let j = i + 1; j < selected.length; j++) if (sourceKey(selected[i].shot) === sourceKey(selected[j].shot)) {
      const pair = distinctPairs.find((p) => p.shotIds.includes(selected[i].shot.id) && p.shotIds.includes(selected[j].shot.id));
      if (!pair) throw new Error("Missing visual difference evidence");
      sameSourceReuse.push({ shotIds: pair.shotIds, evidenceRef: pair.evidenceRef, source: selected[i].shot.path, intervals: [i, j].map((n) => [selected[n].shot.start, selected[n].shot.start + amounts[n]]) });
    }
    return { ...base, status: "success", level, actualCutDuration: duration, shotCount: slots.length, renderPlan,
      skippedRoles: STRUCTURES.A.filter((r) => !roles.includes(r)),
      substitutedRoles: selected.flatMap((c, i) => c.roles.includes(roles[i].startsWith("product_") ? "product" : roles[i]) ? [] : [{ role: roles[i], shotId: c.shot.id }]),
      sameSourceReuse, duplicateOverlap: { selectedConflicts: [], preventedConflicts: conflicts, validatedDistinctPairs: distinctPairs.length, nearDuplicateCoverage: "existing_review_and_exact_frame_hashes_only" },
      selections: selected.map((c, i) => ({ shotId: c.shot.id, source: c.shot.path, start: c.shot.start, end: c.shot.start + amounts[i], assignedRole: roles[i], roles: c.roles })),
      cta: { placement: "final_shot_overlay_or_audio", shotId: selected.at(-1).shot.id, dedicatedShotRequired: false },
    };
  }
  for (const [level, roles] of Object.entries(STRUCTURES)) {
    base.attemptedLevels.push(level);
    let best = null;
    const ranked = roles.map((role) => [...candidates].sort((a, b) => b.scores[role] - a.scores[role] || a.shot.id.localeCompare(b.shot.id)));
    const upper = roles.map((_, i) => roles.slice(i).reduce((sum, role, offset) => sum + (ranked[i + offset][0]?.scores[role] || 0), 0));
    function visit(selected, score) {
      const i = selected.length;
      if (i === roles.length) {
        if (actualDuration(selected) + 1e-9 < MINIMUM_AD_SECONDS || !hasProduct(selected)) return;
        const key = selected.map((c) => c.shot.id).join("|");
        if (!best || score > best.score + 1e-9 || (Math.abs(score - best.score) <= 1e-9 && key < best.key)) best = { selected, score, key };
        return;
      }
      if (best && score + upper[i] < best.score - 1e-9) return;
      for (const c of ranked[i]) if (durationOf(c) > 0 && compatible(selected, c)) visit([...selected, c], score + c.scores[roles[i]]);
    }
    visit([], 0);
    if (best) return finish(level, roles, best.selected);
  }
  base.attemptedLevels.push("MVA");
  // Whole subsets, not greedy slots. >=2 intervals; short shots may need 3+.
  for (let n = 2; n <= candidates.length; n++) {
    let best = null;
    function visit(selected, start) {
      if (selected.length === n) {
        if (actualDuration(selected) + 1e-9 < MINIMUM_AD_SECONDS || !hasProduct(selected)) return;
        const ordered = [...selected].sort((a, b) => b.scores.opening - a.scores.opening || a.shot.id.localeCompare(b.shot.id));
        const score = ordered[0].scores.opening + ordered.reduce((sum, c) => sum + c.scores.product, 0);
        const key = ordered.map((c) => c.shot.id).join("|");
        if (!best || score > best.score + 1e-9 || (Math.abs(score - best.score) <= 1e-9 && key < best.key)) best = { selected: ordered, score, key };
        return;
      }
      for (let i = start; i <= candidates.length - (n - selected.length); i++) if (durationOf(candidates[i]) > 0 && compatible(selected, candidates[i])) visit([...selected, candidates[i]], i + 1);
    }
    visit([], 0);
    if (best) return finish("MVA", best.selected.map((_, i) => i === 0 ? "product" : `product_${i + 1}`), best.selected);
  }
  return { ...base, status: "failed", reason: admission.blocked.length ? "QUALITY_BLOCKED" : "INSUFFICIENT_MATERIAL", actualCutDuration: 0, shotCount: 0, duplicateOverlap: { preventedConflicts: conflicts } };
}
