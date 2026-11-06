export const SHORT_SHOT_POLICY = Object.freeze({ normal: 1, brief: 0.6, residual: 0.3 });
export const SHORT_SHOT_THRESHOLD_SECONDS = SHORT_SHOT_POLICY.normal;

const durationOf = ({ slot, shot }) => {
  const sourceInterval = Math.max(0, Number(shot.end) - Number(shot.start));
  return Math.min(sourceInterval, Number(slot.targetDuration) > 0 ? Number(slot.targetDuration) : sourceInterval);
};

export const shortShotTier = (seconds, policy = SHORT_SHOT_POLICY) => seconds >= policy.normal ? 0 : seconds >= policy.brief ? 1 : seconds >= policy.residual ? 2 : 3;
const protectedRole = (slot) => /hook|opening|product|outfit|front|back|display|hero/i.test(`${slot.id} ${slot.label || ""}`);

export function shortShotPenalty(shot, slot, policy = SHORT_SHOT_POLICY) {
  const duration = durationOf({ slot, shot });
  const tier = shortShotTier(duration, policy);
  const minimumDeficit = Math.max(0, Number(slot.minDuration || 0) - duration);
  if (tier === 0) return minimumDeficit * (protectedRole(slot) ? 4 : 2);
  const weight = protectedRole(slot) ? 2 : 1;
  return [0, 30, 80, 160][tier] * weight + minimumDeficit * (protectedRole(slot) ? 4 : 2);
}

export function renderPlanShortShotQuality(slots, { beatCompressionCreatedShortShot = false, shortShotPolicy = SHORT_SHOT_POLICY } = {}) {
  const durations = slots.map(durationOf);
  let consecutive = 0, longestConsecutive = 0;
  for (const duration of durations) {
    if (duration < shortShotPolicy.normal) {
      consecutive += 1;
      longestConsecutive = Math.max(longestConsecutive, consecutive);
    } else consecutive = 0;
  }
  const shortShotCount = durations.filter((duration) => duration < shortShotPolicy.normal).length;
  return {
    shortShotCount,
    consecutiveShortShots: longestConsecutive,
    shortestShotDuration: Number((durations.length ? Math.min(...durations) : 0).toFixed(6)),
    beatCompressionCreatedShortShot,
    // Two consecutive very short shots, or three consecutive short shots,
    // are the only automatic short-shot conditions that merit human review.
    shortShotReviewWarning: hasSevereShortShotRun(slots, shortShotPolicy),
  };
}

export function hasSevereShortShotRun(slots, policy = SHORT_SHOT_POLICY) {
  let subHalf = 0, subEight = 0;
  for (const entry of slots) {
    const duration = durationOf(entry);
    subHalf = duration < policy.brief ? subHalf + 1 : 0;
    subEight = duration < policy.normal ? subEight + 1 : 0;
    if (subHalf >= 2 || subEight >= 3) return true;
  }
  return false;
}

// Redistribute a crop-created short tail within admitted source bounds only.
// Keep order, roles, total duration and source intervals distinct.
export function repairShortShotSlots(slots, policy = SHORT_SHOT_POLICY) {
  const result = slots.map(entry => ({ ...entry, slot: { ...entry.slot, targetDuration: durationOf(entry) } }));
  for (let i = 1; i < result.length; i++) {
    const current = result[i], previous = result[i - 1];
    const amount = current.slot.targetDuration;
    const available = current.shot.end - current.shot.start;
    if (amount <= 0 || amount >= policy.normal || available <= amount
      || current.shot.tags?.includes("creative:quick_cut")) continue;
    // Let the renderer merge a continuous source without introducing a gap.
    if (previous.shot.path === current.shot.path
      && Math.abs(previous.shot.start + previous.slot.targetDuration - current.shot.start) <= 1e-3) continue;
    const transfer = Math.min(policy.normal - amount, available - amount,
      Math.max(0, previous.slot.targetDuration - policy.normal));
    if (transfer <= 0) continue;
    const end = current.shot.start + amount + transfer;
    const overlaps = result.some((entry, index) => index !== i && entry.shot.path === current.shot.path
      && Math.min(end, entry.shot.start + entry.slot.targetDuration - (index === i - 1 ? transfer : 0))
        > Math.max(current.shot.start, entry.shot.start) + 1e-9);
    if (overlaps) continue;
    previous.slot.targetDuration -= transfer;
    current.slot.targetDuration += transfer;
  }
  return result;
}

export function inspectShortShotTimeline(segments, policy = SHORT_SHOT_POLICY) {
  return segments.flatMap((segment, index) => {
    const { duration, source_in: start, source_out: end } = segment;
    if (![duration, start, end].every(Number.isFinite) || start < 0 || duration <= 0 || end <= start
      || Math.abs(end - start - duration) > 1e-3) return [{ index, severity: "REJECT", reason: "invalid_source_interval" }];
    if (duration >= policy.normal) return [];
    return [{ index, severity: "WARNING", reason: segment.content_tags?.includes("creative:quick_cut")
      ? "intentional_quick_cut" : duration < policy.residual ? "extreme_short_requires_visual_review" : "short_usable_shot", duration }];
  });
}
