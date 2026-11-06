import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const MINIMUM_OUTPUT_SECONDS = 8;
export const MAXIMUM_OUTPUT_SECONDS = 18;

export function assertOutputDuration(duration, minimum = MINIMUM_OUTPUT_SECONDS) {
  if (!Number.isFinite(duration) || duration < Math.max(minimum, MINIMUM_OUTPUT_SECONDS)) {
    const availableSafeDuration = Number.isFinite(duration) ? duration : 0;
    throw Object.assign(new Error("INSUFFICIENT_SAFE_DURATION"), {
      code: "INSUFFICIENT_SAFE_DURATION", retryable: false, availableSafeDuration,
      durationShortfall: Math.max(0, minimum - availableSafeDuration), minimumSafeDuration: minimum,
    });
  }
  if (duration > MAXIMUM_OUTPUT_SECONDS) throw Object.assign(new Error("OUTPUT_DURATION_EXCEEDED"), {
    code: "OUTPUT_DURATION_EXCEEDED", retryable: false, actualDuration: duration,
    maximumOutputDuration: MAXIMUM_OUTPUT_SECONDS,
  });
  return duration;
}

// Crop selected safe intervals in their existing order. Never extend a shot,
// repeat media, or change speed to meet the delivery duration contract.
export function capRenderPlanDuration(plan) {
  const amount = ({shot, slot}) => Math.min(Number(shot.duration ?? shot.end-shot.start), Number(shot.end)-Number(shot.start), Number(slot.targetDuration));
  const amounts = plan.slots.map(amount);
  if (amounts.some(n => !Number.isFinite(n) || n <= 0)) throw Object.assign(new Error('RENDER_PLAN_DURATION_INVALID'), {code:'RENDER_PLAN_DURATION_INVALID',retryable:false});
  const before = amounts.reduce((sum,n)=>sum+n,0);
  if (before <= MAXIMUM_OUTPUT_SECONDS) return plan;
  let remaining = MAXIMUM_OUTPUT_SECONDS;
  const slots=[];
  for (const [i,entry] of plan.slots.entries()) {
    const duration=Number(Math.min(amounts[i],remaining).toFixed(6));
    if (duration < 1/30) break;
    slots.push({...entry,slot:{...entry.slot,targetDuration:duration}});
    remaining=Number((remaining-duration).toFixed(6));
    if (remaining <= 0) break;
  }
  return {...plan,id:plan.id+'-max18',slots};
}

async function capture(executable, args) {
  const { stdout } = await promisify(execFile)(executable, args, { windowsHide: true, timeout: 30000 });
  return stdout;
}

export async function verifyEncodedSafeDuration(ffprobe, file, minimum = MINIMUM_OUTPUT_SECONDS, captureOutput = capture) {
  let duration, containerDuration;
  try {
    const raw = await captureOutput(ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=duration:format=duration", "-of", "json", file]);
    const parsed=JSON.parse(raw.toString("utf8"));
    const value = parsed.streams?.[0]?.duration;
    if (!["string", "number"].includes(typeof value) || String(value).trim() === "") throw new Error("Missing video duration");
    duration = Number(value);
    if (!Number.isFinite(duration) || duration <= 0) throw new Error("Invalid video duration");
    if (parsed.format?.duration !== undefined) {
      containerDuration=Number(parsed.format.duration);
      if (!Number.isFinite(containerDuration) || containerDuration <= 0) throw new Error('Invalid container duration');
    }
  } catch {
    throw Object.assign(new Error("OUTPUT_VERIFY_UNAVAILABLE"), { code: "OUTPUT_VERIFY_UNAVAILABLE", retryable: false });
  }
  assertOutputDuration(duration, minimum);
  if (containerDuration !== undefined) assertOutputDuration(containerDuration, minimum);
  return duration;
}
