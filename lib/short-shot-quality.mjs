export const SHORT_SHOT_THRESHOLD_SECONDS = 0.8;

const durationOf = ({ slot, shot }) => {
  const sourceInterval = Math.max(0, Number(shot.end) - Number(shot.start));
  return Math.min(sourceInterval, Number(slot.targetDuration) > 0 ? Number(slot.targetDuration) : sourceInterval);
};

const tierOf = (seconds) => seconds >= 0.8 ? 0 : seconds >= 0.5 ? 1 : seconds >= 0.3 ? 2 : 3;
const protectedRole = (slot) => /hook|opening|product|outfit|front|back|display|hero/i.test(`${slot.id} ${slot.label || ""}`);

export function shortShotPenalty(shot, slot) {
  const duration = durationOf({ slot, shot });
  const tier = tierOf(duration);
  const minimumDeficit = Math.max(0, Number(slot.minDuration || 0) - duration);
  if (tier === 0) return minimumDeficit * (protectedRole(slot) ? 4 : 2);
  const weight = protectedRole(slot) ? 2 : 1;
  return [0, 30, 80, 160][tier] * weight + minimumDeficit * (protectedRole(slot) ? 4 : 2);
}

export function renderPlanShortShotQuality(slots, { beatCompressionCreatedShortShot = false } = {}) {
  const durations = slots.map(durationOf);
  let consecutive = 0, longestConsecutive = 0;
  for (const duration of durations) {
    if (duration < SHORT_SHOT_THRESHOLD_SECONDS) {
      consecutive += 1;
      longestConsecutive = Math.max(longestConsecutive, consecutive);
    } else consecutive = 0;
  }
  const shortShotCount = durations.filter((duration) => duration < SHORT_SHOT_THRESHOLD_SECONDS).length;
  return {
    shortShotCount,
    consecutiveShortShots: longestConsecutive,
    shortestShotDuration: Number((durations.length ? Math.min(...durations) : 0).toFixed(6)),
    beatCompressionCreatedShortShot,
    // Two consecutive sub-0.5s shots, or three consecutive sub-0.8s shots,
    // are the only automatic short-shot conditions that merit human review.
    shortShotReviewWarning: hasSevereShortShotRun(slots),
  };
}

export function hasSevereShortShotRun(slots) {
  let subHalf = 0, subEight = 0;
  for (const entry of slots) {
    const duration = durationOf(entry);
    subHalf = duration < 0.5 ? subHalf + 1 : 0;
    subEight = duration < SHORT_SHOT_THRESHOLD_SECONDS ? subEight + 1 : 0;
    if (subHalf >= 2 || subEight >= 3) return true;
  }
  return false;
}
