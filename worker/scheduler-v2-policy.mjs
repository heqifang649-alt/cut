import { isRenderPlan, isTransitionProfile } from "../lib/types.ts";
import { eligibleShots, creativePreferences, pairConflict, sourceKey } from "../lib/scheduler-policy-v2.mjs";
import { digest, validatedDistinctPairs } from "../lib/scheduler-v2-visual-evidence.mjs";
import { renderPlanShortShotQuality } from "../lib/short-shot-quality.mjs";

export const SCHEDULER_V2_POLICY = "scheduler-v2.1-safe8";
export const MINIMUM_AD_SECONDS = 8;
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
  if (!admission.eligible.length) return { ...base, status: "failed", reason: upstreamBlocks.length ? "UPSTREAM_BLOCKED" : admission.blocked.length ? "QUALITY_BLOCKED" : "ANALYSIS_INCOMPLETE", detail: "no_eligible_shots; upstream_admission_evidence_required", upstreamBlocks };
  const candidates = admission.eligible.filter((e) => durationOf(e) > 0).map((e) => ({ ...e, ...creativePreferences(e) }));
  const candidateSourceCount = new Set(candidates.map((c) => sourceKey(c.shot))).size;
  const distinctPairs = validatedDistinctPairs({ batchId, productId: productView.product.id, eligible: admission.eligible, frameHashesByShot, visualReview });
  const conflicts = [];
  for (let i = 0; i < candidates.length; i++) for (let j = i + 1; j < candidates.length; j++) {
    const left = candidates[i].shot, right = candidates[j].shot;
    const pairReason = pairConflict(left, right, distinctPairs, frameHashesByShot);
    const chronologicalContinuation = candidateSourceCount === 1 && sourceKey(left) === sourceKey(right)
      && Math.min(left.end, right.end) - Math.max(left.start, right.start) <= 1e-9
      && pairReason === "same_source_visual_difference_unverified";
    const reason = chronologicalContinuation ? null : pairReason;
    if (reason) conflicts.push({ shotIds: [candidates[i].shot.id, candidates[j].shot.id], reason });
  }
  const keys = new Set(conflicts.map((p) => [...p.shotIds].sort().join("|")));
  const compatible = (selected, c) => selected.every((s) => s.shot.id !== c.shot.id && !keys.has([s.shot.id, c.shot.id].sort().join("|")));
  // target is a preference, not a ceiling below the minimum viable duration.
  const desired = Math.min(durationCap, Math.max(MINIMUM_AD_SECONDS, targetDuration));
  const safeSourceCount = candidateSourceCount;
  Object.assign(base, { mode: safeSourceCount === 1 ? "single" : "multi", safeSourceCount, minimumSafeDuration: MINIMUM_AD_SECONDS });
  const actualDuration = (selected) => Math.min(desired, selected.reduce((sum, c) => sum + durationOf(c), 0));
  function finish(level, roles, selected) {
    let remaining = actualDuration(selected);
    const duration = remaining, amounts = new Array(selected.length).fill(0);
    for (let i = 0; i < selected.length; i++) {
      amounts[i] = Math.min(durationOf(selected[i]), remaining);
      remaining = Math.max(0, Number((remaining - amounts[i]).toFixed(6)));
    }
    const slots = selected.map((c, i) => ({ slot: { id: roles[i], label: roles[i], requireTags: [], targetDuration: amounts[i] }, shot: c.shot }));
    const id = digest(JSON.stringify({ policy: SCHEDULER_V2_POLICY, batchId, productId: productView.product.id, slots, transitionProfile: transitionProfile || null })).slice(0, 32);
    const renderPlan = { id, batchId, slots, createdAt, ...renderPlanShortShotQuality(slots), minimumSafeDuration: MINIMUM_AD_SECONDS, transitionProfile: "hard_cut" };
    if (!isRenderPlan(renderPlan)) throw new Error("Invalid V2 policy RenderPlan");
    const sameSourceReuse = [];
    for (let i = 0; i < selected.length; i++) for (let j = i + 1; j < selected.length; j++) if (sourceKey(selected[i].shot) === sourceKey(selected[j].shot)) {
      const chronological = base.mode === "single"
        && Math.min(selected[i].shot.end, selected[j].shot.end) - Math.max(selected[i].shot.start, selected[j].shot.start) <= 1e-9
        && pairConflict(selected[i].shot, selected[j].shot, distinctPairs, frameHashesByShot) === "same_source_visual_difference_unverified";
      if (chronological) continue;
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
  // Deterministic bounded fallback; roles never make a safe schedule infeasible.
  const ranked = [...candidates].filter(c => durationOf(c) > 0).sort((a,b) => durationOf(b)-durationOf(a) || b.scores.product-a.scores.product || a.shot.id.localeCompare(b.shot.id));
  let best = [];
  const total = selected => selected.reduce((sum,c) => sum + durationOf(c),0);
  for (const seed of ranked) {
    const selected = [seed];
    for (const c of ranked) if (compatible(selected,c)) selected.push(c);
    if (total(selected) > total(best)) best = selected;
  }
  const available = total(best);
  if (Math.min(durationCap, available) < MINIMUM_AD_SECONDS - 1e-9) return {
    ...base, status: "failed", reason: "INSUFFICIENT_SAFE_DURATION", actualCutDuration: 0,
    availableSafeDuration: available, durationShortfall: Math.max(0, MINIMUM_AD_SECONDS - Math.min(durationCap, available)),
    retryable: false, shotCount: 0, duplicateOverlap: { preventedConflicts: conflicts },
  };
  const hooks = best.filter(c => c.semantic.hook_value >= 0.5);
  const opening = [...(hooks.length ? hooks : best)].sort((a,b) =>
    (hooks.length ? b.scores.opening-a.scores.opening : b.scores.product-a.scores.product) || a.shot.id.localeCompare(b.shot.id))[0];
  const ordered = [opening];
  const remainingCandidates = best.filter(c => c !== opening);
  while (remainingCandidates.length) {
    const seenTypes = new Set(ordered.map(c => c.semantic.shot_type));
    const preference = c => c.scores.product + (seenTypes.has(c.semantic.shot_type) ? 0 : 0.5);
    remainingCandidates.sort((a,b) => preference(b)-preference(a) || a.shot.id.localeCompare(b.shot.id));
    ordered.push(remainingCandidates.shift());
  }
  if (base.mode === "single") ordered.sort((a,b) => a.shot.start-b.shot.start || a.shot.id.localeCompare(b.shot.id));
  const selected = [];
  for (const c of ordered) { selected.push(c); if (total(selected) >= (base.mode === "single" ? desired : MINIMUM_AD_SECONDS)) break; }
  const chronologicalSingleSource = base.mode === "single"
    && selected.every((candidate, index) => index === 0
      || candidate.shot.start >= selected[index - 1].shot.end - 1e-9);
  const hashedSingleSource = base.mode === "single" && selected.every((candidate) => frameHashesByShot[candidate.shot.id]?.length === 3);
  const unverifiedReuse = selected.some((left, i) => selected.slice(i + 1).some((right) => {
    if (sourceKey(left.shot) !== sourceKey(right.shot) || chronologicalSingleSource || hashedSingleSource) return false;
    const contiguous = Math.abs(left.shot.end - right.shot.start) <= 1e-3
      || Math.abs(right.shot.end - left.shot.start) <= 1e-3;
    return !contiguous && !distinctPairs.some((pair) => pair.shotIds.includes(left.shot.id) && pair.shotIds.includes(right.shot.id));
  }));
  if (unverifiedReuse) return {
    ...base, status: "failed", reason: "INSUFFICIENT_SAFE_DURATION", actualCutDuration: 0,
    availableSafeDuration: Math.max(...selected.map((candidate) => durationOf(candidate))),
    durationShortfall: Math.max(0, MINIMUM_AD_SECONDS - Math.max(...selected.map((candidate) => durationOf(candidate)))),
    retryable: false, shotCount: 0, duplicateOverlap: { preventedConflicts: conflicts },
  };
  base.attemptedLevels.push(base.mode);
  return { ...finish(base.mode, selected.map((_,i) => i === 0 && hooks.length ? "opening" : i <= 1 ? "product" : "variation"), selected),
    availableSafeDuration: available, durationShortfall: 0, openingFallback: !hooks.length,
    degradation: admission.blocked.length || admission.incomplete.length ? "partial_safe_sources" : null };
}
